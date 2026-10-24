// F02：member 重放规则矩阵（02 规格 §3.2，消息逐字）。
import { describe, expect, it } from "vitest";
import { applyProjectionEvent, applyCurrentTeamEvent, emptyTeamState } from "../../src/domain/projection.js";
import { memberEvent, TEAM_ID } from "./helpers.js";

const W = { id: "agent-worker", name: "worker" };

function applyMember(phase: "provisioning" | "active" | "failed") {
  return { ...W, phase };
}

describe("projection · member 规则（F02）", () => {
  it("非本 team 事件忽略：非 team/* 与 teamId 不符均原样返回", () => {
    // F02
    const state = emptyTeamState(TEAM_ID);
    expect(applyProjectionEvent(state, { type: "user/message", version: 2, teamId: TEAM_ID })).toBe(state);
    expect(applyProjectionEvent(state, "not-an-object")).toBe(state);
    expect(applyProjectionEvent(state, memberEvent(W, "sess-foreign"))).toBe(state);
    // teamId 检查先于 version：异 team 的 version 3 也忽略
    expect(applyProjectionEvent(state, { ...memberEvent(W, "sess-foreign"), version: 3 })).toBe(state);
  });

  it("version≠2 → failure 终态，消息逐字", () => {
    // F02
    const state = emptyTeamState(TEAM_ID);
    const next = applyProjectionEvent(state, { ...memberEvent(W), version: 3 });
    expect(next.failure).toBe("unsupported Agent Teams event version 3");
  });

  it("首现必须 provisioning，消息逐字", () => {
    // F02
    const state = emptyTeamState(TEAM_ID);
    const next = applyCurrentTeamEvent(state, memberEvent(applyMember("active")));
    expect(next.failure).toBe('teammate "worker" must begin provisioning');
    const failed2 = applyCurrentTeamEvent(state, memberEvent(applyMember("failed")));
    expect(failed2.failure).toBe('teammate "worker" must begin provisioning');
  });

  it("名字复用拒绝（同名不同 id），消息逐字", () => {
    // F02
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent(applyMember("provisioning")));
    expect(state.failure).toBeUndefined();
    const next = applyCurrentTeamEvent(
      state,
      memberEvent({ id: "agent-second", name: "worker", phase: "provisioning" }),
    );
    expect(next.failure).toBe('teammate name "worker" is reused by another member');
  });

  it("不可变身份字段变更拒绝（name/provider/context），消息逐字", () => {
    // F02：消息用 prior.id
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent(applyMember("provisioning")));
    const changedName = applyCurrentTeamEvent(
      state,
      memberEvent({ ...applyMember("provisioning"), name: "renamed" }),
    );
    expect(changedName.failure).toBe('teammate "agent-worker" changed immutable identity fields');
    const changedProvider = applyCurrentTeamEvent(
      state,
      memberEvent({ ...applyMember("provisioning"), provider: "fork" }),
    );
    expect(changedProvider.failure).toBe('teammate "agent-worker" changed immutable identity fields');
    const changedContext = applyCurrentTeamEvent(
      state,
      memberEvent({ ...applyMember("provisioning"), context: "fork" }),
    );
    expect(changedContext.failure).toBe('teammate "agent-worker" changed immutable identity fields');
  });

  it("相位迁移仅 provisioning→active|failed；其余全拒绝，消息逐字", () => {
    // F02
    const cases: Array<["provisioning" | "active" | "failed", "provisioning" | "active" | "failed"]> = [
      ["provisioning", "provisioning"],
      ["active", "active"],
      ["active", "provisioning"],
      ["active", "failed"],
      ["failed", "active"],
      ["failed", "failed"],
      ["failed", "provisioning"],
    ];
    for (const [prior, next] of cases) {
      let state = emptyTeamState(TEAM_ID);
      state = applyCurrentTeamEvent(state, memberEvent(applyMember("provisioning")));
      if (prior !== "provisioning") {
        state = applyCurrentTeamEvent(state, memberEvent(applyMember(prior)));
      }
      expect(state.failure, `seed ${prior}`).toBeUndefined();
      const after = applyCurrentTeamEvent(state, memberEvent(applyMember(next)));
      expect(after.failure, `${prior} -> ${next}`).toBe(
        `teammate "worker" has an invalid ${prior} -> ${next} transition`,
      );
    }
  });

  it("合法路径：provisioning 首现 → active/failed；members 不可变更新", () => {
    // F02
    const s0 = emptyTeamState(TEAM_ID);
    const s1 = applyCurrentTeamEvent(s0, memberEvent(applyMember("provisioning")));
    expect(s1.failure).toBeUndefined();
    expect(s1.members).toHaveLength(1);
    expect(s1.members[0].phase).toBe("provisioning");
    expect(s0.members).toHaveLength(0); // 原状态未被改写
    const s2 = applyCurrentTeamEvent(s1, memberEvent(applyMember("active")));
    expect(s2.failure).toBeUndefined();
    expect(s2.members).toHaveLength(1);
    expect(s2.members[0].phase).toBe("active");
    expect(s2.members).not.toBe(s1.members);
    const s3 = applyCurrentTeamEvent(s1, memberEvent({ ...applyMember("failed"), error: "boom" }));
    expect(s3.failure).toBeUndefined();
    expect(s3.members[0].phase).toBe("failed");
    expect(s3.members[0].error).toBe("boom");
  });

  it("description/error 非身份字段：provisioning→failed 终态事件可携带新 description 与 error", () => {
    // F02：不可变集 = name/provider/context（02 §3.2 L73）；description/error 随终态事件更新
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ ...applyMember("provisioning"), description: "old duty" }));
    state = applyCurrentTeamEvent(
      state,
      memberEvent({ ...applyMember("failed"), description: "updated duty", error: "boom" }),
    );
    expect(state.failure).toBeUndefined();
    expect(state.members[0].description).toBe("updated duty");
    expect(state.members[0].error).toBe("boom");
  });
});
