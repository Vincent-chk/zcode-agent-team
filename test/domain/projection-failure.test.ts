// F05：failure 终态；F05b/C5：failure 全员非成员化退化（fail-closed）与投影未注册。
import { describe, expect, it } from "vitest";
import {
  applyProjectionEvent,
  applyCurrentTeamEvent,
  emptyTeamState,
  projectionFailureError,
  projectionNotRegisteredError,
  requireMembership,
  teamProjectionView,
  tryMembership,
} from "../../src/domain/projection.js";
import { TeamError } from "../../src/domain/errors.js";
import { memberEvent, queuedEvent, TEAM_ID } from "./helpers.js";

function healthyTwoPhaseState() {
  let state = emptyTeamState(TEAM_ID);
  state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
  state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "active" }));
  return state;
}

describe("projection · failure 终态（F05）", () => {
  it("注入非法事件后进入 failure；后续合法事件不再应用（原状态引用不变）", () => {
    // F05
    const healthy = healthyTwoPhaseState();
    const broken = applyProjectionEvent(healthy, { ...memberEvent({ id: "a9", name: "ghost" }), version: 3 });
    expect(broken.failure).toBe("unsupported Agent Teams event version 3");
    expect(broken.members).toBe(healthy.members); // failure 不回改最后有效状态

    const after1 = applyCurrentTeamEvent(
      broken,
      memberEvent({ id: "a2", name: "second", phase: "provisioning" }),
    );
    expect(after1).toBe(broken); // 终态：原样返回
    const after2 = applyProjectionEvent(broken, queuedEvent({ id: "m1", targetId: "a1" }));
    expect(after2).toBe(broken);
  });

  it("视图 = 最后有效状态 + failure；重复构建引用稳定（不产生新视图）", () => {
    // F05
    const healthy = healthyTwoPhaseState();
    const viewBefore = teamProjectionView(healthy);
    expect(viewBefore.failure).toBeUndefined();

    const broken = applyProjectionEvent(healthy, { ...memberEvent({ id: "a9", name: "ghost" }), version: 3 });
    const viewBroken = teamProjectionView(broken);
    expect(viewBroken.failure).toBe("unsupported Agent Teams event version 3");
    expect(viewBroken.members).toBe(viewBefore.members); // 结构共享：最后有效状态
    expect(viewBroken.tasks).toBe(viewBefore.tasks);
    expect(teamProjectionView(broken)).toBe(viewBroken); // 稳定引用，不重发
  });

  it("failure 的另一来源：strict 解码失败（C9 消息）", () => {
    // F05 / F07b
    const state = emptyTeamState(TEAM_ID);
    const broken = applyProjectionEvent(state, {
      type: "team/message/queued",
      version: 2,
      teamId: TEAM_ID,
      message: { id: "m1" }, // 载荷缺字段
    });
    expect(broken.failure).toBe("persisted Agent Teams team/message/queued payload is invalid");
  });
});

describe("projection · tryMembership 退化（F05b/C5）", () => {
  it("健康状态：lead / active / provisioning 成员可解析；failed 成员与陌生人非成员", () => {
    // F05b
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a2", name: "helper", phase: "provisioning" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a2", name: "helper", phase: "active" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "failed" }));

    expect(tryMembership(() => state, TEAM_ID)).toEqual({ rootId: TEAM_ID, role: "lead", name: "lead" });
    expect(tryMembership(() => state, "a2")).toEqual({ rootId: TEAM_ID, role: "teammate", name: "helper" });
    expect(tryMembership(() => state, "a1")).toBeUndefined(); // failed → 非成员
    expect(tryMembership(() => state, "stranger")).toBeUndefined();
  });

  it("投影 failure 终态：loadState 抛错 → 静默非成员（含 lead 本人，fail-closed）", () => {
    // F05b / C5
    const healthy = healthyTwoPhaseState();
    const broken = applyProjectionEvent(healthy, { ...memberEvent({ id: "a9", name: "ghost" }), version: 3 });
    const loadBroken = (): never => {
      throw projectionFailureError(broken.failure as string);
    };
    expect(tryMembership(loadBroken, TEAM_ID)).toBeUndefined();
    expect(tryMembership(loadBroken, "a1")).toBeUndefined();
    expect(() => requireMembership(loadBroken, TEAM_ID)).toThrowError(TeamError);
    try {
      requireMembership(loadBroken, TEAM_ID);
    } catch (err) {
      expect((err as TeamError).code).toBe("TEAM_NOT_MEMBER");
      expect((err as TeamError).message).toBe(
        `agent "${TEAM_ID}" is not a member of an active Agent Team`,
      );
    }
  });

  it("投影未注册：loadState 抛 `Agent Teams projection is not registered` → 静默非成员", () => {
    // F05b
    const loadUnregistered = (): never => {
      throw projectionNotRegisteredError();
    };
    expect(tryMembership(loadUnregistered, TEAM_ID)).toBeUndefined();
    expect(() => requireMembership(loadUnregistered, "a1")).toThrowError(
      `agent "a1" is not a member of an active Agent Team`,
    );
  });

  it("requireMembership 健康路径返回成员资格", () => {
    // F05b
    const state = healthyTwoPhaseState();
    expect(requireMembership(() => state, "a1")).toEqual({
      rootId: TEAM_ID,
      role: "teammate",
      name: "worker",
    });
  });
});
