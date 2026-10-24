// Mailbox 服务测试（02 §6；F15–F21 + B6/C4/C10；〔对齐轮修订 2026-10-17〕直投口径：send 返回 { messageId }，无 status、无 MAILBOX_FULL）。
import { describe, expect, it } from "vitest";
import { TeamError } from "../../src/domain/errors.js";
import type { ContentBlock } from "../../src/domain/events.js";
import { frameMessage } from "../../src/domain/mailbox.js";
import { buildKit, TEAM } from "../services/kit.js";

const LEAD = TEAM;
const TEXT = (text: string): ContentBlock[] => [{ type: "text", text }];

async function spawnMember(kit: ReturnType<typeof buildKit>, name: string): Promise<string> {
  const { member } = await kit.runtime.roster.spawnTeammate(LEAD, { name, description: "d", prompt: "p" });
  void member;
  return [...kit.provider.teamChildren.keys()].find(
    (id) => kit.provider.teamChildren.get(id)?.name === name,
  ) as string;
}

function expectTeamError(p: Promise<unknown>, code: string, message: string): Promise<void> {
  return p.then(
    () => Promise.reject(new Error(`expected TeamError ${code}`)),
    (err: unknown) => {
      expect(err).toBeInstanceOf(TeamError);
      expect((err as TeamError).code).toBe(code);
      expect((err as TeamError).message).toBe(message);
      return Promise.resolve();
    },
  );
}

describe("Mailbox · send 校验与顺序（F15）", () => {
  it("未知目标 / 自发 / 超限 → 逐字，且先于任何落盘", async () => {
    const kit = buildKit({ limits: { maxMessageBytes: 200 } });
    const worker = await spawnMember(kit, "worker");
    await expectTeamError(
      kit.runtime.mailbox.send(LEAD, { target: "ghost", content: TEXT("x") }),
      "TEAM_MEMBER_NOT_FOUND",
      'active teammate "ghost" not found',
    );
    await expectTeamError(
      kit.runtime.mailbox.send(LEAD, { target: "lead", content: TEXT("x") }),
      "TEAM_SELF_MESSAGE",
      "a Team member cannot message itself",
    );
    await expectTeamError(
      kit.runtime.mailbox.send(worker, { target: "worker", content: TEXT("x") }),
      "TEAM_SELF_MESSAGE",
      "a Team member cannot message itself",
    );
    // 超限：frame JSON > 200B
    await expectTeamError(
      kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("x".repeat(300)) }),
      "TEAM_MESSAGE_TOO_LARGE",
      "team message exceeds 200 bytes",
    );
    expect(kit.store.state().messages).toHaveLength(0); // 以上全部未落盘
    // 〔对齐轮〕0.2.1 删除 pending 上限：目标冷 + 无记录（保守 queued）下连续发送不再有 full 拒绝
    kit.provider.killChild(worker);
    const first = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("hi") });
    expect(first.messageId).toMatch(/^team-message-/);
    const second = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("hi2") });
    expect(second.messageId).not.toBe(first.messageId);
    expect(kit.store.state().messages).toHaveLength(2); // 无上限拦截，全部滞留 pending
  });

  it("pending 落盘 flush 先于任何投递尝试（B6：tryDispatch 事务回调内同步发起）", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    const order: string[] = [];
    const off = kit.store.onCommit((_seq, state) => {
      order.push(`commit:messages=${state.messages.length}`);
      if (state.messages.length === 1) off();
    });
    const result = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("x") });
    expect(order).toEqual(["commit:messages=1"]); // 落盘先于投递（deliver 在 commit 之后才开始）
    expect(result.messageId).toMatch(/^team-message-/);
    expect(kit.store.state().delivered).toHaveLength(1);
  });
});

describe("Mailbox · 框架化与字节计量（F16）", () => {
  it("framed 首块逐字（〔对齐轮〕无消息 id）+ 原内容块顺序不变；字节计量含框架", async () => {
    const kit = buildKit();
    await spawnMember(kit, "worker");
    const content: ContentBlock[] = [
      { type: "text", text: "第一块" },
      { type: "text", text: "second" },
    ];
    const { messageId } = await kit.runtime.mailbox.send(LEAD, { target: "worker", content });
    // 从 store 取消息核实原文顺序不变
    const message = kit.store.state().messages[0];
    expect(message.id).toBe(messageId);
    expect(message.content).toEqual(content); // 原文顺序不变
    // framed 首块：0.2.1 逐字（无 id），其后内容块顺序不变
    const framed = frameMessage(message);
    expect(framed[0]).toEqual({ type: "text", text: "Team message from lead:" });
    expect(framed.slice(1)).toEqual(content);
  });

  it("字节计量含框架：framed JSON 总字节恰好压线", async () => {
    // 〔对齐轮〕框架已无消息 id → 字节可精确预计算（不再依赖固定 id）
    const content = TEXT("payload");
    const framedBytes = new TextEncoder().encode(
      JSON.stringify([{ type: "text", text: "Team message from lead:" }, ...content]),
    ).length;
    // 恰好等于 framed 字节 → 通过（> 才拒绝）
    const kit = buildKit({ limits: { maxMessageBytes: framedBytes } });
    await spawnMember(kit, "worker");
    const ok = await kit.runtime.mailbox.send(LEAD, { target: "worker", content });
    expect(ok.messageId).toMatch(/^team-message-/);
    expect(kit.store.state().messages).toHaveLength(1);
    // 差 1 字节 → 拒绝（逐字）
    const kit2 = buildKit({ limits: { maxMessageBytes: framedBytes - 1 } });
    await spawnMember(kit2, "worker");
    await expectTeamError(
      kit2.runtime.mailbox.send(LEAD, { target: "worker", content }),
      "TEAM_MESSAGE_TOO_LARGE",
      `team message exceeds ${framedBytes - 1} bytes`,
    );
  });
});

describe("Mailbox · 投递分支矩阵（F17）", () => {
  it("Lead 存活 steer：steerLead 收到 framed + source；delivered 落盘", async () => {
    const kit = buildKit();
    const steered: Array<{ framed: ContentBlock[]; source: unknown }> = [];
    kit.runtime.close();
    // 重搭一个带 steerLead 的 runtime（同 store/provider）
    const { TeamRuntime } = await import("../../src/domain/runtime.js");
    const runtime2 = new TeamRuntime({
      teamId: TEAM,
      store: kit.store,
      provider: kit.provider,
      limits: kit.limits,
      presentation: kit.provider,
      steerLead: (framed, source) => steered.push({ framed, source }),
    });
    const worker = await spawnMember({ ...kit, runtime: runtime2 }, "worker");
    await runtime2.mailbox.send(worker, { target: "lead", content: TEXT("to lead") });
    expect(steered).toHaveLength(1);
    expect(steered[0].source).toEqual({ kind: "agent-message", form: "relay", senderSessionId: worker });
    const framedFirst = steered[0].framed[0] as unknown as { type: string; text: string };
    expect(framedFirst.type).toBe("text");
    expect(framedFirst.text).toBe("Team message from worker:"); // 〔对齐轮〕0.2.1 逐字（无 id）
    expect(kit.store.state().delivered).toHaveLength(1);
  });

  it("存活已含 → 仅补 delivered（deliver 不再调用）", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("m1") });
    const firstDeliverCalls = kit.provider.deliverCalls;
    // 模拟「已收、delivered 未记」：直接删 delivered 事件级记录（保留 mock received）
    kit.store.testMutate((s) => ({ ...s, delivered: [] }));
    const redrive = await kit.runtime.mailbox.recoverFor("all");
    void redrive;
    expect(kit.provider.deliverCalls).toBe(firstDeliverCalls); // 去重路径：无第二次投递
    expect(kit.store.state().delivered).toHaveLength(1); // delivered 补记
  });

  it("存活未含 → deliver；冷+已记录 → markDelivered；冷+未记录 → 冷拉起；冷读失败 → 滞留 + C4 警告逐字", async () => {
    // 存活未含
    const k1 = buildKit();
    const w1 = await spawnMember(k1, "worker");
    await k1.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("a") });
    expect(k1.provider.deliverCalls).toBe(1);
    expect(k1.store.state().delivered).toHaveLength(1);

    // 冷 + 未记录：投递成功后杀成员（received 已在冷记录里）
    k1.provider.killChild(w1);
    const s2 = await k1.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("b") });
    expect(k1.provider.deliverCalls).toBe(2); // 冷读：record 存在但不含 b → 冷拉起尝试（默认保守）
    expect(k1.store.state().delivered).toHaveLength(1); // b 未记
    // 冷 + 已记录（把 b 手工标记 received 后重投；冷拉起尝试已计 1 次 deliver）
    const callsAfterColdAttempt = k1.provider.deliverCalls; // = 2（a + b 的冷拉起尝试）
    k1.provider.markReceived(w1, s2.messageId);
    await k1.runtime.mailbox.recoverFor("all");
    expect(k1.store.state().delivered).toHaveLength(2); // markDelivered 补记
    expect(k1.provider.deliverCalls).toBe(callsAfterColdAttempt); // 已记录路径：未再次 deliver

    // 冷 + 未记录 → 冷拉起 accepted
    const k2 = buildKit();
    const w2 = await spawnMember(k2, "worker");
    k2.provider.killChild(w2);
    k2.provider.programWith({ coldDeliverOutcome: "accepted" });
    const s3 = await k2.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("c") });
    expect(s3.messageId).toMatch(/^team-message-/);
    expect(k2.store.state().delivered).toHaveLength(1);

    // 冷读失败 → 滞留 + 警告逐字（C4）
    const k3 = buildKit();
    const w3 = await spawnMember(k3, "worker");
    k3.provider.killChild(w3);
    k3.provider.programWith({ coldRead: "throw" });
    // 硬失败：工具面必须得到错误，而不是 {sent:true}；但消息仍持久 pending，恢复可重试。
    await expect(
      k3.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("d") }),
    ).rejects.toThrow(`team message could not be delivered to "worker": mock cold read failure for ${w3}`);
    expect(
      k3.warnings.some((w) => w === `cannot read Team message target "${w3}": mock cold read failure for ${w3}`),
    ).toBe(true);
    expect(k3.store.state().messages).toHaveLength(1); // 未丢
    expect(k3.store.state().delivered).toHaveLength(0); // 未记
  });

  it("C10：请求消息已被并发投递 → dispatchThrough 短路（不二次投递、不报错）", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    kit.provider.programWith({ deliverDelayMs: 60 });
    const sendPromise = kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("race") });
    await new Promise((r) => setTimeout(r, 10)); // pending 已落盘，投递进行中
    // 并发路径把该消息直接记为 delivered（外部等价钩子）
    const message = kit.store.state().messages[0];
    await kit.store.append({
      type: "team/message/delivered",
      version: 2,
      teamId: TEAM,
      messageId: message.id,
      targetId: worker,
    });
    const result = await sendPromise;
    expect(result.messageId).toBe(message.id); // 短路：按已投递处理，无错误
    expect(kit.store.state().delivered).toHaveLength(1); // 无重复 delivered
    expect(kit.provider.deliverCalls).toBe(1); // 无第二次投递
  });
});

describe("Mailbox · 恰一次（F18）与恢复重试（F20）", () => {
  it("恰一次：kill 注入「目标已收、delivered 未记」→ 恢复后补记 delivered、无第二次交付", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    const sent = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("m") });
    expect(kit.provider.deliverCalls).toBe(1);
    expect(kit.store.state().delivered).toHaveLength(1);
    const child = kit.provider.teamChildren.get(worker);
    expect(child?.deliverCount.get(sent.messageId)).toBe(1); // 已收（received 标记）
    // === kill 点：抹去 delivered 记录（崩溃于「收后认前」），成员转冷 ===
    kit.store.testMutate((s) => ({ ...s, delivered: [] }));
    kit.provider.killChild(worker);
    // === 恢复：成员重启（revive）+ 冷启动恢复对账重投 ===
    kit.provider.reviveChild(worker);
    await kit.runtime.mailbox.recoverFor(worker);
    expect(kit.provider.deliverCalls).toBe(1); // 恰一次：未第二次 deliver
    expect(kit.store.state().delivered).toHaveLength(1); // delivered 补记
    expect(kit.provider.teamChildren.get(worker)?.deliverCount.get(sent.messageId)).toBe(1);
  });

  it("回执观察（F20）：外部目标会话事件 → checkpointDelivered 补记", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    // 构造滞留消息（目标冷 + 保守 queued）
    kit.provider.killChild(worker);
    const sent = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("m") });
    expect(kit.store.state().delivered).toHaveLength(0); // 滞留
    // 外部信号：目标已持久接收（等价 session/event 钩子）
    kit.provider.markReceived(worker, sent.messageId);
    await kit.runtime.mailbox.observeDelivery(worker, sent.messageId);
    expect(kit.store.state().delivered).toHaveLength(1);
  });

  it("成员启动重投其 pending；Lead 启动重投全量（F20）；队列序保持", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    kit.provider.killChild(worker);
    const s1 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("one") });
    const s2 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("two") });
    expect(kit.store.state().delivered).toHaveLength(0); // 两条均滞留
    // 成员启动 → 重投（冷拉起 accepted）
    kit.provider.programWith({ coldDeliverOutcome: "accepted" });
    kit.provider.reviveChild(worker);
    await kit.runtime.mailbox.recoverFor(worker);
    const state = kit.store.state();
    expect(state.delivered).toHaveLength(2);
    // 队列序：one 先于 two
    expect(state.delivered).toEqual([s1.messageId, s2.messageId]);
    // Lead 启动 → 全量（worker→lead：Lead 进程内恒可达）
    const s3 = await kit.runtime.mailbox.send(worker, { target: "lead", content: TEXT("three") });
    expect(kit.store.state().delivered).toContain(s3.messageId);
    // F19（对齐轮口径）：同内容新 id 允许（无重发去重）
    const s4 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("one") });
    expect(s4.messageId).not.toBe(s1.messageId);
    expect(kit.store.state().delivered).toContain(s4.messageId);
  });

  it("前序失败即整体滞留（乱序完成注入下保队列序）", async () => {
    const kit = buildKit();
    const worker = await spawnMember(kit, "worker");
    kit.provider.programWith({ deliverResults: ["queued", "queued"] }); // 前序（one）持续 queued
    const s1 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("one") });
    const s2 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: TEXT("two") });
    expect(kit.store.state().delivered).toHaveLength(0); // 前序失败 → 本条整体滞留
    // 前序恢复（accepted×2）→ 两条按序补投
    kit.provider.programWith({ deliverResults: ["accepted", "accepted"] });
    await kit.runtime.mailbox.recoverFor(worker);
    expect(kit.store.state().delivered).toEqual([s1.messageId, s2.messageId]);
  });
});
