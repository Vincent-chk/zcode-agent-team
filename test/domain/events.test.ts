// F01：4 种事件 schema strict；ContentBlock 未知 type 宽松保留；__proto__ 自有键往返；tool-result 拒绝。
// F07b：持久状态 strict schema；payload 解码失败消息逐字；task/message id 宽松口径双模式。
import { describe, expect, it } from "vitest";
import {
  decodePersistedPayload,
  decodeTeamEvent,
  memberEventSchema,
  messageQueuedEventSchema,
  selectTeamEvent,
  taskSnapshotSchema,
  teamStateSchema,
  validateContentBlock,
  isLooseIdValid,
  TEAM_EVENT_TYPES,
} from "../../src/domain/events.js";
import {
  memberEvent,
  queuedEvent,
  taskEvent,
  TEAM_ID,
  memberSnapshot,
  taskSnapshot,
  messageSnapshot,
} from "./helpers.js";

describe("events · strict 事件 schema（F01）", () => {
  it("4 种事件类型全集", () => {
    expect([...TEAM_EVENT_TYPES]).toEqual([
      "team/member",
      "team/task",
      "team/message/queued",
      "team/message/delivered",
    ]);
  });

  it("合法 member 事件通过；多余字段拒绝", () => {
    // F01
    const raw = { ...memberEvent({ id: "a1", name: "worker" }), extra: 1 };
    expect(memberEventSchema.safeParse(raw).success).toBe(false);
    expect(memberEventSchema.safeParse(memberEvent({ id: "a1", name: "worker" })).success).toBe(true);
  });

  it("member 快照多余字段拒绝；缺必填字段拒绝", () => {
    // F01
    const good = memberSnapshot({ id: "a1", name: "worker" });
    expect(memberEventSchema.shape.member.safeParse({ ...good, mystery: true }).success).toBe(false);
    const { provider, ...missingProvider } = good;
    expect(provider).toBeTypeOf("string");
    expect(memberEventSchema.shape.member.safeParse(missingProvider).success).toBe(false);
  });

  it("task 快照多余字段/revision 非正拒绝", () => {
    // F01
    const good = taskSnapshot({ id: "task-1" });
    expect(taskSnapshotSchema.safeParse({ ...good, extra: true }).success).toBe(false);
    expect(taskSnapshotSchema.safeParse({ ...good, revision: 0 }).success).toBe(false);
    expect(taskSnapshotSchema.safeParse({ ...good, revision: 1.5 }).success).toBe(false);
  });

  it("delivered 事件多余字段拒绝（strict 信封）", () => {
    // F01
    const ok = selectTeamEvent(
      { type: "team/message/delivered", version: 2, teamId: TEAM_ID, messageId: "m1", targetId: "t1" },
      TEAM_ID,
    );
    expect(ok).toMatchObject({ kind: "event" });
    const bad = selectTeamEvent(
      {
        type: "team/message/delivered",
        version: 2,
        teamId: TEAM_ID,
        messageId: "m1",
        targetId: "t1",
        seq: 9,
      },
      TEAM_ID,
    );
    expect(bad).toEqual({ kind: "invalid-payload", type: "team/message/delivered" });
  });
});

describe("events · ContentBlock（F01）", () => {
  it("四型已知块校验通过并返回原引用（未声明字段保留）", () => {
    // F01
    const text = { type: "text", text: "hi", futureField: { a: 1 } };
    expect(validateContentBlock(text)).toBe(text);
    const reasoning = { type: "reasoning", text: "thinking..." };
    expect(validateContentBlock(reasoning)).toBe(reasoning);
    const image = {
      type: "image",
      attachment: {
        attachmentId: "att-1",
        mediaType: "png",
        bytes: 10,
        width: 4,
        height: 4,
        name: "dot.png",
      },
    };
    expect(validateContentBlock(image)).toBe(image);
    const toolCall = { type: "tool-call", id: "c1", name: "bash", arguments: { cmd: "ls" } };
    expect(validateContentBlock(toolCall)).toBe(toolCall);
  });

  it("image name 可缺省；非法 mediaType / 缺字段拒绝", () => {
    const ok = {
      type: "image",
      attachment: { attachmentId: "a", mediaType: "gif", bytes: 1, width: 1, height: 1 },
    };
    expect(validateContentBlock(ok)).toBe(ok);
    expect(() =>
      validateContentBlock({ type: "image", attachment: { ...ok.attachment, mediaType: "bmp" } }),
    ).toThrowError(/mediaType/);
    expect(() =>
      validateContentBlock({ type: "image", attachment: { ...ok.attachment, bytes: "10" } }),
    ).toThrowError(/bytes/);
    expect(() =>
      validateContentBlock({ type: "image", attachment: { ...ok.attachment, name: 7 } }),
    ).toThrowError(/name/);
  });

  it("text/reasoning 缺 text、tool-call 缺字段拒绝；非对象拒绝", () => {
    expect(() => validateContentBlock({ type: "text" })).toThrowError(/text/);
    expect(() => validateContentBlock({ type: "tool-call", id: "c", name: "n" })).toThrowError(
      /arguments/,
    );
    expect(() => validateContentBlock("text")).toThrowError(/JSON object/);
    expect(() => validateContentBlock(null)).toThrowError(/JSON object/);
    expect(() => validateContentBlock([1, 2])).toThrowError(/JSON object/);
  });

  it("未知 type 宽松保留：不做字段校验、原引用返回", () => {
    // F01
    const exotic = { type: "future-block-2099", payload: { nested: true }, meta: [1, 2, 3] };
    expect(validateContentBlock(exotic)).toBe(exotic);
    const noType = { anything: "goes" };
    expect(validateContentBlock(noType)).toBe(noType);
  });

  it("未知 type 块经 message 事件 schema 后 JSON 往返 deep-equal 且引用不变", () => {
    // F01
    const block = { type: "custom", nested: { deep: [1, { x: null }] }, keep: "me" };
    const raw = queuedEvent({ id: "m1", targetId: TEAM_ID, content: [block] });
    const selected = selectTeamEvent(raw, TEAM_ID);
    expect(selected.kind).toBe("event");
    if (selected.kind !== "event") return;
    const content = selected.event.type === "team/message/queued" ? selected.event.message.content : [];
    expect(content[0]).toBe(block); // 原引用（含未声明字段）
    expect(JSON.parse(JSON.stringify(content[0]))).toEqual(block);
  });

  it("自有 __proto__ 键原样保留（JSON 往返相等）", () => {
    // F01：JSON.parse 产生的自有 __proto__ 属性不得被清洗或触发原型污染
    const block = JSON.parse('{"type":"text","text":"hi","__proto__":{"evil":1}}');
    expect(Object.getOwnPropertyNames(block)).toContain("__proto__");
    const raw = queuedEvent({ id: "m2", targetId: TEAM_ID, content: [block] });
    const selected = selectTeamEvent(raw, TEAM_ID);
    expect(selected.kind).toBe("event");
    if (selected.kind !== "event") return;
    const kept =
      selected.event.type === "team/message/queued" ? selected.event.message.content[0] : undefined;
    expect(kept).toBe(block);
    expect(JSON.parse(JSON.stringify(kept))).toEqual(block);
  });

  it("已废弃 tool-result 包装拒绝（V4 准入，进入邮箱状态前拦截）", () => {
    // F01
    expect(() => validateContentBlock({ type: "tool-result", result: "x" })).toThrowError(
      /tool-result/,
    );
    const raw = queuedEvent({
      id: "m3",
      targetId: TEAM_ID,
      content: [{ type: "tool-result", result: "x" }],
    });
    expect(selectTeamEvent(raw, TEAM_ID)).toEqual({
      kind: "invalid-payload",
      type: "team/message/queued",
    });
    expect(() => decodeTeamEvent("team/message/queued", raw)).toThrowError(
      "persisted Agent Teams team/message/queued payload is invalid",
    );
  });
});

describe("events · 两段 selector（C9 顺序）", () => {
  it("非 team/* 事件、非对象 → ignored", () => {
    // F01/F02 前置
    expect(selectTeamEvent({ type: "user/message", version: 2, teamId: TEAM_ID }, TEAM_ID)).toEqual({
      kind: "ignored",
    });
    expect(selectTeamEvent("noise", TEAM_ID)).toEqual({ kind: "ignored" });
    expect(selectTeamEvent([1], TEAM_ID)).toEqual({ kind: "ignored" });
    expect(selectTeamEvent({ type: "team/unknown-kind", version: 2, teamId: TEAM_ID }, TEAM_ID)).toEqual({
      kind: "ignored",
    });
  });

  it("teamId 不符 → ignored（先于 version 检查）", () => {
    // F02 口径：非本 team 事件忽略
    expect(
      selectTeamEvent({ ...memberEvent({ id: "a", name: "w" }, "sess-other"), version: 3 }, TEAM_ID),
    ).toEqual({ kind: "ignored" });
  });

  it("version≠2 → unsupported-version", () => {
    // F02
    const selected = selectTeamEvent(
      { ...memberEvent({ id: "a", name: "w" }), version: 3 },
      TEAM_ID,
    );
    expect(selected).toEqual({ kind: "unsupported-version", version: 3 });
  });

  it("version=2 但载荷非法 → invalid-payload", () => {
    const selected = selectTeamEvent(
      { ...memberEvent({ id: "a", name: "w" }), member: { id: "a" } },
      TEAM_ID,
    );
    expect(selected).toEqual({ kind: "invalid-payload", type: "team/member" });
  });
});

describe("events · id 宽松口径（B4，F07b）", () => {
  it.each([
    ["task-1", true],
    ["task-9007199254740991", true],
    ["team-message-2b7e0c64-9f16-4d5e", true],
    ["custom-unusual-id", true],
    ["task", true],
    ["task-", true],
    ["", false],
    ["task-99999999999999999999", false], // 后缀非 safe integer
  ])("isLooseIdValid(%j) = %s", (id, expected) => {
    // F07b
    expect(isLooseIdValid(id)).toBe(expected);
  });

  it("非常规但非空 task id 通过 schema 与重放（严格正则会误拒）", () => {
    // F07b
    const raw = taskEvent({ id: "sprint-3-final", revision: 1 });
    const selected = selectTeamEvent(raw, TEAM_ID);
    expect(selected.kind).toBe("event");
    expect(() => decodeTeamEvent("team/task", taskEvent({ id: "" }))).toThrowError(
      "persisted Agent Teams team/task payload is invalid",
    );
    expect(() =>
      decodeTeamEvent("team/task", taskEvent({ id: "task-99999999999999999999" })),
    ).toThrowError("persisted Agent Teams team/task payload is invalid");
  });

  it("message id 同样宽松（非空字符串；task-<n> 超界除外）", () => {
    // F07b
    expect(selectTeamEvent(queuedEvent({ id: "weird id with spaces", targetId: TEAM_ID }), TEAM_ID).kind).toBe(
      "event",
    );
    expect(
      selectTeamEvent(queuedEvent({ id: "task-99999999999999999999", targetId: TEAM_ID }), TEAM_ID).kind,
    ).toBe("invalid-payload");
  });
});

describe("events · 持久状态 strict schema（C9，F07b）", () => {
  const validState = {
    id: TEAM_ID,
    members: [memberSnapshot({ id: "a1", name: "worker", phase: "active" })],
    tasks: [taskSnapshot({ id: "task-1", revision: 2, status: "in_progress", ownerId: TEAM_ID })],
    messages: [messageSnapshot({ id: "m1", targetId: "a1" })],
    delivered: ["m1"],
    nextTaskNumber: 2,
  };

  it("合法持久状态通过；failure 可选", () => {
    // F07b
    expect(teamStateSchema.safeParse(validState).success).toBe(true);
    expect(
      teamStateSchema.safeParse({ ...validState, failure: "was queued twice" }).success,
    ).toBe(true);
  });

  it("多余字段/缺字段/类型不符拒绝", () => {
    // F07b
    expect(teamStateSchema.safeParse({ ...validState, extra: 1 }).success).toBe(false);
    const { delivered, ...noDelivered } = validState;
    expect(delivered).toBeDefined();
    expect(teamStateSchema.safeParse(noDelivered).success).toBe(false);
    expect(teamStateSchema.safeParse({ ...validState, nextTaskNumber: 0 }).success).toBe(false);
    expect(teamStateSchema.safeParse({ ...validState, nextTaskNumber: 1.5 }).success).toBe(false);
  });

  it("decodePersistedPayload 失败抛逐字消息", () => {
    // F07b
    expect(() =>
      decodePersistedPayload("team/member", memberEventSchema.shape.member, { id: "x" }),
    ).toThrowError("persisted Agent Teams team/member payload is invalid");
    expect(() =>
      decodePersistedPayload("team/state", teamStateSchema, { id: TEAM_ID, members: "nope" }),
    ).toThrowError("persisted Agent Teams team/state payload is invalid");
    expect(decodePersistedPayload("team/state", teamStateSchema, validState).id).toBe(TEAM_ID);
  });

  it("messageQueuedEventSchema 直接解析合法事件", () => {
    expect(messageQueuedEventSchema.safeParse(queuedEvent({ id: "m9", targetId: TEAM_ID })).success).toBe(
      true,
    );
  });
});
