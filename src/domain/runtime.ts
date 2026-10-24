// TeamRuntime：五服务装配（一切内存态皆可丢弃——同参数重建 + store 重放即恢复等价实例）。

import type { TeamLimits } from "./config.js";
import type { TeamStore, ReconciliationSource, TargetInspector, Clock } from "./ports.js";
import { TeamLifecycle } from "./lifecycle.js";
import { TeamActivity } from "./activity.js";
import { TeamRoster, type MemberPresentation } from "./roster.js";
import { TeamMailbox } from "./mailbox.js";
import { TeamTaskBoard } from "./taskboard.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import type { ContentBlock } from "./events.js";
import type { MessageSource } from "./mailbox.js";

export interface RuntimeDeps {
  teamId: string;
  store: TeamStore;
  provider: TeammateProvider & ReconciliationSource & TargetInspector;
  limits: TeamLimits;
  presentation?: MemberPresentation;
  providers?: { fresh: string; fork: string };
  leadModel?: string;
  steerLead?: (framed: ContentBlock[], source: MessageSource) => void;
  clock?: Clock;
  warn?: (message: string) => void;
  newId?: () => string;
}

export class TeamRuntime {
  readonly lifecycle: TeamLifecycle;
  readonly activity: TeamActivity;
  readonly roster: TeamRoster;
  readonly mailbox: TeamMailbox;
  readonly taskboard: TeamTaskBoard;
  private readonly unsubscribeCommit: () => void;
  private readonly unsubscribeStatus: () => void;

  constructor(deps: RuntimeDeps) {
    this.lifecycle = new TeamLifecycle({
      teamId: deps.teamId,
      store: deps.store,
      disposalTimeoutMs: deps.limits.disposalTimeoutMs,
      drainer: (args) => deps.provider.drain({ teamId: deps.teamId, timeoutMs: args.timeoutMs }),
      closeWaiters: () => this.activity.closeAll(),
      clock: deps.clock,
    });
    this.activity = new TeamActivity({ store: deps.store, clock: deps.clock });
    this.roster = new TeamRoster({
      teamId: deps.teamId,
      store: deps.store,
      provider: deps.provider,
      recon: deps.provider,
      inspector: deps.provider,
      limits: deps.limits,
      lifecycle: this.lifecycle,
      presentation: deps.presentation,
      providers: deps.providers,
      leadModel: deps.leadModel,
      warn: deps.warn,
      newId: deps.newId,
    });
    this.mailbox = new TeamMailbox({
      teamId: deps.teamId,
      store: deps.store,
      provider: deps.provider,
      inspector: deps.provider,
      limits: deps.limits,
      lifecycle: this.lifecycle,
      steerLead: deps.steerLead,
      warn: deps.warn,
      newId: deps.newId,
    });
    this.taskboard = new TeamTaskBoard({
      teamId: deps.teamId,
      store: deps.store,
      limits: deps.limits,
      lifecycle: this.lifecycle,
    });
    this.unsubscribeCommit = this.activity.bindCommitEdge();
    this.unsubscribeStatus = this.roster.onMemberStatus(() => this.activity.notifyMemberStatus());
  }

  /** 冷启动恢复对账：roster 对账完成 + 全量邮箱续投。 */
  async recoverAll(): Promise<void> {
    await this.roster.recoveryDone;
    await this.mailbox.recoverFor("all");
  }

  /** D9 抽象处置入口。 */
  dispose(reason?: unknown): Promise<void> {
    return this.lifecycle.dispose(reason);
  }

  close(): void {
    this.unsubscribeCommit();
    this.unsubscribeStatus();
  }
}
