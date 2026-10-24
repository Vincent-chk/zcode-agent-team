// F11 · wait_agent 长挂起保活（stage-3 T3.2/T3.5b 机制层）。
// ① registry 门控：仅 wait_agent + _meta.progressToken 在场才发 progress；
// ② 等待期间周期发射（测试用小间隔；生产缺省 = WAIT_PROGRESS_INTERVAL_MS=9s，
//    使实测间隔（含 1–3ms 调度滞后）仍 ≤10s——F11 验收口径）；
// ③ wire 层：真实 stdio daemon 收 notifications/progress 报文（报文记录 = F11 证据形态）；
// ④ .mcp.json timeoutMs=3600000（manifest 定版值断言）。
// ≥120s 真实宿主样例归 T3.5c 实机取证（evidence/07-*）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callTeamTool } from "../../src/mcp/registry.js";
import { TeamToolBackend, withKeepAlive, WAIT_PROGRESS_INTERVAL_MS } from "../../src/mcp/backend.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import type { TeamLimits } from "../../src/domain/config.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const DAEMON = path.join(PROJ, "dist", "team-daemon.mjs");
const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

describe("保活机制（进程内）", () => {
  it("withKeepAlive：周期发射 + 结束即停（interval 可注入；缺省 = 9s，实测 ≤10s 口径）", async () => {
    // F11 判据 = 实测相邻间隔 ≤10s；9s 设计值留 10% 调度余量（stage-3 验收修复轮）
    expect(WAIT_PROGRESS_INTERVAL_MS).toBe(9_000);
    expect(WAIT_PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    const emissions: number[] = [];
    let resolveWait!: (v: { timedOut: boolean }) => void;
    const wait = new Promise<{ timedOut: boolean }>((r) => {
      resolveWait = r;
    });
    const done = withKeepAlive(
      wait,
      async (progress) => {
        emissions.push(progress);
      },
      20,
    );
    await new Promise((r) => setTimeout(r, 110));
    resolveWait({ timedOut: true });
    const result = await done;
    expect(result).toEqual({ timedOut: true });
    expect(emissions.length).toBeGreaterThanOrEqual(3); // ~110ms / 20ms ≥ 3 次
    expect(emissions).toEqual(emissions.map((_, i) => i + 1)); // 递增序号
    const after = emissions.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(emissions).toHaveLength(after); // 结束即停（clearInterval）
  });

  it("registry 门控：progressToken 在场才建 sink；非 wait_agent 不发", async () => {
    const dataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-keepalive-"));
    const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
    const lead = "sess_keepalive_lead";
    upsertSessionEntry(dataRoot, lead, { firstSeen: new Date().toISOString(), hookRegistered: true });
    // 建一个同伴让捷径不命中（MockProvider 子进程存活 = running）
    await callTeamTool({
      backend,
      dataRoot,
      bootTimeMs: Date.now(),
      name: "spawn_teammate",
      args: { name: "w1", description: "d", prompt: "p" },
      meta: { session_id: lead },
    });
    const notifications: Array<Record<string, unknown>> = [];
    const notifier = {
      sendNotification: async (n: Record<string, unknown>) => {
        notifications.push(n);
      },
    };
    // wait 10s + 并发唤醒（task.create 提交边）；progressToken 在场
    const waiting = callTeamTool(
      {
        backend,
        dataRoot,
        bootTimeMs: Date.now(),
        name: "wait_agent",
        args: { timeout_ms: 10_000 },
        meta: { session_id: lead, progressToken: 7 },
      },
      notifier as never,
    );
    // 保活缺省 10s 间隔——本用例等待 <10s 被唤醒，可能 0 次发射；断言唤醒结果与「不发也无害」。
    // 周期发射的强断言在上一条（interval 注入）与 wire 层（真实 daemon 日志）承担。
    await new Promise((r) => setTimeout(r, 50));
    await callTeamTool({
      backend,
      dataRoot,
      bootTimeMs: Date.now(),
      name: "team_task_create",
      args: { subject: "wake", description: "d" },
      meta: { session_id: lead },
    });
    const result = await waiting;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ timedOut: false });
    for (const n of notifications) {
      expect(n.method).toBe("notifications/progress");
      expect((n.params as Record<string, unknown>).progressToken).toBe(7);
    }
    // 非 wait_agent + progressToken：不发 progress
    const before = notifications.length;
    await callTeamTool(
      {
        backend,
        dataRoot,
        bootTimeMs: Date.now(),
        name: "team_task_list",
        args: {},
        meta: { session_id: lead, progressToken: 9 },
      },
      notifier as never,
    );
    expect(notifications).toHaveLength(before);
    await backend.close();
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe("保活机制（wire 层：真实 stdio daemon 报文）", () => {
  let root: string;
  let proc: ChildProcess;
  let pending: Map<number, (msg: Record<string, unknown>) => void>;
  let nextId: number;
  const notifications: Array<Record<string, unknown>> = [];

  function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      (proc as unknown as { stdin: NodeJS.WritableStream }).stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n",
      );
    });
  }

  beforeAll(async () => {
    expect(fs.existsSync(DAEMON), "dist/team-daemon.mjs 缺失——先 npm run build").toBe(true);
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-wire-"));
    pending = new Map();
    nextId = 1;
    notifications.length = 0;
    // stage-4：daemon 默认 provider 已是 ResumePerTurnProvider（真 zcode 子进程）——wire 测试
    // 指到 fake-zcode 替身（确定性 + 零模型调用）；SLEEP 覆盖 12s 等待窗（成员保持 running，
    // 保活 progress 至少一次——真模型下成员轮次会提前结束把等待者唤醒）。
    const { createTestDb, FAKE_ZCODE } = await import("../provider/kit.js");
    createTestDb(path.join(root, "db.sqlite"));
    proc = execFile(process.execPath, [DAEMON], {
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        TEAM_PLUGIN_DATA: root,
        TEAM_PROJECT_DIR: root,
        TEAM_ZCODE_BIN: FAKE_ZCODE,
        TEAM_DB_PATH: path.join(root, "db.sqlite"),
        // 夹具走 fake-zcode（不支持 app-server 协议）→ 用旧会话语义
        TEAM_SESSION_ISOLATION: "legacy",
        FAKE_ZCODE_SLEEP_MS: "30000",
      },
    }) as unknown as ChildProcess;
    const child = proc as unknown as { stdout: NodeJS.ReadableStream; stdin: NodeJS.WritableStream };
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.id !== undefined && pending.has(msg.id as number)) {
          pending.get(msg.id as number)!(msg);
          pending.delete(msg.id as number);
        } else if (msg.method !== undefined) {
          notifications.push(msg);
        }
      }
    });
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "f11-wire", version: "0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  afterAll(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("wait_agent 长等待期间 daemon 发 notifications/progress（≤10s 间隔；报文含 progressToken）", async () => {
    const lead = "sess_wire_lead";
    // 注册 hook（fail-loud 不干扰）+ 建同伴（捷径不命中）
    upsertSessionEntry(root, lead, { firstSeen: new Date().toISOString(), hookRegistered: true });
    const spawn = await rpc("tools/call", {
      name: "spawn_teammate",
      arguments: { name: "w1", description: "d", prompt: "p" },
      _meta: { session_id: lead, progressToken: "tok-spawn" },
    });
    expect((spawn.result as { isError?: boolean }).isError).toBeUndefined();

    // 12s 等待（>10s 间隔 → 至少 1 次 progress）；11s 时 task.create 唤醒
    const waitPromise = rpc("tools/call", {
      name: "wait_agent",
      arguments: { timeout_ms: 12_000 },
      _meta: { session_id: lead, progressToken: 42 },
    });
    await new Promise((r) => setTimeout(r, 11_000));
    await rpc("tools/call", {
      name: "team_task_create",
      arguments: { subject: "wake", description: "d" },
      _meta: { session_id: lead },
    });
    const waitRes = (await waitPromise) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(waitRes.result.isError).toBeUndefined();
    expect(JSON.parse(waitRes.result.content[0]!.text)).toEqual({ timedOut: false });

    const progressNotes = notifications.filter((n) => n.method === "notifications/progress");
    expect(progressNotes.length).toBeGreaterThanOrEqual(1); // 11s 等待 / 10s 间隔 ≥ 1
    for (const n of progressNotes) {
      const params = n.params as Record<string, unknown>;
      expect(params.progressToken).toBe(42);
      expect(typeof params.progress).toBe("number");
    }
    // 报文记录落盘（F11 证据形态；evidence 采集脚本复用同目录）
    fs.writeFileSync(
      path.join(root, "progress-notifications.json"),
      JSON.stringify(progressNotes, null, 2),
    );
  }, 40_000);
});

describe("manifest 定版值", () => {
  it(".mcp.json timeoutMs = 3600000（T3.2 wait 保活定版）；无 ${ZCODE_SESSION_ID}（禁用负例口径）", () => {
    const raw = fs.readFileSync(path.join(PROJ, ".mcp.json"), "utf8");
    const mcp = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(mcp.mcpServers["team-daemon"]!.timeoutMs).toBe(3_600_000);
    expect(raw).not.toContain("${ZCODE_SESSION_ID}"); // stage-1 负例教训（静态展开抛错禁用 server）
  });
});
