// 第四轮 A2/A1 进程内测试：真实装配（host + 方法表 + client）的参数口径、错误路径、
// 优雅接任（干净释放 → tryPromote 立即成功）、close 聚合错误。数据根 os.tmpdir()。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamCoordinatorHost } from "../../../src/coord/host.js";
import { TeamClient, isCoordinatorUnavailable } from "../../../src/coord/client.js";
import { teamMethodNames, WAIT_AGENT_GRACE_MS } from "../../../src/coord/methods.js";
import { load } from "../../../src/coord/replay.js";
import { TeamError } from "../../../src/domain/errors.js";

const TEAM = "sess_real_host_lead";

let root: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-host-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function openHost(teamId = TEAM): Promise<TeamCoordinatorHost> {
  return TeamCoordinatorHost.open({ dataRoot: root, teamId });
}

async function expectTeamError(p: Promise<unknown>, code: string, message: string): Promise<void> {
  try {
    await p;
    expect.unreachable(`expected TeamError ${code}`);
  } catch (err) {
    expect(err, `code ${code}`).toBeInstanceOf(TeamError);
    const te = err as TeamError;
    expect(te.code).toBe(code);
    expect(te.message).toBe(message);
  }
}

describe("真实装配 · 方法表口径（进程内直执行路径）", () => {
  it("方法名清单 = 接口草案 §2 终版方法表 + stage-4 mailbox.ack + stage-8 member.set_model（14 方法）", async () => {
    const host = await openHost();
    try {
      const table = host.methodTable;
      expect(table).not.toBeNull();
      const names = table === null ? [] : teamMethodNames(table);
      expect(names).toEqual([
        "coordinator.hello",
        "member.claim",
        "member.spawn",
        "member.set_model",
        "member.interrupt",
        "message.send",
        "mailbox.ack",
        "task.create",
        "task.update",
        "task.list",
        "task.get",
        "board.read",
        "wait.agent",
        "admin.reconcile",
      ]);
      expect(table?.get("wait.agent")?.timeoutMs).toBe(3_600_000 + WAIT_AGENT_GRACE_MS);
      expect(table?.get("member.set_model")?.timeoutMs).toBe(60_000);
    } finally {
      await host.close();
    }
  });

  it("hello/claim/board.read/spawn/send happy path + 身份口径", async () => {
    const host = await openHost();
    try {
      const hello = (await host.dispatch("coordinator.hello", { teamId: TEAM, session_id: "x" })) as {
        coordinatorBootId: string;
        stateRevision: number;
      };
      expect(typeof hello.coordinatorBootId).toBe("string");
      expect(hello.stateRevision).toBe(0);

      await expect(host.dispatch("member.claim", { session_id: TEAM })).resolves.toEqual({ role: "lead" });
      await expectTeamError(
        host.dispatch("member.claim", { session_id: "sess-bogus" }),
        "TEAM_NOT_MEMBER",
        'agent "sess-bogus" is not a member of an active Agent Team',
      );
      // 写入类缺 session_id → TEAM_INVALID_ARGUMENT（冻结口径）
      await expectTeamError(
        host.dispatch("task.create", { subject: "s", description: "d" }),
        "TEAM_INVALID_ARGUMENT",
        'task.create param "session_id" is required',
      );

      const spawn = (await host.dispatch("member.spawn", {
        session_id: TEAM,
        name: "worker",
        description: "d",
        prompt: "p",
      })) as { member: { target: string; status: string } };
      expect(spawn.member.target).toBe("worker");
      expect(spawn.member.status).toBe("running"); // MockProvider availability 呈现（§5.5）

      const board = (await host.dispatch("board.read", {})) as {
        revision: number;
        view: { members: Array<{ id: string; name: string }>; tasks: unknown[] };
      };
      expect(board.view.members.map((m) => m.name)).toEqual(["lead", "worker"]);
      expect(board.revision).toBeGreaterThan(0);

      const send = (await host.dispatch("message.send", {
        session_id: TEAM,
        targetName: "worker",
        content: [{ type: "text", text: "hi" }],
      })) as { messageId: string };
      expect(send.messageId).toMatch(/^team-message-/); // 〔对齐轮〕0.2.1 无 status 字段
    } finally {
      await host.close();
    }
  });

  it("member.set_model：Lead-only / 参数守卫 / 目标校验 / MockProvider 返回五分支", async () => {
    const teamId = "sess_set_model_lead";
    const host = await openHost(teamId);
    try {
      await host.dispatch("member.spawn", { session_id: teamId, name: "worker", description: "d", prompt: "p" });
      await expectTeamError(
        host.dispatch("member.set_model", {
          session_id: "sess-intruder",
          member_id: "worker",
          modelSelection: { providerId: "p", modelId: "m" },
        }),
        "TEAM_LEAD_REQUIRED",
        "only the Team Lead can change teammate models",
      );
      await expectTeamError(
        host.dispatch("member.set_model", { session_id: teamId, member_id: "worker" }),
        "TEAM_INVALID_ARGUMENT",
        'member.set_model requires "modelSelection" or "thoughtLevel"',
      );
      await expectTeamError(
        host.dispatch("member.set_model", {
          session_id: teamId,
          member_id: "worker",
          modelSelection: { providerId: "p" },
        }),
        "TEAM_INVALID_ARGUMENT",
        'member.set_model param "modelSelection" must be an object with providerId and modelId',
      );
      await expectTeamError(
        host.dispatch("member.set_model", {
          session_id: teamId,
          member_id: "ghost",
          modelSelection: { providerId: "p", modelId: "m" },
        }),
        "TEAM_MEMBER_NOT_FOUND",
        'active teammate "ghost" not found',
      );
      await expect(
        host.dispatch("member.set_model", {
          session_id: teamId,
          member_id: "worker",
          modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
        }),
      ).resolves.toEqual({ applied: "now" });
    } finally {
      await host.close();
    }
  });

  it("参数守卫错误抽样（27 码透传 + INVALID_ARGUMENT 口径）", async () => {
    const host = await openHost();
    try {
      await expectTeamError(
        host.dispatch("member.spawn", { session_id: TEAM, name: "w", description: "d" }),
        "TEAM_INVALID_ARGUMENT",
        'member.spawn param "prompt" must be a string',
      );
      await expectTeamError(
        host.dispatch("member.spawn", { session_id: TEAM, name: "w", description: "d", prompt: "p", context: "hot" }),
        "TEAM_INVALID_ARGUMENT",
        'member.spawn param "context" must be one of fresh, fork',
      );
      await expectTeamError(
        host.dispatch("message.send", { session_id: TEAM, targetName: "worker", content: "not-array" }),
        "TEAM_INVALID_ARGUMENT",
        'message.send param "content" must be an array of content blocks',
      );
      await expectTeamError(
        host.dispatch("task.update", { session_id: TEAM, taskId: "task-1", expectedRevision: 1, action: "explode" }),
        "TEAM_INVALID_ARGUMENT",
        "task.update param \"action\" must be one of claim, release, edit, set_dependencies, complete, reopen, reassign, delete",
      );
      await expectTeamError(
        host.dispatch("task.update", { session_id: TEAM, taskId: "task-1", expectedRevision: 1.5, action: "claim" }),
        "TEAM_INVALID_ARGUMENT",
        'task.update param "expectedRevision" must be a safe integer',
      );
      await expectTeamError(
        host.dispatch("wait.agent", { session_id: TEAM, timeoutMs: 5_000 }),
        "TEAM_INVALID_TIMEOUT",
        "timeoutMs must be an integer from 10000 through 3600000",
      );
      // teamId 错队 = 传输级路由自检（非域错误码）
      await expect(host.dispatch("coordinator.hello", { teamId: "sess-other" })).rejects.toThrow(
        /targets team "sess-other" but this coordinator serves/,
      );
      await expect(host.dispatch("no.such.method")).rejects.toThrow("unknown rpc method: no.such.method");
    } finally {
      await host.close();
    }
  });
});

describe("真实装配 · 全方法 happy（进程内，补 socket 演练不计的覆盖率）", () => {
  it("interrupt/task.update/list/get/wait.agent/admin.reconcile 逐方法直执行", async () => {
    const teamId = "sess_full_methods";
    const host = await openHost(teamId);
    try {
      await host.dispatch("member.spawn", { session_id: teamId, name: "worker", description: "d", prompt: "p" });
      const board = (await host.dispatch("board.read", {})) as {
        view: { members: Array<{ id: string; name: string }> };
      };
      const workerId = board.view.members.find((m) => m.name === "worker")?.id as string;

      await host.dispatch("task.create", { session_id: teamId, subject: "初始任务", description: "d" });
      await expect(host.dispatch("member.interrupt", { session_id: teamId, name: "worker" })).resolves.toEqual({
        previousStatus: "running",
      });
      await expect(
        host.dispatch("task.update", { session_id: workerId, taskId: "task-1", expectedRevision: 1, action: "claim" }),
      ).resolves.toMatchObject({ task: { ownerName: "worker", revision: 2 } });
      await expect(
        host.dispatch("task.update", {
          session_id: teamId,
          taskId: "task-1",
          expectedRevision: 2,
          action: "edit",
          subject: "改题",
          description: "改描述",
          blockedBy: [],
          writeScopes: [],
        }),
      ).resolves.toMatchObject({ task: { subject: "改题", revision: 3 } });
      await expect(
        host.dispatch("task.list", { session_id: teamId, status: "in_progress", owner: "worker", cursor: 0, limit: 10 }),
      ).resolves.toMatchObject({ tasks: [expect.objectContaining({ id: "task-1" })] });
      await expect(host.dispatch("task.get", { session_id: teamId, taskId: "task-1" })).resolves.toMatchObject({
        task: { id: "task-1" },
      });

      // wait.agent：等待中被提交唤醒 → {timedOut:false}
      const waiting = host.dispatch("wait.agent", { session_id: teamId, timeoutMs: 10_000 }) as Promise<{ timedOut: boolean }>;
      await new Promise((resolve) => setTimeout(resolve, 60));
      await host.dispatch("task.create", { session_id: teamId, subject: "wake", description: "d" });
      await expect(waiting).resolves.toEqual({ timedOut: false });
      await expect(host.dispatch("task.list", { session_id: teamId, ready: true })).resolves.toMatchObject({
        tasks: [expect.objectContaining({ subject: "wake" })], // 无 blocker 的 pending 任务 ready=true
      });

      await expect(host.dispatch("admin.reconcile", { teamId })).resolves.toEqual({ orphans: [], settled: [] });
    } finally {
      await host.close();
    }
  });

  it("代理 dispatch 经 socket 到他者协调者；协调者消失且不接任 → 缺位窗口错误", async () => {
    const teamId = "sess_proxy_dispatch";
    const host1 = await openHost(teamId);
    const host2 = await TeamCoordinatorHost.open({ dataRoot: root, teamId, autoTakeover: false });
    expect(host2.currentMode).toBe("proxy");
    expect(host2.methodTable).toBeNull();
    // 代理模式 → 经 socket 写入 host1（真方法）
    await expect(host2.dispatch("task.create", { session_id: teamId, subject: "via-socket", description: "d" })).resolves.toMatchObject({
      task: { id: "task-1" },
    });
    const info = await host2.readyInfo();
    expect(info.mode).toBe("proxy");
    expect(info.socketPath).toBeUndefined();
    expect(typeof host2.coordinatorBootId).toBe("string");

    await host1.close();
    // 不接任（autoTakeover=false）→ 缺位窗口可读错误
    await expect(host2.dispatch("task.create", { session_id: teamId, subject: "x", description: "d" })).rejects.toThrow(
      "Agent Teams coordinator is unavailable (between coordinators); retry the request shortly",
    );
    await host2.close();
  });

  it("非 presentation provider（无 statusOf/modelOf）→ 装配仍可用（呈现回退链）", async () => {
    const teamId = "sess_plain_provider";
    const { MockProvider } = await import("../../../src/provider/mock-provider.js");
    const full = new MockProvider();
    // 委托式窄面：剥离 presentation（statusOf/modelOf）的等价 provider
    const plain = {
      startContinuable: full.startContinuable.bind(full),
      deliver: full.deliver.bind(full),
      interrupt: full.interrupt.bind(full),
      drain: full.drain.bind(full),
      readProvisioningRecord: full.readProvisioningRecord.bind(full),
      isAlive: full.isAlive.bind(full),
      containsMessage: full.containsMessage.bind(full),
      readColdRecord: full.readColdRecord.bind(full),
    };
    const host = await TeamCoordinatorHost.open({ dataRoot: root, teamId, provider: plain });
    try {
      const spawn = (await host.dispatch("member.spawn", {
        session_id: teamId,
        name: "w",
        description: "d",
        prompt: "p",
      })) as { member: { target: string } };
      expect(spawn.member.target).toBe("w");
    } finally {
      await host.close();
    }
  });
});

describe("降级服务 · failure 日志冷启动（G1/G2 回归：C5 在 wire 全量成立）", () => {
  it("失败日志上协调者照常 serve；成员调用逐方法 TEAM_NOT_MEMBER；board.read 排障视角可见 failure", async () => {
    const teamId = "sess_degraded_lead";
    // 1) 健康建态（1 成员 + 1 任务）→ 关闭（释放锁）
    const host1 = await openHost(teamId);
    await host1.dispatch("member.spawn", { session_id: teamId, name: "worker", description: "d", prompt: "p" });
    await host1.dispatch("task.create", { session_id: teamId, subject: "before", description: "d" });
    await host1.close();

    // 2) 直写非法事件（等价 team-ctl inject-event：绕过 journal 不变量）
    const teamDir = under(under(root, "teams"), teamId);
    const eventsFile = path.join(teamDir, "events.jsonl");
    const lines = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.length > 0);
    const bad = JSON.stringify({
      seq: lines.length + 1,
      ts: new Date().toISOString(),
      writer: "test:inject",
      event: {
        type: "team/member",
        version: 2,
        teamId,
        member: { id: "ghost", name: "ghost", description: "inj", provider: "spawn", context: "fresh", phase: "active" },
      },
    });
    fs.appendFileSync(eventsFile, bad + "\n");

    // 3) 冷启动：降级服务照常 serve（G2：修复前 recoverAll 抛穿 → 协调者启动即死）
    const warnings: string[] = [];
    const host2 = await TeamCoordinatorHost.open({ dataRoot: root, teamId, warn: (m) => warnings.push(m) });
    try {
      const failure = 'teammate "ghost" must begin provisioning';
      const info = await host2.readyInfo();
      expect(info.mode).toBe("coordinator");
      expect(info.failure).toBe(failure);
      expect(host2.degradedFailure).toBe(failure);
      expect(warnings.some((w) => w.includes("degraded mode") && w.includes(failure))).toBe(true);

      // 4) C5：一切成员身份调用 TEAM_NOT_MEMBER（G1 修复面：member.claim / board.read 带 session_id）
      const notMember = (id: string) => `agent "${id}" is not a member of an active Agent Team`;
      await expectTeamError(host2.dispatch("member.claim", { session_id: teamId }), "TEAM_NOT_MEMBER", notMember(teamId));
      await expectTeamError(host2.dispatch("member.claim", { session_id: "sess-anyone" }), "TEAM_NOT_MEMBER", notMember("sess-anyone"));
      await expectTeamError(host2.dispatch("board.read", { session_id: teamId }), "TEAM_NOT_MEMBER", notMember(teamId));
      await expectTeamError(
        host2.dispatch("task.create", { session_id: teamId, subject: "s", description: "d" }),
        "TEAM_NOT_MEMBER",
        notMember(teamId),
      );
      await expectTeamError(
        host2.dispatch("message.send", { session_id: teamId, targetName: "worker", content: [{ type: "text", text: "x" }] }),
        "TEAM_NOT_MEMBER",
        notMember(teamId),
      );
      await expectTeamError(
        host2.dispatch("member.spawn", { session_id: teamId, name: "w2", description: "d", prompt: "p" }),
        "TEAM_NOT_MEMBER",
        notMember(teamId),
      );
      await expectTeamError(host2.dispatch("task.list", { session_id: teamId }), "TEAM_NOT_MEMBER", notMember(teamId));
      await expectTeamError(
        host2.dispatch("wait.agent", { session_id: teamId, timeoutMs: 10_000 }),
        "TEAM_NOT_MEMBER",
        notMember(teamId),
      );

      // 5) 排障视角（不带 session_id，已登记适配项）：failure 视图原样可见，视图=最后有效状态
      const board = (await host2.dispatch("board.read", {})) as {
        revision: number;
        view: { failure?: string; tasks: Array<{ id: string }>; members: Array<{ name: string }> };
      };
      expect(board.view.failure).toBe(failure);
      expect(board.view.tasks.map((t) => t.id)).toEqual(["task-1"]);
      expect(board.view.members.map((m) => m.name)).toEqual(["lead", "worker"]);

      // 6) admin.reconcile 降级态诚实报错（不静默假装成功）
      await expect(host2.dispatch("admin.reconcile", {})).rejects.toThrow(failure);
    } finally {
      await host2.close();
    }
  });
});

describe("真实装配 · 代理路径与接任（进程内干净释放）", () => {
  it("host1 持锁 → host2 代理模式 → host1.close() → tryPromote 立即晋升 → 写入继续", async () => {
    const teamId = "sess_promote_team";
    const host1 = await openHost(teamId);
    await host1.dispatch("task.create", { session_id: teamId, subject: "before", description: "d" });
    const host2 = await TeamCoordinatorHost.open({ dataRoot: root, teamId, autoTakeover: false });
    expect(host2.currentMode).toBe("proxy");
    // 代理模式读 = 本地重放（权威盘面）
    const board2 = await host2.readBoard();
    expect(board2.seq).toBe(1);
    expect(board2.view.tasks.map((t) => t.subject)).toEqual(["before"]);
    await host1.close();

    expect(await host2.tryPromote()).toBe(true);
    expect(host2.currentMode).toBe("coordinator");
    // 晋升后写入继续 + 状态连续
    await host2.dispatch("task.create", { session_id: teamId, subject: "after", description: "d" });
    const final = await load(under(under(root, "teams"), teamId), teamId);
    expect(final.view.tasks.map((t) => t.subject)).toEqual(["before", "after"]);
    expect(final.state.failure).toBeUndefined();
    await host2.close();
  });

  it("TeamClient：读本地 / 写经宿主直执行；未持锁且无协调者 → 缺位窗口可读错误", async () => {
    const host = await openHost("sess_cli_team");
    const client = new TeamClient({ dataRoot: root, teamId: "sess_cli_team", host: () => host });
    await client.dispatch("task.create", { session_id: "sess_cli_team", subject: "s1", description: "d" });
    const board = (await client.dispatch("board.read")) as { seq: number };
    expect(board.seq).toBe(1);
    await host.close();

    // 无协调者（锁已释放但无人接任）→ 缺位窗口：有限重试后可读 TEAM_DISPOSED（逐字消息）
    const orphan = new TeamClient({ dataRoot: root, teamId: "sess_cli_team", unavailableRetryMs: 250 });
    try {
      await orphan.dispatch("task.create", { session_id: "sess_cli_team", subject: "s2", description: "d" });
      expect.unreachable("expected coordinator unavailable");
    } catch (err) {
      expect(isCoordinatorUnavailable(err)).toBe(true);
      expect((err as TeamError).message).toBe(
        "Agent Teams coordinator is unavailable (between coordinators); retry the request shortly",
      );
    }
  });
});
