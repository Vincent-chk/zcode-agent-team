// F29 前置：CoordinatorLock 单元（原子抢锁/心跳续持/过期抢占/双路径释放/审计）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinatorLock, AcquireTimeout, DEFAULT_LOCK_TUNING } from "../../src/coord/lock.js";
import { observeLockFileFor } from "../../src/coord/lockfile.js";
import { parseWriterId, writerId } from "../../src/coord/identity.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-lock-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lock · 原子获取与独占", () => {
  it("两实例抢同一锁：恰一成功，另一在宽限内 AcquireTimeout", async () => {
    // F29：acquire 原子（两进程恰一成功——进程内两实例等价验证 O_EXCL 语义）
    const lockFile = path.join(dir, "t1.lock");
    const a = new CoordinatorLock(lockFile);
    const b = new CoordinatorLock(lockFile);
    const info = await a.acquire();
    expect(info.pid).toBe(process.pid);
    await expect(b.acquire({ waitMs: 300 })).rejects.toThrowError(AcquireTimeout);
    expect(a.isHeld).toBe(true);
    expect(b.isHeld).toBe(false);
    await a.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("心跳续持更新 heartbeatAt；宽限内原持有者续持不触发他者抢占", async () => {
    const lockFile = path.join(dir, "t2.lock");
    const a = new CoordinatorLock(lockFile);
    const b = new CoordinatorLock(lockFile);
    await a.acquire();
    const before = a.info!.heartbeatAt;
    await new Promise((r) => setTimeout(r, 15));
    expect(await a.renew()).toBe(true);
    expect(a.info!.heartbeatAt).toBeGreaterThanOrEqual(before);
    // b 观察到新鲜锁 → 不可抢占
    const observed = b.observe();
    expect(observed.exists).toBe(true);
    expect(observed.parseable).toBe(true);
    expect(observed.ageMs).toBeLessThan(DEFAULT_LOCK_TUNING.expiryMs);
    await expect(b.acquire({ waitMs: 50 })).rejects.toThrowError(AcquireTimeout);
    await a.release();
  });

  it("过期抢占（steal）：心跳超龄 → 接任者 unlink 后重抢成功；原持有者 renew 判失", async () => {
    // F29：过期检测 → 抢占 → 接任。进程内用注入身份模拟两持有者（生产为两进程）。
    const lockFile = path.join(dir, "t3.lock");
    const auditFile = path.join(dir, "t3.audit.jsonl");
    const a = new CoordinatorLock(lockFile, auditFile); // 身份 = 本进程 bootId
    await a.acquire();
    // 手工把心跳写老（模拟 SIGKILL 后残留的过期锁；token 心跳文件也要一并置老/删除）
    const stale = { ...a.info!, heartbeatAt: Date.now() - DEFAULT_LOCK_TUNING.expiryMs - 1000 };
    fs.writeFileSync(lockFile, JSON.stringify(stale));
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("t3.lock.hb-")) fs.unlinkSync(path.join(dir, name));
    }
    const b = new CoordinatorLock(lockFile, auditFile, { ownerBootId: "boot-standby" });
    const info2 = await b.acquire({ waitMs: 1000 });
    expect(info2.bootId).toBe("boot-standby");
    // 原持有者发现锁已非己有 → renew false（lost 审计）
    expect(await a.renew()).toBe(false);
    const audit = fs.readFileSync(auditFile, "utf8");
    expect(audit).toContain('"event":"steal"');
    expect(audit).toContain('"event":"lost"');
    await b.release();
  });

  it("不可解析锁文件：新鲜（mtime 近）视为存活；超龄可抢占", async () => {
    const lockFile = path.join(dir, "t4.lock");
    fs.writeFileSync(lockFile, "<<<garbage>>>");
    const a = new CoordinatorLock(lockFile);
    // mtime 新鲜 → 不可抢
    await expect(a.acquire({ waitMs: 50 })).rejects.toThrowError(AcquireTimeout);
    // mtime 拉老（utimes）
    const old = new Date(Date.now() - DEFAULT_LOCK_TUNING.expiryMs - 2000);
    fs.utimesSync(lockFile, old, old);
    const info = await a.acquire({ waitMs: 1000 });
    expect(info).toBeDefined();
    await a.release();
  });

  it("releaseSync 双路径之①：exit handler 形态（同步、立即消失）", async () => {
    const lockFile = path.join(dir, "t5.lock");
    const a = new CoordinatorLock(lockFile);
    await a.acquire();
    a.releaseSync();
    expect(fs.existsSync(lockFile)).toBe(false);
    // 幂等
    a.releaseSync();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("心跳定时器 start/stop 不留句柄；release 后 observe 不存在", async () => {
    const lockFile = path.join(dir, "t6.lock");
    const a = new CoordinatorLock(lockFile);
    await a.acquire();
    a.startHeartbeat();
    a.stopHeartbeat();
    await a.release();
    const b = new CoordinatorLock(lockFile);
    expect(b.observe().exists).toBe(false);
    expect(b.observe().ageMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("startHeartbeat 周期续持：心跳时间戳随间隔推进", async () => {
    const lockFile = path.join(dir, "t6b.lock");
    const a = new CoordinatorLock(lockFile, undefined, { heartbeatMs: 50 });
    await a.acquire();
    const hb0 = a.info!.heartbeatAt;
    a.startHeartbeat();
    await new Promise((r) => setTimeout(r, 180));
    expect(a.info!.heartbeatAt).toBeGreaterThan(hb0);
    a.stopHeartbeat();
    await a.release();
  });

  it("installExitHandlers：exit 事件触发同步释放（双路径①的挂载点）", async () => {
    const lockFile = path.join(dir, "t6c.lock");
    const a = new CoordinatorLock(lockFile);
    await a.acquire();
    a.installExitHandlers();
    // @types/node 的 process.emit 重载未列 "exit"，按通用签名调用并保持 this 绑定（运行时合法）
    const emitExit = process.emit.bind(process) as unknown as (event: string, ...args: unknown[]) => boolean;
    emitExit("exit");
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(a.isHeld).toBe(false);
  });
});

describe("lock · Round-2 B1（owner/heartbeat CAS / release 归属 / 双抢占）", () => {
  it("renew 不覆盖新主心跳：旧主失锁后新主心跳保持有效", async () => {
    const lockFile = path.join(dir, "t8.lock");
    const a = new CoordinatorLock(lockFile);
    await a.acquire();
    // 模拟抢占：把旧 owner 挪走（保留其 token 心跳文件），新主随后拿锁。
    fs.renameSync(lockFile, `${lockFile}.moved-${Date.now()}`);
    const b = new CoordinatorLock(lockFile, undefined, { ownerBootId: "boot-new" });
    const info = await b.acquire();
    expect(info.token).toBeDefined();
    expect(await a.renew()).toBe(false); // token/inode 均不符 → 失锁
    expect(b.isHeld).toBe(true);
    expect(await b.renew()).toBe(true); // 新主心跳仍可写
    await b.release();
  });

  it("release 只删自己的 inode：旧主 release 不移除新主锁", async () => {
    const lockFile = path.join(dir, "t9.lock");
    const a = new CoordinatorLock(lockFile);
    await a.acquire();
    fs.renameSync(lockFile, `${lockFile}.moved-${Date.now()}`);
    const b = new CoordinatorLock(lockFile, undefined, { ownerBootId: "boot-new" });
    await b.acquire();
    a.releaseSync(); // inode 已变 → skip
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(b.isHeld).toBe(true);
    expect(await b.renew()).toBe(true);
    await b.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("过期双抢占：恰一成功；quarantine 保留旧主证据", async () => {
    const lockFile = path.join(dir, "t10.lock");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 999_999,
        bootId: "boot-dead",
        heartbeatAt: Date.now() - DEFAULT_LOCK_TUNING.expiryMs - 2000,
        acquiredAt: Date.now() - 60_000,
        token: "dead-token",
      }),
    );
    const a = new CoordinatorLock(lockFile, undefined, { ownerBootId: "boot-a" });
    const b = new CoordinatorLock(lockFile, undefined, { ownerBootId: "boot-b" });
    const outcomes = await Promise.allSettled([a.acquire({ waitMs: 1000 }), b.acquire({ waitMs: 1000 })]);
    const winners = outcomes.filter((o) => o.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const holder = outcomes[0].status === "fulfilled" ? a : b;
    expect(holder.isHeld).toBe(true);
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith("t10.lock.stale-"));
    expect(quarantined).toHaveLength(1);
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, quarantined[0]), "utf8")) as { token?: string };
    expect(evidence.token).toBe("dead-token");
    await holder.release();
  });
});

describe("lockfile · writer 归属校验（journal 单写者纪律）", () => {
  it("owned / foreign / malformed / missing 四分支", async () => {
    const lockFile = path.join(dir, "t7.lock");
    const owner = new CoordinatorLock(lockFile);
    const info = await owner.acquire();
    const mine = writerId();
    // 直接构造同 pid+bootId 的 writer id
    const myWriter = `${info.bootId}:${info.pid}`;
    expect(observeLockFileFor(lockFile, myWriter)).toEqual({ ok: true, reason: "owned" });
    expect(observeLockFileFor(lockFile, "other-boot:999999").ok).toBe(false);
    expect(observeLockFileFor(lockFile, "not-a-writer-id").ok).toBe(false);
    expect(observeLockFileFor(path.join(dir, "missing.lock"), myWriter).ok).toBe(false);
    fs.writeFileSync(lockFile, "garbage");
    expect(observeLockFileFor(lockFile, myWriter).ok).toBe(false);
    await owner.releaseSync();
    expect(parseWriterId(myWriter)).toEqual({ bootId: info.bootId, pid: info.pid });
  });
});
