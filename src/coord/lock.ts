// 瞬时协调者锁（stage-2 T2.2 / F29；Round-2 B1 完整重构）。
//
// 设计（owner / heartbeat 分离，消除 TOCTOU）：
//  - owner 文件（coordinator.lock）：O_EXCL 创建后**永不改写**；内容含 pid/bootId/token/
//    acquiredAt。文件本身 = 所有权凭证，inode + token 共同标识一次持有。
//  - heartbeat 文件（coordinator.lock.hb-<token>）：原子 tmp+rename 续期；按 token 分文件，
//    新主的心跳永远不可能被旧主的 renew 覆盖。
//  - observe：读 owner + 对应 token 的心跳；心跳缺失 → 回退 owner.heartbeatAt/ mtime。
//  - renew：open+fstat 校验 inode + token 双 CAS 后才写心跳；任一不符 → lost（只回调一次）。
//  - steal：guard（O_EXCL）→ 重读复核（token+inode+仍过期）→ rename 到 quarantine →
//    校验 quarantine inode；若误抢了竞争者的新锁则回滚（link 回原位）。
//  - release：只删除 inode + token 均为自己的 owner 文件；心跳文件按 token 清理。
//  - tryClaim：仅 EEXIST 返回 null；其余错误（权限/IO）显式抛出，不静默降级。
//
// 语义仍是「活跃窗口内持有」：exit handler 尽力释放；SIGKILL 由心跳过期兜底。
// 默认调参：心跳 1000ms / 过期 4500ms / 轮询 200ms（kill -9 → 接任 ≤5s 硬断言，f29/C2）。
// 〔D32 修订，2026-11-03〕心跳过期只说明「心跳停了」，不等于进程死了。
// 文件锁与 PID 探活无法撤销活进程已经准备好的 origin/journal 写入，因此不再抢占活持有者：
//   holderAlive=false（确认退出）→ 立即抢锁，≤5s SLA 不变；
//   holderAlive=true → 保留所有权、记录 steal-deferred，接受暂时不可用；
//   holderAlive=null（无法可靠判定）→ 同样不自动抢锁。
// 已放弃宽限后硬抢的设计：它不成立唯一写者保证。startedAt/etime 仅用于识别 PID 复用。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootId } from "./identity.js";
import { pidAlive } from "../provider/procgroup.js";

export interface LockInfo {
  pid: number;
  bootId: string;
  heartbeatAt: number; // epoch ms
  acquiredAt: number; // epoch ms
  /** 持有者进程启动时刻（epoch ms，估算）；旧格式锁文件缺省 → 宽限路径不做 PID 复用校验。 */
  startedAt?: number;
  /** 每次抢锁唯一；旧格式锁文件可缺省（视为 legacy，仅按 pid/bootId 识别）。 */
  token?: string;
}

export interface LockTuning {
  heartbeatMs: number;
  expiryMs: number;
  pollMs: number;
  /** 〔D32〕stalled-but-alive 持有者的抢锁宽限（复核窗口）。 */
  graceMs: number;
  /** 旧版活持有者强抢阈值（保留配置兼容；0.5.4 起活进程永不自动抢占）。 */
  hardExpiryMs: number;
}

export const DEFAULT_LOCK_TUNING: LockTuning = {
  heartbeatMs: 1000,
  expiryMs: 4500,
  pollMs: 200,
  graceMs: 3000,
  hardExpiryMs: 15000,
};

/**
 * 全局 exit 释放注册表：每个进程只挂一个 exit 监听器（多团队 host 不叠加监听器，
 * 避免 MaxListenersExceededWarning；释放后自动注销）。
 */
const exitReleases = new Set<() => void>();
let exitHookInstalled = false;

function registerExitRelease(release: () => void): () => void {
  exitReleases.add(release);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const fn of [...exitReleases]) {
        try {
          fn();
        } catch {
          /* best-effort：退出路径不得抛 */
        }
      }
      exitReleases.clear();
    });
  }
  return () => exitReleases.delete(release);
}

export class AcquireTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcquireTimeout";
  }
}

interface ObservedLock {
  exists: boolean;
  info?: LockInfo;
  /** 不可解析时按 mtime 估算的心跳年龄。 */
  ageMs: number;
  parseable: boolean;
  /** owner 文件 inode（steal 复核用；不存在时缺省）。 */
  ino?: number;
  /** 〔D32〕持有者进程存活信号：false=确认死亡（立即抢）；true=活着（宽限）；null=无法判定。 */
  holderAlive: boolean | null;
  /** 〔D32〕心跳年龄来源：token 心跳文件 / 回退到冻结的 owner.heartbeatAt / mtime 估算。 */
  hbSource: "token" | "owner-fallback" | "mtime";
}

export interface LockOptions extends Partial<LockTuning> {
  /** 身份覆盖（默认 = 本进程 pid+bootId）。用于进程内测试模拟不同持有者；生产勿用。 */
  ownerBootId?: string;
  /** 失锁回调（host 用于立即降级为 proxy；只触发一次）。 */
  onLost?: (detail: { previous: unknown }) => void;
}

/** 心跳文件路径（token 分文件；导出供测试/排障定位）。 */
export function heartbeatFileFor(lockFile: string, token: string): string {
  return `${lockFile}.hb-${token}`;
}

interface HeldState {
  info: LockInfo;
  token: string;
  ino: number;
}

export class CoordinatorLock {
  readonly lockFile: string;
  private readonly auditFile?: string;
  private readonly tuning: LockTuning;
  private readonly ownerBootId: string;
  private readonly onLost?: (detail: { previous: unknown }) => void;
  private held: HeldState | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private exitUnregister: (() => void) | null = null;

  constructor(lockFile: string, auditFile?: string, opts: LockOptions = {}) {
    this.lockFile = lockFile;
    this.auditFile = auditFile;
    const { ownerBootId, onLost, ...tuning } = opts;
    this.tuning = { ...DEFAULT_LOCK_TUNING, ...tuning };
    this.ownerBootId = ownerBootId ?? bootId();
    this.onLost = onLost;
  }

  get info(): LockInfo | null {
    return this.held?.info ?? null;
  }

  get isHeld(): boolean {
    return this.held !== null;
  }

  get tuningOptions(): LockTuning {
    return { ...this.tuning };
  }

  /**
   * 抢锁（原子）：O_EXCL 创建 owner 文件即持有。已存在时——新鲜则等待重试，过期
   * （心跳龄 > expiryMs；不可解析按 mtime）则经 guard 复核后 quarantine 再重抢。
   * waitMs 内未获得 → AcquireTimeout（所有分支都受 deadline 约束）。
   */
  async acquire(opts: { waitMs?: number } = {}): Promise<LockInfo> {
    const waitMs = opts.waitMs ?? 0;
    const deadline = Date.now() + waitMs;
    const timeout = (): never => {
      throw new AcquireTimeout(`coordinator lock not acquired within ${waitMs}ms (holder alive)`);
    };
    for (;;) {
      const claimed = await this.tryClaim();
      if (claimed !== null) return claimed;

      const observed = this.observe();
      if (!observed.exists) {
        // 锁刚被释放：留 1ms 防热循环，但不得越过 deadline。
        if (Date.now() >= deadline) timeout();
        await sleep(1);
        continue;
      }
      if (observed.ageMs > this.tuning.expiryMs) {
        const outcome = await this.steal(observed);
        if (outcome === "stolen") continue; // 锁已隔离 → 立即 tryClaim（不节流，保住 ≤5s 接任）
        // deferred/skipped：节流 + deadline 检查（waitMs=0 = 单次出手语义）。
        if (Date.now() >= deadline) timeout();
        await sleep(Math.min(this.tuning.pollMs, Math.max(deadline - Date.now(), 1)));
        continue; // 下一轮 tryClaim（抢占失败也只是继续观察）
      }
      if (Date.now() >= deadline) timeout();
      await sleep(Math.min(this.tuning.pollMs, Math.max(deadline - Date.now(), 1)));
    }
  }

  /** 续持：owner inode + token 双 CAS 通过后写心跳；被抢/丢失 → false（onLost 恰一次）。 */
  async renew(): Promise<boolean> {
    const held = this.held;
    if (held === null) return false;
    const owner = this.readOwner();
    if (
      owner === null ||
      owner.info.token !== held.token ||
      owner.ino !== held.ino ||
      owner.info.pid !== process.pid ||
      owner.info.bootId !== this.ownerBootId
    ) {
      this.markLost(owner?.info ?? held.info);
      return false;
    }
    const now = Date.now();
    try {
      this.writeHeartbeat(held.token, now);
    } catch (err) {
      // 〔D32〕单次坏写不立即降级：同步重试一次（exFAT 偶发抖动），仍败才 markLost。
      try {
        this.writeHeartbeat(held.token, now);
      } catch (retryErr) {
        this.audit("renew-failed", { error: String(err), retryError: String(retryErr) });
        this.markLost(owner.info);
        return false;
      }
    }
    this.held = { ...held, info: { ...held.info, heartbeatAt: now } };
    return true;
  }

  /** 同步释放（exit handler 用；预算 ≤200ms）。只删 inode+token 均为自己的 owner 文件。 */
  releaseSync(): void {
    this.stopHeartbeat();
    if (this.exitUnregister !== null) {
      this.exitUnregister();
      this.exitUnregister = null;
    }
    const held = this.held;
    this.held = null;
    if (held === null) return;
    try {
      const fd = fs.openSync(this.lockFile, "r");
      try {
        const stat = fs.fstatSync(fd);
        if (stat.ino !== held.ino) {
          this.audit("release-skip", { reason: "inode-changed", expected: held.ino, actual: stat.ino });
          return;
        }
        const info = JSON.parse(fs.readFileSync(fd, "utf8")) as LockInfo;
        if (info.token !== held.token || info.pid !== process.pid || info.bootId !== this.ownerBootId) {
          this.audit("release-skip", { reason: "owner-changed", previous: info });
          return;
        }
      } finally {
        fs.closeSync(fd);
      }
      // 二次确认 inode：压缩 stat→unlink 的窗口。
      if (fs.statSync(this.lockFile).ino !== held.ino) {
        this.audit("release-skip", { reason: "inode-changed-before-unlink" });
        return;
      }
      fs.unlinkSync(this.lockFile);
      this.audit("release", { via: "exit-handler" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      // 读失败/解析失败 → 不猜、不 unlink（可能误删他者锁）。
      this.audit("release-failed", { error: String(err) });
    } finally {
      this.removeHeartbeat(held.token);
    }
  }

  async release(): Promise<void> {
    this.releaseSync();
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.renew().catch(() => {
        /* 心跳失败由下一次 renew/observe 兜底 */
      });
    }, this.tuning.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 注册 exit handler（幂等）：进程退出时 best-effort 释放（单例监听器注册表）。 */
  installExitHandlers(): void {
    if (this.exitUnregister !== null) return;
    this.exitUnregister = registerExitRelease(() => this.releaseSync());
  }

  /** 观察锁文件（不抢）。ageMs：可解析 = now-heartbeatAt（优先 token 心跳）；否则 now-mtime。
   *  〔D32〕同时给出持有者进程存活信号与心跳来源（回退路径不再静默不可诊断）。 */
  observe(): ObservedLock {
    let raw: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.lockFile);
      raw = fs.readFileSync(this.lockFile, "utf8");
    } catch {
      return { exists: false, ageMs: Number.POSITIVE_INFINITY, parseable: false, holderAlive: null, hbSource: "mtime" };
    }
    try {
      const info = JSON.parse(raw) as LockInfo;
      if (
        typeof info.pid === "number" &&
        typeof info.bootId === "string" &&
        typeof info.heartbeatAt === "number"
      ) {
        let heartbeatAt = info.heartbeatAt;
        let hbSource: ObservedLock["hbSource"] = "owner-fallback";
        if (typeof info.token === "string") {
          const hb = this.readHeartbeat(info.token);
          if (hb !== undefined) {
            heartbeatAt = hb;
            hbSource = "token";
          }
        }
        return {
          exists: true,
          info,
          ageMs: Date.now() - heartbeatAt,
          parseable: true,
          ino: stat.ino,
          holderAlive: pidAlive(info.pid),
          hbSource,
        };
      }
    } catch {
      /* JSON 坏 → 按 mtime 龄估算 */
    }
    return {
      exists: true,
      ageMs: Date.now() - stat.mtimeMs,
      parseable: false,
      ino: stat.ino,
      holderAlive: null,
      hbSource: "mtime",
    };
  }

  /** 审计痕迹（获取/释放/抢占/丢失；best-effort，无 fsync）。 */
  audit(event: string, detail?: unknown): void {
    if (this.auditFile === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      fs.appendFileSync(
        this.auditFile,
        JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, bootId: this.ownerBootId, detail }) +
          "\n",
        { mode: 0o600 },
      );
    } catch {
      /* 审计失败不致命 */
    }
  }

  private async tryClaim(): Promise<LockInfo | null> {
    const now = Date.now();
    const token = crypto.randomBytes(12).toString("hex");
    const info: LockInfo = {
      pid: process.pid,
      bootId: this.ownerBootId,
      heartbeatAt: now,
      acquiredAt: now,
      // 〔D32〕进程启动时刻估算（宽限路径做 PID 复用防护；旧锁无此字段则跳过校验）。
      startedAt: now - Math.round(process.uptime() * 1000),
      token,
    };
    let fd: number;
    try {
      fd = fs.openSync(this.lockFile, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err; // EACCES/ENOSPC 等必须显式失败（不静默降级）
    }
    let ino: number;
    try {
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.fsyncSync(fd);
      ino = fs.fstatSync(fd).ino;
    } catch (err) {
      // 自己刚创建的文件：确认 inode 后清理，避免留下半写死锁。
      try {
        const stat = fs.fstatSync(fd);
        if (stat.ino === fs.statSync(this.lockFile).ino) fs.unlinkSync(this.lockFile);
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      fs.closeSync(fd);
    }
    this.held = { info, token, ino };
    try {
      this.writeHeartbeat(token, now);
      this.cleanupForeignHeartbeats(token);
    } catch (err) {
      // 〔D32〕首写失败不再静默：observe 会回退到冻结的 acquire 时间戳，4.5s 后即被误判死亡。
      this.audit("heartbeat-first-write-failed", { error: String(err) });
    }
    this.audit("acquire", { token: token.slice(0, 8), ino });
    return info;
  }

  private readOwner(): { info: LockInfo; ino: number } | null {
    try {
      const fd = fs.openSync(this.lockFile, "r");
      try {
        const stat = fs.fstatSync(fd);
        const info = JSON.parse(fs.readFileSync(fd, "utf8")) as LockInfo;
        return { info, ino: stat.ino };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private readHeartbeat(token: string): number | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(heartbeatFileFor(this.lockFile, token), "utf8")) as {
        token?: string;
        heartbeatAt?: number;
      };
      if (parsed.token === token && typeof parsed.heartbeatAt === "number") return parsed.heartbeatAt;
    } catch {
      /* 缺失/损坏 → 回退 owner 时间戳 */
    }
    return undefined;
  }

  private writeHeartbeat(token: string, at: number): void {
    const file = heartbeatFileFor(this.lockFile, token);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ token, heartbeatAt: at }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }

  private removeHeartbeat(token: string): void {
    try {
      fs.unlinkSync(heartbeatFileFor(this.lockFile, token));
    } catch {
      /* 已不在 → 无需清理 */
    }
  }

  private cleanupForeignHeartbeats(ownToken: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(path.dirname(this.lockFile));
    } catch {
      return;
    }
    const prefix = `${path.basename(this.lockFile)}.hb-`;
    for (const name of names) {
      if (!name.startsWith(prefix) || name === `${prefix}${ownToken}`) continue;
      try {
        fs.unlinkSync(path.join(path.dirname(this.lockFile), name));
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * 过期接任（保守唯一写者）：只有确认持有者退出或 PID 已复用才隔离旧锁。
   * 活进程/不可解析持有者的写能力无法由文件锁撤销，超龄也绝不抢占；等待其正常释放。
   * 若 rename 到的不是观察到的 inode（竞争者刚换了新锁）→ 尝试归还并回滚。
   */
  private async steal(observed: ObservedLock): Promise<"stolen" | "deferred" | "skipped"> {
    const guard = `${this.lockFile}.guard-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    let guardFd: number;
    try {
      guardFd = fs.openSync(guard, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "skipped"; // 他人在抢 → 本轮放弃
      throw err;
    }
    try {
      const current = this.observe();
      if (!current.exists || current.ageMs <= this.tuning.expiryMs) return "skipped";
      if (
        observed.ino === undefined ||
        current.ino !== observed.ino ||
        current.info?.token !== observed.info?.token
      ) {
        return "skipped"; // 观察后锁已换代 → 不抢
      }
      // 文件锁不能撤销活进程已准备好的写入；活持有者超龄只降级可用性，不转移所有权。
      if (current.holderAlive !== false && !this.pidReused(current)) {
        this.audit("steal-deferred", {
          reason: current.holderAlive === true ? "holder-alive" : "holder-liveness-unknown",
          ageMs: Math.round(current.ageMs),
          hbSource: current.hbSource,
          previous: current.info,
        });
        return "deferred";
      }
      const quarantine = `${this.lockFile}.stale-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      try {
        fs.renameSync(this.lockFile, quarantine);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "skipped";
        throw err;
      }
      let quarantinedIno: number | null = null;
      try {
        quarantinedIno = fs.statSync(quarantine).ino;
      } catch {
        quarantinedIno = null;
      }
      if (quarantinedIno !== current.ino) {
        // 误 rename 了竞争者的新锁：尽力归还（原位仍空才 link 回去）。
        try {
          fs.linkSync(quarantine, this.lockFile);
          fs.unlinkSync(quarantine);
          this.audit("steal-rollback", { reason: "inode-mismatch", quarantinedIno, expected: current.ino });
        } catch (rollbackErr) {
          this.audit("steal-rollback-failed", {
            reason: "inode-mismatch",
            quarantinedIno,
            expected: current.ino,
            error: String(rollbackErr),
            quarantine,
          });
        }
        return "skipped";
      }
      this.audit("steal", {
        reason: current.parseable ? "heartbeat-expired" : "unparseable-and-aged",
        holderAlive: current.holderAlive,
        hbSource: current.hbSource,
        previous: current.info ?? { mtimeAgeMs: Math.round(current.ageMs) },
        quarantine,
      });
      if (typeof current.info?.token === "string") this.removeHeartbeat(current.info.token);
      return "stolen";
    } finally {
      try {
        fs.closeSync(guardFd);
      } catch {
        /* best-effort */
      }
      try {
        fs.unlinkSync(guard);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * 〔D32〕PID 复用防护（仅宽限路径调用）：锁内 startedAt 与 `ps -o etime=` 推算的启动时刻
   * 偏差 >3s → 认定 PID 已被复用（原持有者已死）→ 跳过宽限按死亡处理。
   * 旧锁无 startedAt / ps 不可用 / 解析失败 → 返回 false（保守：维持宽限，不误杀活人）。
   * etime 跨平台（macOS 无 etimes；格式 mm:ss | hh:mm:ss | d-hh:mm:ss）。
   */
  private pidReused(observed: ObservedLock): boolean {
    const startedAt = observed.info?.startedAt;
    const pid = observed.info?.pid;
    if (typeof startedAt !== "number" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
    if (r.status !== 0) return false;
    const elapsedSec = parseEtime(r.stdout.trim());
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return false;
    const estimatedStart = Date.now() - elapsedSec * 1000;
    return Math.abs(estimatedStart - startedAt) > 3000;
  }

  private markLost(previous: unknown): void {
    if (this.held === null) return; // 只回调一次
    this.audit("lost", { previous });
    this.held = null;
    this.stopHeartbeat();
    this.onLost?.({ previous });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 〔D32〕解析 `ps -o etime=` 输出为秒：mm:ss | hh:mm:ss | d-hh:mm:ss；不可解析 → NaN。 */
export function parseEtime(raw: string): number {
  let s = raw.trim();
  if (s.length === 0) return Number.NaN;
  let days = 0;
  const dash = s.indexOf("-");
  if (dash !== -1) {
    days = Number.parseInt(s.slice(0, dash), 10);
    s = s.slice(dash + 1);
  }
  const parts = s.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return Number.NaN;
  let sec: number;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else return Number.NaN;
  return days * 86400 + sec;
}
