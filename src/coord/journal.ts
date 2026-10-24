// 事件日志 journal（stage-2 T2.2 主体）。
//
// 行格式（传输层包装；域事件 = 02 §3.1 平铺形状，位于 event 字段内，不与冻结 schema 冲突）：
//   { "seq": <行号，1 起>, "ts": <写入时间 ISO>, "writer": "<bootId:pid>", "event": { …domain event… } }
// seq/ts 由 journal 承担（快照不重复携带）；writer 满足规划 §3「事件行带 writerId」（双写排查依据）。
//
// 提交纪律：「追加 + fsync → 更新内存态 → 通知 → 应答」，顺序不得调换：
//   write(单行 ≤64KB, O_APPEND) → fsync → cache=候选后状态 → onCommit 监听器 → resolve。
//   已应答 ⇒ 必已落盘；未应答可丢（重试语义由服务层用消息 id 去重兜底）。
//
// 崩溃注入点（测试运行器 / stage-6 复用）：crashHook(point, ctx) 在以下位置同步调用——
//   append:before  校验通过后、write 之前（无任何磁盘痕迹）
//   append:after   write 返回后、fsync 之前（行已在页缓存，未刷盘）
//   fsync:before   同 append:after 语义位（显式命名，供矩阵区分）
//   fsync:after    fsync 返回后、内存态更新之前（行已持久，但本进程缓存未推进）
//   ack:before     内存态已更新、通知之前（行已持久；重启重放可见，但调用方未收到应答）
// hook 内可 process.kill(process.pid, "SIGKILL")（真实演练）或 throw（进程内模拟）。
//
// 单写者纪律：openWriter 校验 coordinator.lock 属于本 writer（pid+bootId 匹配）；
// 非协调者只能用只读读取器（readAll / replay.load）。

import fs from "node:fs";
import path from "node:path";
import { applyProjectionEvent, emptyTeamState, teamProjectionView } from "../domain/projection.js";
import type { TeamState } from "../domain/projection.js";
import { assertAppendable } from "../domain/invariant.js";
import { parseWriterId, writerId } from "./identity.js";
import { observeLockFileFor } from "./lockfile.js";
import { load, writeCheckpoint, type LoadedTeam } from "./replay.js";

export type CrashPoint =
  | "append:before"
  | "append:after"
  | "fsync:before"
  | "fsync:after"
  | "ack:before";

export interface JournalLine {
  seq: number;
  ts: string;
  writer: string;
  event: unknown;
}

export interface AppendResult {
  seq: number;
  ts: string;
  state: TeamState;
}

export interface JournalOptions {
  /** 崩溃注入（见文件头）。 */
  crashHook?: (point: CrashPoint, ctx: { seq: number }) => void;
  /** 单行字节上限（默认 64KiB，由 maxMessageBytes 档位保证消息行不超）。 */
  maxLineBytes?: number;
  /** 每 N 次提交自动写 checkpoint（默认 256；0 = 关闭自动）。 */
  checkpointEvery?: number;
  /** 测试用途：跳过锁纪律校验（如直接在无锁环境构造日志）。 */
  enforceLock?: boolean;
}

export interface CommitListener {
  (entry: JournalLine, state: TeamState): void;
}

export class TeamJournal {
  readonly teamDir: string;
  readonly teamId: string;
  private readonly eventsFile: string;
  private readonly lockFile: string;
  private readonly opts: Required<Pick<JournalOptions, "maxLineBytes" | "checkpointEvery" | "enforceLock">> &
    JournalOptions;
  private writer: string | null = null;
  private appendFd: number | null = null;
  private cache: TeamState | null = null;
  private committedCount = 0;
  private bytesCommitted = 0;
  private txTail: Promise<unknown> = Promise.resolve();
  private txDepth = 0;
  private readonly listeners = new Set<CommitListener>();
  private static readonly instances = new Map<string, TeamJournal>();

  /** 进程内单例（同 teamDir+teamId 只允许一个实例，防同进程双写）。 */
  static open(teamDir: string, teamId: string, opts?: JournalOptions): TeamJournal {
    const key = `${teamDir}\u0000${teamId}`;
    const existing = TeamJournal.instances.get(key);
    if (existing) return existing;
    const journal = new TeamJournal(teamDir, teamId, opts);
    TeamJournal.instances.set(key, journal);
    return journal;
  }

  private constructor(teamDir: string, teamId: string, opts: JournalOptions = {}) {
    this.teamDir = teamDir;
    this.teamId = teamId;
    this.eventsFile = path.join(teamDir, "events.jsonl");
    this.lockFile = path.join(teamDir, "coordinator.lock");
    this.opts = { maxLineBytes: 65536, checkpointEvery: 256, enforceLock: true, ...opts };
  }

  /**
   * 取得写权（协调者专用）：校验锁归属 + 冷启动全量/增量重放缓存状态 + 打开 O_APPEND 句柄。
   * 返回冷启动加载结果（含 checkpoint 命中信息）。
   */
  async openWriter(writer: string = writerId()): Promise<LoadedTeam> {
    if (this.opts.enforceLock) {
      const verdict = observeLockFileFor(this.lockFile, writer);
      if (!verdict.ok) {
        throw new Error(
          `journal writer requires the coordinator lock (${verdict.reason}; writer=${writer})`,
        );
      }
    }
    const loaded = await load(this.teamDir, this.teamId);
    this.writer = writer;
    this.cache = loaded.state;
    this.committedCount = loaded.seq;
    fs.mkdirSync(this.teamDir, { recursive: true, mode: 0o700 });
    this.appendFd = fs.openSync(this.eventsFile, "a", 0o600);
    this.bytesCommitted = fs.statSync(this.eventsFile).size;
    return loaded;
  }

  /** 追加前不变量 + 落盘 + fsync + 内存态推进 + 通知 + 应答。非法事件绝不落盘（硬断言）。 */
  appendAndFlush(candidate: unknown): Promise<AppendResult> {
    return this.enqueue(async () => {
      const seq = this.committedCount + 1;
      // 每次 append 前复核锁归属：失锁后旧协调者不得继续写（防双写者）。
      if (this.opts.enforceLock && this.writer !== null) {
        const verdict = observeLockFileFor(this.lockFile, this.writer);
        if (!verdict.ok) {
          throw new Error(`coordinator lock lost before append (${verdict.reason}; writer=${this.writer})`);
        }
      }
      if (this.cache === null) {
        // 无缓存（未 openWriter 的写路径不应发生；防御性回退到全量前缀重放校验）
        const committed = (await readAllLines(this.eventsFile)).map((l) => l.event);
        assertAppendable(this.teamId, committed, candidate);
      }
      const prior = this.cache ?? emptyTeamState(this.teamId);
      const next = applyProjectionEvent(prior, candidate);
      if (next.failure !== undefined) {
        throw new Error(
          `session event ${seq} violates the Agent Teams stream: ${next.failure}`,
        );
      }
      this.opts.crashHook?.("append:before", { seq });
      const ts = new Date().toISOString();
      const line: JournalLine = { seq, ts, writer: this.writer ?? writerId(), event: candidate };
      const raw = JSON.stringify(line) + "\n";
      if (Buffer.byteLength(raw) > this.opts.maxLineBytes) {
        throw new Error(
          `journal line exceeds ${this.opts.maxLineBytes} bytes (seq ${seq})`,
        );
      }
      if (this.appendFd === null) throw new Error("journal writer not open (call openWriter first)");
      const lineBytes = Buffer.byteLength(raw);
      fs.writeSync(this.appendFd, raw);
      this.opts.crashHook?.("append:after", { seq });
      this.opts.crashHook?.("fsync:before", { seq });
      fs.fsyncSync(this.appendFd);
      this.opts.crashHook?.("fsync:after", { seq });
      // 提交块：内存态/行数/字节偏移原子推进（与磁盘一致；此前任何崩溃点三者保持同步陈旧）
      this.cache = next;
      this.committedCount = seq;
      this.bytesCommitted += lineBytes;
      this.opts.crashHook?.("ack:before", { seq });
      for (const listener of this.listeners) listener(line, next);
      void this.maybeCheckpoint(seq);
      return { seq, ts, state: next };
    });
  }

  /** 同 teamId 尾链串行（本实例事务队列；不同 team = 不同实例 = 可并发）。应答序 = 提交序。 */
  transact<T>(op: () => Promise<T> | T): Promise<T> {
    return this.enqueue(() => Promise.resolve(op()));
  }
  /** 只读读取器：全量读行（不持写句柄；非协调者可用）。 */
  async readAll(): Promise<JournalLine[]> {
    return readAllLines(this.eventsFile);
  }

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get committedSeq(): number {
    return this.committedCount;
  }

  get cachedState(): TeamState | null {
    return this.cache;
  }

  async writeCheckpointNow(): Promise<void> {
    if (this.cache === null) return;
    await writeCheckpoint(this.teamDir, {
      state: this.cache,
      view: teamProjectionView(this.cache),
      seq: this.committedCount,
      byteOffset: this.bytesCommitted,
    });
  }

  async close(): Promise<void> {
    if (this.appendFd !== null) {
      fs.closeSync(this.appendFd);
      this.appendFd = null;
    }
    await this.writeCheckpointNow();
    TeamJournal.instances.delete(`${this.teamDir}\u0000${this.teamId}`);
  }

  private async maybeCheckpoint(seq: number): Promise<void> {
    if (this.opts.checkpointEvery <= 0) return;
    if (seq % this.opts.checkpointEvery !== 0) return;
    try {
      await this.writeCheckpointNow();
    } catch {
      /* checkpoint 失败不影响提交语义（下一次阈值重试） */
    }
  }

  /** 尾链入队：op 严格在前一事务完成后才开始；拒绝结果向调用方透传，不阻断后续事务。
   *  重入安全：当前已处于本实例事务的串行区内（txDepth>0）时直接执行（同 MemoryTeamStore 口径）。 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return this.runGuarded(op);
    const run = this.txTail.then(
      () => this.runGuarded(op),
      () => this.runGuarded(op),
    );
    this.txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runGuarded<T>(op: () => Promise<T>): Promise<T> {
    this.txDepth += 1;
    try {
      return await op();
    } finally {
      this.txDepth -= 1;
    }
  }
}

/** 只读取行（假定日志健康；损坏行处置见 replay.load 的 fail-closed 路径）。 */
export async function readAllLines(eventsFile: string): Promise<JournalLine[]> {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return [];
  }
  const lines: JournalLine[] = [];
  for (const chunk of raw.split("\n")) {
    if (chunk.length === 0) break;
    lines.push(JSON.parse(chunk) as JournalLine);
  }
  return lines;
}

export { parseWriterId };
