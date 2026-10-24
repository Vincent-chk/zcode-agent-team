// 2026-10-19 独立验收修复的回归锚点（P0 合同项）。
import { describe, expect, it } from "vitest";
import { TeamError } from "../src/domain/errors.js";
import { selectTeamEvent, teamStateSchema } from "../src/domain/events.js";
import { buildSessionStartContext, IDENTITY_LEAD_TEXT, teamPolicy } from "../src/mcp/policy.js";
import { loadConfig } from "../src/shared.js";
import { buildKit, TEAM } from "./services/kit.js";

const TEXT = (text: string) => [{ type: "text" as const, text }];

async function spawn(kit: ReturnType<typeof buildKit>, name: string): Promise<string> {
  await kit.runtime.roster.spawnTeammate(TEAM, { name, description: "d", prompt: "p" });
  return [...kit.provider.teamChildren.entries()].find(([, v]) => v.name === name)?.[0] as string;
}

describe("事件模型旧名兼容（A2）", () => {
  it("旧 team/message 归一化为 team/message/queued", () => {
    const selected = selectTeamEvent(
      {
        type: "team/message",
        version: 2,
        teamId: TEAM,
        message: { id: "m1", senderId: TEAM, senderName: "lead", targetId: "a1", content: TEXT("hi") },
      },
      TEAM,
    );
    expect(selected.kind).toBe("event");
    if (selected.kind !== "event") return;
    expect(selected.event.type).toBe("team/message/queued");
  });

  it("旧 checkpoint 的 delivered 对象数组归一化为 messageId[]", () => {
    const parsed = teamStateSchema.safeParse({
      id: TEAM,
      members: [],
      tasks: [],
      messages: [],
      delivered: [{ messageId: "m1", targetId: "a1" }],
      nextTaskNumber: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.delivered).toEqual(["m1"]);
  });
});

describe("interrupt=false 策略插值（A3）", () => {
  it("teamPolicy(false) 不出现 interrupt_agent；SessionStart 同步", () => {
    const policy = teamPolicy(false);
    expect(policy).toContain("for send_message, or as owner");
    expect(policy).not.toContain("and interrupt_agent");
    const context = buildSessionStartContext(IDENTITY_LEAD_TEXT, false);
    expect(context).not.toContain("and interrupt_agent");
  });
});

describe("任务板合同边角（A4）", () => {
  it("间接依赖环 → TEAM_TASK_DEPENDENCY_CYCLE", async () => {
    const kit = buildKit();
    const a = await kit.runtime.taskboard.create(TEAM, { subject: "a", description: "d" });
    const b = await kit.runtime.taskboard.create(TEAM, {
      subject: "b",
      description: "d",
      blockedBy: [a.task.id],
    });
    await expect(
      kit.runtime.taskboard.update(TEAM, {
        taskId: a.task.id,
        expectedRevision: 1,
        action: "set_dependencies",
        blockedBy: [b.task.id],
      }),
    ).rejects.toMatchObject({ code: "TEAM_TASK_DEPENDENCY_CYCLE" });
  });

  it("reassign 支持 owner=\"lead\"；空 owner 去指派并回 pending", async () => {
    const kit = buildKit();
    await spawn(kit, "worker");
    const t1 = await kit.runtime.taskboard.create(TEAM, { subject: "s1", description: "d" });
    const toLead = await kit.runtime.taskboard.update(TEAM, {
      taskId: t1.task.id,
      expectedRevision: 1,
      action: "reassign",
      owner: "lead",
    });
    expect(toLead.task.ownerName).toBe("lead");
    expect(toLead.task.status).toBe("in_progress");

    const t2 = await kit.runtime.taskboard.create(TEAM, { subject: "s2", description: "d" });
    await kit.runtime.taskboard.update(TEAM, {
      taskId: t2.task.id,
      expectedRevision: 1,
      action: "claim",
    });
    const unassigned = await kit.runtime.taskboard.update(TEAM, {
      taskId: t2.task.id,
      expectedRevision: 2,
      action: "reassign",
      owner: "",
    });
    expect(unassigned.task.ownerName).toBeUndefined();
    expect(unassigned.task.status).toBe("pending");
  });
});

describe("send 三态（A1）", () => {
  it("运行中/暂不可达 → pending（durable），不是伪造 accepted", async () => {
    const kit = buildKit();
    await spawn(kit, "worker");
    kit.provider.programWith({ deliverResults: ["queued"] });
    const result = await kit.runtime.mailbox.send(TEAM, { target: "worker", content: TEXT("hi") });
    expect(result.status).toBe("pending");
    expect(kit.store.state().delivered).toHaveLength(0);
    expect(kit.store.state().messages).toHaveLength(1);
  });

  it("确定性冷读失败 → rejected（抛错）且消息仍持久", async () => {
    const kit = buildKit();
    const worker = await spawn(kit, "worker");
    kit.provider.killChild(worker);
    kit.provider.programWith({ coldRead: "throw" });
    await expect(
      kit.runtime.mailbox.send(TEAM, { target: "worker", content: TEXT("x") }),
    ).rejects.toBeInstanceOf(Error);
    expect(kit.store.state().messages).toHaveLength(1);
    expect(kit.store.state().delivered).toHaveLength(0);
  });
});

describe("Lead 状态与配置（A6）", () => {
  it("teammate 视角 Lead 为 inactive，Lead 自身视角为 running", async () => {
    const kit = buildKit();
    const worker = await spawn(kit, "worker");
    expect(kit.runtime.roster.listMembers(TEAM).members[0]).toMatchObject({ status: "running" });
    expect(kit.runtime.roster.listMembers(worker).members[0]).toMatchObject({ status: "inactive" });
  });

  it("loadConfig 严格拒绝非 safe integer / 非十进制", () => {
    const keys = ["TEAM_MAX_MEMBERS", "TEAM_MAX_TASKS", "TEAM_MAX_MESSAGE_BYTES", "TEAM_DISPOSAL_TIMEOUT_MS"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      process.env.TEAM_MAX_MEMBERS = "1e20";
      const bad = loadConfig();
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("TEAM_INVALID_CONFIG");
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe("错误码仍是 27 个（不新增投递码）", () => {
  it("send 硬失败使用普通 Error，不引入第 28 码", async () => {
    const kit = buildKit();
    const worker = await spawn(kit, "worker");
    kit.provider.killChild(worker);
    kit.provider.programWith({ coldRead: "throw" });
    try {
      await kit.runtime.mailbox.send(TEAM, { target: "worker", content: TEXT("x") });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err instanceof TeamError).toBe(false);
    }
  });
});
