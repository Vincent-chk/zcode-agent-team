// 服务层测试夹具：MemoryTeamStore + MockProvider + TeamRuntime 装配（纯内存，零 IO）。
import { MemoryTeamStore } from "../../src/domain/ports.js";
import type { TeamStore } from "../../src/domain/ports.js";
import { TeamRuntime } from "../../src/domain/runtime.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { applyProjectionEvent, emptyTeamState } from "../../src/domain/projection.js";
import type { TeamState } from "../../src/domain/projection.js";
import { validateTeamLimits } from "../../src/domain/config.js";
import type { TeamLimits } from "../../src/domain/config.js";

export const TEAM = "sess_svc_lead";

export const DEFAULT_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

export interface Kit {
  runtime: TeamRuntime;
  lifecycle: TeamRuntime["lifecycle"];
  activity: TeamRuntime["activity"];
  provider: MockProvider;
  store: TestableMemoryStore;
  limits: TeamLimits;
  warnings: string[];
}

export function buildKit(opts: { limits?: Partial<TeamLimits>; teamId?: string; newId?: () => string } = {}): Kit {
  const teamId = opts.teamId ?? TEAM;
  const limits = validateTeamLimits({ ...DEFAULT_LIMITS, ...opts.limits });
  const store = new TestableMemoryStore(teamId);
  const provider = new MockProvider();
  const warnings: string[] = [];
  const runtime = new TeamRuntime({
    teamId,
    store,
    provider,
    limits,
    presentation: provider,
    warn: (m) => warnings.push(m),
    ...(opts.newId ? { newId: opts.newId } : {}),
  });
  return { runtime, lifecycle: runtime.lifecycle, activity: runtime.activity, provider, store, limits, warnings };
}

/** 可编程内存 store：testMutate（构造异常状态）+ failNextAppend（记录失败注入）。 */
export class TestableMemoryStore extends MemoryTeamStore implements TeamStore {
  constructor(teamId: string) {
    super(applyProjectionEvent, emptyTeamState(teamId));
  }

  testMutate(fn: (state: TeamState) => TeamState): void {
    const current = this.state();
    const next = fn(current);
    (this as unknown as { teamState: TeamState }).teamState = next;
  }

  private failOnce = false;

  failNextAppend(): void {
    this.failOnce = true;
  }

  override async append(event: unknown): Promise<{ seq: number; state: TeamState }> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("injected append failure");
    }
    return super.append(event);
  }
}
