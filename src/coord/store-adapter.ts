// journal → TeamStore 适配器（纯新增，不改 coord 既有逻辑）。
// append = journal.appendAndFlush（追加前不变量 + O_APPEND + fsync 后才算提交）；
// state = journal 冷启动加载后的缓存（loadState() 抛 failure 文本 = C5 服务层语义）；
// transact/onCommit 直通 journal 尾链与提交监听。真 journal 需要 coordinator.lock（单写者纪律）。

import type { TeamState } from "../domain/projection.js";
import type { TeamStore } from "../domain/ports.js";
import { TeamJournal, type JournalLine, type CommitListener, type JournalOptions } from "./journal.js";
import { CoordinatorLock } from "./lock.js";
import { teamPaths, ensureTeamDir } from "./paths.js";
import { writerId } from "./identity.js";

export interface JournalStoreOptions {
  /** 已持有的锁（推荐：由装配层 acquire 后传入）。缺省则本适配器自抢（等待至多 waitMs）。 */
  lock?: CoordinatorLock;
  lockWaitMs?: number;
  /** journal 选项透传（crashHook 崩溃注入等测试/演练用途）。 */
  journal?: JournalOptions;
}

export class JournalTeamStore implements TeamStore {
  private readonly journal: TeamJournal;
  private cached: TeamState | undefined;
  private readonly unsubs: Array<() => void> = [];
  /** 冷启动加载信息（host readyInfo 用；open 时捕获）。 */
  lastLoad: { seq: number; fromCheckpoint: boolean } | null = null;

  private constructor(
    private readonly journalInstance: TeamJournal,
    private readonly ownedLock: CoordinatorLock | undefined,
  ) {
    this.journal = journalInstance;
  }

  /** 打开（含抢锁 + 冷启动重放 + O_APPEND 句柄）。 */
  static async open(
    dataRoot: string,
    teamId: string,
    opts: JournalStoreOptions = {},
  ): Promise<JournalTeamStore> {
    const paths = teamPaths(dataRoot, teamId);
    ensureTeamDir(paths);
    let lock = opts.lock;
    let owned = false;
    if (lock === undefined) {
      lock = new CoordinatorLock(paths.lockFile, paths.auditFile);
      await lock.acquire({ waitMs: opts.lockWaitMs ?? 30_000 });
      owned = true;
    }
    const journal = TeamJournal.open(paths.teamDir, teamId, opts.journal);
    const loaded = await journal.openWriter(writerId());
    const store = new JournalTeamStore(journal, owned ? lock : undefined);
    store.lastLoad = { seq: loaded.seq, fromCheckpoint: loaded.fromCheckpoint };
    return store;
  }

  async append(event: unknown): Promise<{ seq: number; state: TeamState }> {
    const result = await this.journal.appendAndFlush(event);
    this.cached = result.state;
    return result;
  }

  state(): TeamState {
    if (this.cached === undefined) {
      const cached = this.journal.cachedState;
      if (cached === null) throw new Error("journal store not opened");
      this.cached = cached;
    }
    return this.cached;
  }

  /** 已提交行号（= hello.stateRevision 的冻结语义：journal seq）。 */
  get committedSeq(): number {
    return this.journal.committedSeq;
  }

  transact<T>(op: () => Promise<T>): Promise<T> {
    return this.journal.transact(op);
  }

  onCommit(listener: (seq: number, state: TeamState) => void): () => void {
    const adapted: CommitListener = (_entry: JournalLine, state: TeamState) => {
      this.cached = state;
      listener(0, state);
    };
    const off = this.journal.onCommit(adapted);
    this.unsubs.push(off);
    return off;
  }

  /** 释放（自有锁则释放；journal close 落 checkpoint）。 */
  async close(): Promise<void> {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    await this.journal.close();
    await this.ownedLock?.release();
  }
}
