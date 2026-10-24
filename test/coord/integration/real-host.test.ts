// 第四轮 A3 + B 演练（真实子进程 + 真实装配 TeamCoordinatorHost）：
//   S1 方法表全量接线（socket 载体 happy + 错误抽样，含 wait.agent 并发唤醒）
//   S2 kill -9 接任：p1 持锁 → p2 代理模式（经 socket 写入成功）→ kill -9 p1
//      → p2 ≤5s 接任 → 进程内直执行写入继续；测试进程 TeamClient 缺位窗口退避重试成功；
//      coordinator 与代理两侧 board.read 均可用；状态连续（重放无 failure/corrupt）。
// 证据落 zcode-agent-team-plan/stage-2-team-domain/evidence/real-host.json（由 afterAll 复制逻辑
// 在 test:cov 全绿后手工/脚本拷贝；本文件仅写 tmpdir 汇总，见 services-journal 惯例）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnBundled, killDaemon, type DaemonHandle } from "../fixture/daemon-kit.js";
import { callCoordinator } from "../../../src/coord/rpc.js";
import { TeamClient } from "../../../src/coord/client.js";
import { load } from "../../../src/coord/replay.js";
import { safeTeamId } from "../../../src/coord/paths.js";
import { TeamError } from "../../../src/domain/errors.js";

const TEAM = "sess_drill_lead";
const EVIDENCE: Array<Record<string, unknown>> = [];

let rootBase: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

function teamDirOf(base: string, teamId: string): string {
  return under(under(base, "teams"), safeTeamId(teamId));
}

/** retry 隔离：每次尝试用唯一 case 目录（失败重试不重放旧 journal/锁，retry 才能生效）。 */
function attemptTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

const ENTRY = path.resolve(import.meta.dirname, "../fixture/real-host-daemon.ts");

async function spawnHostDaemon(args: {
  root: string;
  team: string;
  mode: "coordinator" | "proxy";
  proxyCalls?: unknown[];
  postPromotionCalls?: unknown[];
}): Promise<DaemonHandle> {
  const extra: Array<[string, unknown[] | undefined]> = [
    ["proxy-calls", args.proxyCalls],
    ["post-promotion-calls", args.postPromotionCalls],
  ];
  const files: Record<string, unknown> = {};
  const argvFlags: string[] = [];
  for (const [flag, calls] of extra) {
    if (calls !== undefined) {
      const file = path.join(args.root, `calls-${flag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
      files[file] = calls;
      argvFlags.push(`--${flag}`, file);
    }
  }
  return spawnBundled(
    ENTRY,
    (bundle) => [bundle, "--root", args.root, "--team", args.team, "--mode", args.mode, ...argvFlags],
    files,
  );
}

async function rpc<T>(root: string, method: string, params?: unknown): Promise<T> {
  return callCoordinator<T>(teamDirOf(root, TEAM), TEAM, method, params, { timeoutMs: 8_000 });
}

async function expectRpcError(p: Promise<unknown>, code: string, message: string): Promise<void> {
  try {
    await p;
    expect.unreachable(`expected TeamError ${code}`);
  } catch (err) {
    expect(err, `code ${code}`).toBeInstanceOf(TeamError);
    expect((err as TeamError).code).toBe(code);
    expect((err as TeamError).message).toBe(message);
  }
}

beforeAll(() => {
  rootBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-real-host-"));
});

afterAll(() => {
  // maxRetries：早退失败路径可能遗留孤儿 daemon 心跳写盘竞态（macOS ENOTEMPTY）
  fs.rmSync(rootBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const evidenceDir = under(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "real-host.json"), JSON.stringify(EVIDENCE, null, 2));
});

describe("S1 · 方法表全量接线（socket 载体）", () => {
  let p1: DaemonHandle;
  let socketPath: string;

  it(
    "hello/claim/spawn/task/message/board/wait/reconcile 全通 + 错误抽样",
    { timeout: 30_000, retry: 2 },
    async () => {
      const caseRoot = under(rootBase, `s1-${attemptTag()}`); // retry 隔离
      fs.mkdirSync(caseRoot, { recursive: true });
      p1 = await spawnHostDaemon({ root: caseRoot, team: TEAM, mode: "coordinator" });
      const ready = await p1.waitFor("ready", 20_000);
      expect(ready.mode).toBe("coordinator");
      socketPath = ready.socketPath as string;
      expect(typeof socketPath).toBe("string");

      // hello：stateRevision 语义 = journal seq（冻结）
      const hello = await rpc<{ coordinatorBootId: string; stateRevision: number }>(caseRoot, "coordinator.hello", {
        teamId: TEAM,
        session_id: TEAM,
      });
      expect(hello.stateRevision).toBe(0);
      expect(hello.coordinatorBootId).toMatch(/^[0-9a-f-]{36}$/);

      await expect(rpc(caseRoot, "member.claim", { session_id: TEAM })).resolves.toEqual({ role: "lead" });
      await expectRpcError(
        rpc(caseRoot, "member.claim", { session_id: "sess-nobody" }),
        "TEAM_NOT_MEMBER",
        'agent "sess-nobody" is not a member of an active Agent Team',
      );

      const spawn = await rpc<{ member: { target: string; status: string } }>(caseRoot, "member.spawn", {
        session_id: TEAM,
        name: "worker",
        description: "drill worker",
        prompt: "do work",
      });
      expect(spawn.member.target).toBe("worker");

      // worker 会话身份经 board.read 视图发现（成员行 id）
      const board1 = await rpc<{ revision: number; view: { members: Array<{ id: string; name: string }>; tasks: unknown[] } }>(
        caseRoot,
        "board.read",
        { session_id: TEAM },
      );
      expect(board1.view.members.map((m) => m.name)).toEqual(["lead", "worker"]);
      const workerId = board1.view.members.find((m) => m.name === "worker")?.id as string;

      const created = await rpc<{ task: { id: string; revision: number; subject: string } }>(caseRoot, "task.create", {
        session_id: TEAM,
        subject: "drill task",
        description: "d",
      });
      expect(created.task.id).toBe("task-1");
      expect(created.task.revision).toBe(1);

      await expect(
        rpc(caseRoot, "task.update", { session_id: workerId, taskId: "task-1", expectedRevision: 1, action: "claim" }),
      ).resolves.toMatchObject({ task: { id: "task-1", ownerName: "worker", revision: 2 } });
      // CAS 先于归属检查：带当前 revision 的他人 claim → ALREADY_CLAIMED
      await expectRpcError(
        rpc(caseRoot, "task.update", { session_id: TEAM, taskId: "task-1", expectedRevision: 2, action: "claim" }),
        "TEAM_TASK_ALREADY_CLAIMED",
        'team task "task-1" is owned by another member',
      );
      await expectRpcError(
        rpc(caseRoot, "task.update", { session_id: TEAM, taskId: "task-1", expectedRevision: 7, action: "release" }),
        "TEAM_TASK_STALE_REVISION",
        'stale team task "task-1" revision 7; current revision is 2',
      );

      const send1 = await rpc<{ messageId: string }>(caseRoot, "message.send", {
        session_id: TEAM,
        targetName: "worker",
        content: [{ type: "text", text: "hello worker" }],
      });
      expect(send1.messageId).toMatch(/^team-message-/); // 〔对齐轮〕0.2.1 无 status 字段
      const send2 = await rpc<{ messageId: string }>(caseRoot, "message.send", {
        session_id: workerId,
        targetName: "lead",
        content: [{ type: "text", text: "hello lead" }],
      });
      expect(send2.messageId).toMatch(/^team-message-/);
      await expectRpcError(
        rpc(caseRoot, "message.send", { session_id: TEAM, targetName: "lead", content: [] }),
        "TEAM_SELF_MESSAGE",
        "a Team member cannot message itself",
      );

      await expect(rpc(caseRoot, "member.interrupt", { session_id: TEAM, name: "worker" })).resolves.toEqual({
        previousStatus: "running",
      });
      await expectRpcError(
        rpc(caseRoot, "member.spawn", { session_id: TEAM, name: "worker", description: "d", prompt: "p" }),
        "TEAM_MEMBER_NAME_TAKEN",
        'teammate name "worker" was already used in this Team',
      );
      await expectRpcError(
        rpc(caseRoot, "wait.agent", { session_id: TEAM, timeoutMs: 5_000 }),
        "TEAM_INVALID_TIMEOUT",
        "timeoutMs must be an integer from 10000 through 3600000",
      );

      // wait.agent 并发唤醒：等待中发生提交 → 立即 {timedOut:false}
      const waiting = rpc<{ timedOut: boolean }>(caseRoot, "wait.agent", { session_id: TEAM, timeoutMs: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rpc(caseRoot, "task.create", { session_id: TEAM, subject: "wake", description: "d" });
      await expect(waiting).resolves.toEqual({ timedOut: false });

      await expect(rpc(caseRoot, "admin.reconcile", { teamId: TEAM })).resolves.toEqual({ orphans: [], settled: [] });
      await expect(rpc(caseRoot, "task.list", { session_id: TEAM, status: "pending" })).resolves.toMatchObject({
        tasks: expect.any(Array),
      });
      await expect(rpc(caseRoot, "task.get", { session_id: TEAM, taskId: "task-1" })).resolves.toMatchObject({
        task: { id: "task-1" },
      });

      killDaemon(p1, "SIGINT");
      const exited = await p1.exited;
      expect([exited.code, exited.signal]).toContain(0);

      // 关停落 checkpoint：重放走增量路径且视图等价
      const final = await load(teamDirOf(caseRoot, TEAM), TEAM);
      expect(final.fromCheckpoint).toBe(true);
      expect(final.state.failure).toBeUndefined();
      EVIDENCE.push({
        scenario: "s1-method-table-over-wire",
        ok: true,
        methods: 12,
        socketPathBytes: socketPath.length,
        checkpointOnGracefulExit: final.fromCheckpoint,
      });
    },
  );
});

describe("S2 · kill -9 接任（A3）+ 代理写入与缺位窗口重试（B）", () => {
  it(
    "p1 持锁 → p2 经 socket 写入 → kill -9 p1 → p2 ≤5s 接任 → 写入继续 → 状态连续",
    { timeout: 40_000, retry: 2 },
    async () => {
      const caseRoot = under(rootBase, `s2-${attemptTag()}`); // retry 隔离
      fs.mkdirSync(caseRoot, { recursive: true });
      const p1 = await spawnHostDaemon({ root: caseRoot, team: TEAM, mode: "coordinator" });
      const ready1 = await p1.waitFor("ready", 20_000);
      expect(ready1.mode).toBe("coordinator");

      // p1 侧经真方法建态：1 成员 + 1 任务
      await rpc(caseRoot, "member.spawn", { session_id: TEAM, name: "worker", description: "d", prompt: "p" });
      await rpc(caseRoot, "task.create", { session_id: TEAM, subject: "base", description: "d" });
      const before = await load(teamDirOf(caseRoot, TEAM), TEAM);

      // p2：代理模式（p1 活着 → 抢锁单发即弃）；ready 后立即经 socket 写入（真方法）
      const p2 = await spawnHostDaemon({
        root: caseRoot,
        team: TEAM,
        mode: "proxy",
        proxyCalls: [{ method: "task.create", params: { session_id: TEAM, subject: "via-proxy", description: "d" } }],
        postPromotionCalls: [
          { method: "task.create", params: { session_id: TEAM, subject: "post-promotion", description: "d" } },
        ],
      });
      const ready2 = await p2.waitFor("ready", 20_000);
      expect(ready2.mode).toBe("proxy");
      const proxyWrite = await p2.waitFor("dispatch-ok", 20_000);
      expect(proxyWrite.method).toBe("task.create");
      expect(proxyWrite.phase).toBe("proxy-phase");

      // kill -9 持锁方 → 缺位窗口
      const killAt = Date.now();
      killDaemon(p1, "SIGKILL");
      await p1.exited;

      // 测试进程客户端：缺位窗口内发起写入 → 指数退避（预算 6.5s）→ 接任后成功
      const retries: number[] = [];
      const client = new TeamClient({
        dataRoot: caseRoot,
        teamId: TEAM,
        unavailableRetryMs: 6_500,
        onRetry: (attempt) => retries.push(attempt),
      });
      const retryWriteP = client.dispatch("task.create", { session_id: TEAM, subject: "after-takeover", description: "d" });

      const promoted = await p2.waitFor("promoted", 20_000);
      expect(promoted.socketPath).toBeTruthy();
      await retryWriteP;

      // ≤5s 硬断言的语义 = 锁接任（心跳过期 4500ms + 轮询）：以锁审计的 acquire 时间戳度量，
      // 排除 serve()（journal+runtime+listen）与事件投递在负载下的抖动。
      const audit = fs
        .readFileSync(path.join(teamDirOf(caseRoot, TEAM), "coordinator.audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { event: string; ts?: string; pid?: number });
      const acquireEvents = audit.filter((a) => a.event === "acquire" && a.pid === p2.pid);
      expect(acquireEvents.length).toBeGreaterThan(0);
      const lockTakeoverMs = Date.parse(acquireEvents[acquireEvents.length - 1].ts as string) - killAt;
      expect(lockTakeoverMs).toBeLessThanOrEqual(5_000);
      const serveJitterMs = Date.now() - killAt - lockTakeoverMs;

      // post-promotion 调用与 proxy-phase 的 dispatch-ok 同事件类型 → 扫事件流按 phase 区分
      const postPromotionOk = p2.events.find(
        (e) => e.type === "dispatch-ok" && e.phase === "post-promotion" && e.method === "task.create",
      );
      expect(postPromotionOk).toBeDefined();

      // p2（新协调者）socket 上 board.read 可用；代理侧（本地重放）也可用
      const boardViaNewCoordinator = await rpc<{ revision: number; view: { tasks: Array<{ subject: string }> } }>(
        caseRoot,
        "board.read",
        {},
      );
      const boardLocal = (await client.readBoard()) as { seq: number };

      // 状态连续：成员/任务/消息齐全、无 failure/corrupt、seq 连续
      const final = await load(teamDirOf(caseRoot, TEAM), TEAM);
      expect(final.state.failure).toBeUndefined();
      expect(final.corrupt).toBeUndefined();
      // 状态连续：成员/任务/消息齐全、无 failure/corrupt、seq 连续。
      // 接管后的两笔写入（测试进程 socket 重试 vs p2 进程内直执行）存在良性竞态 → 序无关断言。
      expect(final.view.members.map((m) => m.name)).toEqual(["lead", "worker"]);
      const subjects = final.view.tasks.map((t) => t.subject);
      expect(subjects.slice(0, 2)).toEqual(["base", "via-proxy"]);
      expect([...subjects.slice(2)].sort()).toEqual(["after-takeover", "post-promotion"]);
      expect(final.state.messages).toHaveLength(0); // 本剧本未发消息
      expect(boardViaNewCoordinator.view.tasks).toHaveLength(final.view.tasks.length);
      expect(boardLocal.seq).toBe(final.seq);

      killDaemon(p2, "SIGINT");
      await p2.exited;

      EVIDENCE.push({
        scenario: "s2-kill9-takeover-real-host",
        lockTakeoverMs,
        withinBudget: lockTakeoverMs <= 5_000,
        serveJitterMs,
        proxyWriteBeforeKill: proxyWrite.method === "task.create",
        absenceWindowRetries: retries.length,
        postPromotionDirectWrite: postPromotionOk !== undefined,
        seqBeforeKill: before.seq,
        seqFinal: final.seq,
        tasksFinal: final.view.tasks.length,
      });
      expect(lockTakeoverMs).toBeLessThanOrEqual(5_000);
    },
  );
});

describe("S3 · 失败日志降级只读协调者（G2 收口：wire 载体）", () => {
  it(
    "注入非法事件后冷启动 → daemon 存活 serve → socket 上成员调用 TEAM_NOT_MEMBER / board.read 排障可见 failure → SIGINT 干净退出",
    { timeout: 40_000, retry: 2 },
    async () => {
      const caseRoot = under(rootBase, `s3-${attemptTag()}`); // retry 隔离
      fs.mkdirSync(caseRoot, { recursive: true });
      const failure = 'teammate "ghost" must begin provisioning';
      const notMember = (id: string) => `agent "${id}" is not a member of an active Agent Team`;

      // 1) 健康建态（1 成员 + 1 任务）→ 优雅退出（落 checkpoint、释放锁）
      const p1 = await spawnHostDaemon({ root: caseRoot, team: TEAM, mode: "coordinator" });
      await p1.waitFor("ready", 20_000);
      await rpc(caseRoot, "member.spawn", { session_id: TEAM, name: "worker", description: "d", prompt: "p" });
      await rpc(caseRoot, "task.create", { session_id: TEAM, subject: "pre-failure", description: "d" });
      const board1 = await rpc<{ view: { members: Array<{ id: string; name: string }> } }>(caseRoot, "board.read", {
        session_id: TEAM,
      });
      const workerId = board1.view.members.find((m) => m.name === "worker")?.id as string;
      killDaemon(p1, "SIGINT");
      const ex1 = await p1.exited;
      expect([ex1.code, ex1.signal]).toContain(0);

      // 2) 直写非法 member 事件（等价 team-ctl inject-event：绕过 journal 不变量；seq 续接）
      const teamDir = teamDirOf(caseRoot, TEAM);
      const eventsFile = path.join(teamDir, "events.jsonl");
      const lines = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.length > 0);
      const injectedSeq = lines.length + 1;
      fs.appendFileSync(
        eventsFile,
        JSON.stringify({
          seq: injectedSeq,
          ts: new Date().toISOString(),
          writer: "test:inject",
          event: {
            type: "team/member",
            version: 2,
            teamId: TEAM,
            member: { id: "ghost", name: "ghost", description: "inj", provider: "spawn", context: "fresh", phase: "active" },
          },
        }) + "\n",
      );

      // 3) G2 核心：失败日志上冷启动 → daemon 存活（修复前 recoverAll 抛穿 → error + exit 1）
      const p2 = await spawnHostDaemon({ root: caseRoot, team: TEAM, mode: "coordinator" });
      const ready2 = await p2.waitFor("ready", 20_000);
      expect(ready2.mode).toBe("coordinator");
      expect(ready2.failure).toBe(failure);
      const warnEv = p2.events.find((e) => e.type === "warn" && typeof e.message === "string" && e.message.includes("degraded mode"));
      expect(warnEv).toBeDefined();

      // 4) socket 载体 C5：成员身份调用一律 TEAM_NOT_MEMBER（G1 修复面 member.claim / board.read 带 id）
      await expectRpcError(rpc(caseRoot, "member.claim", { session_id: TEAM }), "TEAM_NOT_MEMBER", notMember(TEAM));
      await expectRpcError(rpc(caseRoot, "member.claim", { session_id: workerId }), "TEAM_NOT_MEMBER", notMember(workerId));
      await expectRpcError(rpc(caseRoot, "board.read", { session_id: TEAM }), "TEAM_NOT_MEMBER", notMember(TEAM));
      await expectRpcError(
        rpc(caseRoot, "task.create", { session_id: TEAM, subject: "x", description: "d" }),
        "TEAM_NOT_MEMBER",
        notMember(TEAM),
      );
      await expectRpcError(
        rpc(caseRoot, "message.send", { session_id: workerId, targetName: "lead", content: [{ type: "text", text: "x" }] }),
        "TEAM_NOT_MEMBER",
        notMember(workerId),
      );

      // 5) 排障视角与诊断面：board.read 无 id → failure 视图原样可见；hello 可用（stateRevision=含注入行 seq）
      const board = await rpc<{ revision: number; view: { failure?: string; members: Array<{ name: string }>; tasks: Array<{ subject: string }> } }>(
        caseRoot,
        "board.read",
        {},
      );
      expect(board.view.failure).toBe(failure);
      expect(board.view.members.map((m) => m.name)).toEqual(["lead", "worker"]); // 视图=最后有效状态
      expect(board.view.tasks.map((t) => t.subject)).toEqual(["pre-failure"]);
      const hello = await rpc<{ stateRevision: number }>(caseRoot, "coordinator.hello", { teamId: TEAM });
      expect(hello.stateRevision).toBe(injectedSeq);

      // 6) SIGINT 干净退出：exit 0、锁释放；checkpoint 回读 failure 保持（失败态可持久回读 → 保留写入）
      killDaemon(p2, "SIGINT");
      const ex2 = await p2.exited;
      expect([ex2.code, ex2.signal]).toContain(0);
      expect(fs.existsSync(path.join(teamDir, "coordinator.lock"))).toBe(false);
      const final = await load(teamDir, TEAM);
      expect(final.state.failure).toBe(failure);
      expect(final.seq).toBe(injectedSeq);

      EVIDENCE.push({
        scenario: "s3-degraded-readonly-coordinator",
        coldStartAlive: true,
        degradedWarnEmitted: warnEv !== undefined,
        memberCallsTeamNotMember: true,
        boardFailureVisible: board.view.failure === failure,
        helloStateRevision: hello.stateRevision,
        cleanExit: [ex2.code, ex2.signal].includes(0),
        lockReleased: !fs.existsSync(path.join(teamDir, "coordinator.lock")),
        checkpointReloadKeepsFailure: final.state.failure === failure,
      });
    },
  );
});
