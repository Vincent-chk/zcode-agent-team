// team-ctl 脚本集成测试（第四轮 C）：build → 真实装配 daemon → 四命令全链路。
//   state（分区渲染 + --json）、call（真方法 + 无协调者可读错误）、tail（跟随 + 信号退出）、
//   inject-event（非法事件 → state 显示 failure 终态、后续合法事件不再改变视图）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnBundled, killDaemon } from "../coord/fixture/daemon-kit.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const CTL = path.join(PROJ, "scripts", "team-ctl.mjs");
const ENTRY = path.join(PROJ, "test/coord/fixture/real-host-daemon.ts");
const TEAM = "sess_ctl_demo";

let root: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { killAfterMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CTL, ...args],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: undefined } },
      (err, stdout, stderr) => {
        void err;
        resolve({ code: child.exitCode ?? (err ? 1 : 0), stdout, stderr });
      },
    );
    if (opts.killAfterMs !== undefined) {
      setTimeout(() => process.kill(child.pid as number, "SIGTERM"), opts.killAfterMs);
    }
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timeout"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-ctl-"));
  // build.mjs 生成 dist/team-ctl.mjs（薄启动器的依赖）
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [path.join(PROJ, "scripts", "build.mjs")], { maxBuffer: 32 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}, 60_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("team-ctl 四命令（脚本级）", () => {
  it(
    "state / call / tail / inject-event 全链路",
    async () => {
      const caseRoot = under(root, "case-a");
      const teamDir = under(under(caseRoot, "teams"), TEAM);
      fs.mkdirSync(teamDir, { recursive: true });

      // 无协调者 → call 可读错误（缺位窗口文案逐字）
      const noCoord = await run(["call", teamDir, "member.claim", JSON.stringify({ session_id: TEAM })]);
      expect(noCoord.code).toBe(1);
      expect(noCoord.stdout).toContain("Agent Teams coordinator is unavailable (between coordinators); retry the request shortly");

      // 真实装配 daemon
      const daemon = await spawnBundled(ENTRY, (bundle) => [
        bundle,
        "--root",
        caseRoot,
        "--team",
        TEAM,
        "--mode",
        "coordinator",
      ]);
      await daemon.waitFor("ready", 20_000);

      // call：真方法（hello / member.claim / task.create）
      const hello = await run(["call", teamDir, "coordinator.hello", JSON.stringify({ session_id: TEAM })]);
      expect(hello.code).toBe(0);
      expect(JSON.parse(hello.stdout)).toMatchObject({ coordinatorBootId: expect.any(String), stateRevision: expect.any(Number) });
      const claim = await run(["call", teamDir, "member.claim", JSON.stringify({ session_id: TEAM })]);
      expect(JSON.parse(claim.stdout)).toEqual({ role: "lead" });
      const create = await run([
        "call",
        teamDir,
        "task.create",
        JSON.stringify({ session_id: TEAM, subject: "ctl-task", description: "via team-ctl call" }),
      ]);
      expect(create.code).toBe(0);
      expect(JSON.parse(create.stdout)).toMatchObject({ task: { id: "task-1" } });

      // state：分区渲染（daemon 活着，读本地重放）
      const state = await run(["state", teamDir]);
      expect(state.code).toBe(0);
      expect(state.stdout).toContain(`Agent Team ${TEAM}`);
      expect(state.stdout).toContain("Tasks (1)");
      expect(state.stdout).toContain("ctl-task");
      expect(state.stdout).toContain("（邮箱空闲）");

      // tail：跟随 + SIGTERM 干净退出（历史 1 行起）
      const tail = await run(["tail", teamDir, "--n", "5"], { killAfterMs: 1_200 });
      expect(tail.stdout).toContain("team/task");
      expect(tail.stdout).toContain("task-1");

      // daemon 优雅退出（落 checkpoint）→ state 走 checkpoint+tail 路径
      killDaemon(daemon, "SIGINT");
      await daemon.exited;
      await waitFor(() => fs.existsSync(path.join(teamDir, "checkpoint.json")));
      const stateAfter = await run(["state", teamDir]);
      expect(stateAfter.stdout).toContain("checkpoint+tail");

      // --json 机器可读
      const stateJson = await run(["state", teamDir, "--json"]);
      const parsed = JSON.parse(stateJson.stdout);
      expect(parsed.view.tasks[0].subject).toBe("ctl-task");
      expect(parsed.fromCheckpoint).toBe(true);
    },
    45_000,
  );

  it(
    "inject-event：非法事件 → state 显示 failure 终态、后续合法事件不再改变视图",
    async () => {
      const teamDir = under(under(root, "case-b"), "teams");
      fs.mkdirSync(teamDir, { recursive: true });
      // 合法基线（两行：member provisioning + active）
      const teamId = TEAM;
      const base = [
        { event: { type: "team/member", version: 2, teamId, member: { id: "m1", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } } },
        { event: { type: "team/member", version: 2, teamId, member: { id: "m1", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active" } } },
      ];
      fs.writeFileSync(path.join(teamDir, "events.jsonl"), base.map((b) => JSON.stringify(b)).map((l, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), writer: "seed:1", ...JSON.parse(l) })).join("\n") + "\n");

      const inject = await run(["inject-event", teamDir, "--sample", "invalid-member", "--team", teamId]);
      expect(inject.code).toBe(0);
      expect(inject.stdout).toContain("test-only");
      expect(inject.stdout).toContain("seq=3");

      const failed = await run(["state", teamDir]);
      expect(failed.stdout).toContain("FAILURE（终态，后续合法事件不再改变视图）");
      expect(failed.stdout).toContain("must begin provisioning");

      // 后续合法事件（新任务）→ 视图冻结（任务仍 0），seq 停在 failure 行
      const legal = JSON.stringify({
        event: { type: "team/task", version: 2, teamId, task: { id: "task-1", revision: 1, subject: "frozen", description: "d", status: "pending", blockedBy: [], writeScopes: [] } },
      });
      await run(["inject-event", teamDir, legal]);
      const still = await run(["state", teamDir]);
      expect(still.stdout).toContain("Tasks (0)");
      expect(still.stdout).toContain("FAILURE（终态");
    },
    30_000,
  );

  it("错误摘要单行化 + 未知子命令 usage", async () => {
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr.split("\n")[0]).toContain("未知子命令");
    const badJson = await run(["inject-event", under(root, "case-c"), "{{not-json"]);
    expect(badJson.code).toBe(1);
    expect(badJson.stderr).toContain("必须是合法 JSON 行");
    expect(badJson.stderr.trimEnd().split("\n")).toHaveLength(1); // 单行摘要（无堆栈污染）
  });
});
