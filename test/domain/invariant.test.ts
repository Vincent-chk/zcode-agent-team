// F07：追加前不变量（候选在落盘前被重放校验拒绝；非法事件从未进入已提交序列）。
// 失败消息逐字：`session event <seq> violates the Agent Teams stream: <failure>`（C8）。
import { describe, expect, it } from "vitest";
import { assertAppendable } from "../../src/domain/invariant.js";
import { deliveredEvent, memberEvent, queuedEvent, taskEvent, TEAM_ID } from "./helpers.js";

describe("invariant · assertAppendable（F07）", () => {
  it("合法候选通过（空前缀 / 有前缀）", () => {
    // F07
    expect(() =>
      assertAppendable(TEAM_ID, [], memberEvent({ id: "a1", name: "worker", phase: "provisioning" })),
    ).not.toThrow();
    const committed = [
      memberEvent({ id: "a1", name: "worker", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "worker", phase: "active" }),
    ];
    expect(() =>
      assertAppendable(TEAM_ID, committed, taskEvent({ id: "task-1", revision: 1 })),
    ).not.toThrow();
  });

  it("非法相位迁移候选：active→failed 拒绝，消息逐字，seq = committed.length + 1", () => {
    // F07
    const committed = [
      memberEvent({ id: "a1", name: "worker", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "worker", phase: "active" }),
    ];
    expect(() =>
      assertAppendable(TEAM_ID, committed, memberEvent({ id: "a1", name: "worker", phase: "failed" })),
    ).toThrowError(
      'session event 3 violates the Agent Teams stream: teammate "worker" has an invalid active -> failed transition',
    );
  });

  it("version≠3 候选（unsupported version）拒绝，消息逐字，seq 从 1 起算", () => {
    // F07
    expect(() =>
      assertAppendable(TEAM_ID, [], { ...memberEvent({ id: "a1", name: "w" }), version: 3 }),
    ).toThrowError(
      "session event 1 violates the Agent Teams stream: unsupported Agent Teams event version 3",
    );
  });

  it("载荷非法候选拒绝（C9 消息入 failure 位）", () => {
    // F07 / F07b
    expect(() =>
      assertAppendable(TEAM_ID, [], {
        type: "team/message/queued",
        version: 2,
        teamId: TEAM_ID,
        message: { id: "m1" },
      }),
    ).toThrowError(
      "session event 1 violates the Agent Teams stream: persisted Agent Teams team/message/queued payload is invalid",
    );
  });

  it("task/message 各类非法候选同样在追加前拒绝；合法 delivered 通过", () => {
    // F07
    const committed = [taskEvent({ id: "task-1", revision: 1 })];
    expect(() =>
      assertAppendable(TEAM_ID, committed, taskEvent({ id: "task-1", revision: 3 })),
    ).toThrowError('session event 2 violates the Agent Teams stream: team task "task-1" revision is not contiguous');
    expect(() =>
      assertAppendable(TEAM_ID, [queuedEvent({ id: "m1", targetId: "a1" })], deliveredEvent("m1", "a1")),
    ).not.toThrow();
    expect(() =>
      assertAppendable(TEAM_ID, [], deliveredEvent("m-none", "a1")),
    ).toThrowError('session event 1 violates the Agent Teams stream: team message "m-none" was delivered before queueing');
  });

  it("非 team/* 候选忽略、可追加（会话日志允许混排非团队事件）", () => {
    // F07
    const committed = [
      { type: "user/message", version: 2, teamId: TEAM_ID, text: "hi" },
      memberEvent({ id: "a1", name: "worker", phase: "provisioning" }),
    ];
    expect(() =>
      assertAppendable(TEAM_ID, committed, { type: "agent/status", version: 2 }),
    ).not.toThrow();
  });

  it("已提交前缀损坏（外部篡改）：报告前缀中首个违规行 seq", () => {
    // F07
    const committed = [
      memberEvent({ id: "a1", name: "worker", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "worker", phase: "active" }),
      memberEvent({ id: "a2", name: "second", phase: "active" }), // 首现非 provisioning（损坏行）
    ];
    expect(() =>
      assertAppendable(TEAM_ID, committed, queuedEvent({ id: "m1", targetId: "a1" })),
    ).toThrowError(
      'session event 3 violates the Agent Teams stream: teammate "second" must begin provisioning',
    );
  });
});
