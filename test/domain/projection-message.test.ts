// F04：message 重放（queued 不重复 / delivered 先 queued / targetId 一致 / 不重复投递，4 条逐字）。
import { describe, expect, it } from "vitest";
import { applyCurrentTeamEvent, emptyTeamState } from "../../src/domain/projection.js";
import { deliveredEvent, queuedEvent, TEAM_ID } from "./helpers.js";

describe("projection · message（F04）", () => {
  it("queued 追加进 messages；id 重复 → `was queued twice`", () => {
    // F04
    const state = emptyTeamState(TEAM_ID);
    const s1 = applyCurrentTeamEvent(state, queuedEvent({ id: "m1", targetId: "a1" }));
    expect(s1.failure).toBeUndefined();
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].id).toBe("m1");
    const dup = applyCurrentTeamEvent(s1, queuedEvent({ id: "m1", targetId: "a1" }));
    expect(dup.failure).toBe('team message "m1" was queued twice');
    // 同 id 不同 target 同样是重复 queued
    const dup2 = applyCurrentTeamEvent(s1, queuedEvent({ id: "m1", targetId: "a2" }));
    expect(dup2.failure).toBe('team message "m1" was queued twice');
  });

  it("delivered 必须先有 queued → `was delivered before queueing`", () => {
    // F04
    const state = emptyTeamState(TEAM_ID);
    const next = applyCurrentTeamEvent(state, deliveredEvent("m-ghost", "a1"));
    expect(next.failure).toBe('team message "m-ghost" was delivered before queueing');
  });

  it("targetId 一致 → `target changed`", () => {
    // F04
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, queuedEvent({ id: "m1", targetId: "a1" }));
    const next = applyCurrentTeamEvent(state, deliveredEvent("m1", "a2"));
    expect(next.failure).toBe('team message "m1" target changed');
  });

  it("不重复投递 → `was delivered twice`", () => {
    // F04
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, queuedEvent({ id: "m1", targetId: "a1" }));
    state = applyCurrentTeamEvent(state, deliveredEvent("m1", "a1"));
    expect(state.failure).toBeUndefined();
    expect(state.delivered).toEqual(["m1"]);
    const dup = applyCurrentTeamEvent(state, deliveredEvent("m1", "a1"));
    expect(dup.failure).toBe('team message "m1" was delivered twice');
    // 换 target 的重复 delivered 也按 delivered twice（先命中重复投递前的 target 检查按序）
    const dupOther = applyCurrentTeamEvent(state, deliveredEvent("m1", "a1"));
    expect(dupOther.failure).toBe('team message "m1" was delivered twice');
  });

  it("检查顺序：无 queued 时 delivered 的失败是 before queueing（非 target changed）", () => {
    // F04：规格 §3.2 顺序
    const state = emptyTeamState(TEAM_ID);
    const next = applyCurrentTeamEvent(state, deliveredEvent("m-ghost", "wrong-target"));
    expect(next.failure).toBe('team message "m-ghost" was delivered before queueing');
  });

  it("合法 queued→delivered 链路：delivered 数组追加，messages 不变", () => {
    // F04
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, queuedEvent({ id: "m1", targetId: "a1" }));
    const messagesRef = state.messages;
    const next = applyCurrentTeamEvent(state, deliveredEvent("m1", "a1"));
    expect(next.failure).toBeUndefined();
    expect(next.messages).toBe(messagesRef);
    expect(next.delivered).toEqual(["m1"]);
  });
});
