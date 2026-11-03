// 〔issue #9 三档化 D28〕三档行为面单测：
// ① teamEverCreated 判定（members/ 存在非 sessionId 条目；lead/state.json 与 events.jsonl
//    是干扰源不得误判——见 src/provider/member-files.ts 注释）；
// ② handleTeamToolCall：off 档全部团队工具拒绝（tools/list 已空，此处兜底直连调用）；
// ③ auto 档首建队提示（FIRST_SPAWN_NOTE 独立 text 块，附在首成员 spawn 成功结果尾部）；
// ④ wire 层：TEAM_LEAD_MODE=off 的真实 daemon → tools/list 0 团队工具 + tools/call 拒绝。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { teamEverCreated } from "../../src/provider/member-files.js";
import { teamPaths } from "../../src/coord/paths.js";
import { handleTeamToolCall, type HandleToolOptions } from "../../src/mcp/handlers.js";
import type { TeamToolBackend } from "../../src/mcp/backend.js";
import { FIRST_SPAWN_NOTE, ON_DEMAND_SECTION_TEXT } from "../../src/mcp/policy.js";
import { TEAM_TOOL_NAMES } from "../../src/mcp/tools.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const DAEMON = path.join(PROJ, "runtime", "team-daemon.mjs");

describe("〔D28〕teamEverCreated 判定", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d28-tec-"));
  const sid = "sess_d28_lead";
  const teamDir = teamPaths(root, sid).teamDir;

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("members/ 不存在 → false（从未 spawn）", () => {
    expect(teamEverCreated(teamDir, sid)).toBe(false);
  });

  it("仅 lead 自身回执目录（members/<sessionId>）→ false", () => {
    fs.mkdirSync(path.join(teamDir, "members", sid), { recursive: true });
    expect(teamEverCreated(teamDir, sid)).toBe(false);
  });

  it("存在非 sessionId 条目（UUID 成员目录，failed 也算）→ true", () => {
    fs.mkdirSync(path.join(teamDir, "members", "99999999-8888-7777-6666-555555555555"), { recursive: true });
    expect(teamEverCreated(teamDir, sid)).toBe(true);
  });

  it("干扰源（lead/ 与空 events.jsonl）不算建队信号", () => {
    const root2 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d28-tec2-"));
    try {
      const sid2 = "sess_d28_lead2";
      const dir2 = teamPaths(root2, sid2).teamDir;
      fs.mkdirSync(path.join(dir2, "lead"), { recursive: true });
      fs.writeFileSync(path.join(dir2, "events.jsonl"), "");
      expect(teamEverCreated(dir2, sid2)).toBe(false);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("〔D28〕handleTeamToolCall 三档行为（stub backend，进程内）", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d28-handlers-"));
  const sid = "sess_d28_handle";
  const teamDir = teamPaths(root, sid).teamDir;

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const stubBackend = {
    interruptEnabled: true,
    spawnTeammate: async () => ({ member: { target: "worker", role: "teammate", status: "provisioning", diagnostics: [] } }),
  } as unknown as TeamToolBackend;

  function opts(leadMode: string | undefined): HandleToolOptions {
    return {
      backend: stubBackend,
      dataRoot: root,
      bootTimeMs: Date.now(),
      meta: { session_id: sid },
      args: { name: "worker", description: "d", prompt: "p" },
      ...(leadMode !== undefined ? { leadMode } : {}),
    };
  }

  it("off 档：spawn_teammate 直接拒绝（错误含 leadMode 说明，不触 backend）", async () => {
    const result = await handleTeamToolCall(opts("off"), "spawn_teammate");
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { type: string; text: string }).text) as { error: { message: string } };
    expect(body.error.message).toContain("unsupported team tool: spawn_teammate");
    expect(body.error.message).toContain('leadMode "off"');
    // 9 工具全部走同一拒绝路径（抽查两个）
    for (const tool of ["list_agents", "team_task_list"]) {
      const r = await handleTeamToolCall({ ...opts("off"), args: {} }, tool);
      expect(r.isError, tool).toBe(true);
    }
  });

  it("auto 档 + 首成员（members/ 无非 sessionId 条目）→ 成功结果尾部附 FIRST_SPAWN_NOTE", async () => {
    fs.mkdirSync(path.join(teamDir, "members", sid), { recursive: true }); // 仅 lead 回执目录
    const result = await handleTeamToolCall(opts("auto"), "spawn_teammate");
    expect(result.isError).toBeUndefined();
    const last = result.content[result.content.length - 1] as { type: string; text: string };
    expect(last.text).toBe(FIRST_SPAWN_NOTE);
    expect(last.text).toContain(ON_DEMAND_SECTION_TEXT);
    // 首块仍为紧凑 JSON 结果本体（{member:…}），提示不改 schema
    const first = JSON.parse((result.content[0] as { text: string }).text) as { member: { target: string } };
    expect(first.member.target).toBe("worker");
  });

  it("auto 档 + 已有成员 → 不再附提示", async () => {
    fs.mkdirSync(path.join(teamDir, "members", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), { recursive: true });
    const result = await handleTeamToolCall(opts("auto"), "spawn_teammate");
    const last = result.content[result.content.length - 1] as { type: string; text: string };
    expect(last.text).not.toBe(FIRST_SPAWN_NOTE);
  });

  it("always 档 / 未传档位 → 不附提示（提示仅 auto 首建队）", async () => {
    for (const mode of ["always", undefined]) {
      const result = await handleTeamToolCall(opts(mode), "spawn_teammate");
      const texts = result.content.map((c) => (c as { text: string }).text);
      expect(texts, `leadMode=${mode}`).not.toContain(FIRST_SPAWN_NOTE);
    }
  });

  it("TEAM_TOOL_NAMES 仍为 9 工具全集（off 拒绝按全集兜底，list 面由 registry 裁剪）", () => {
    expect(TEAM_TOOL_NAMES.size).toBe(9);
  });
});

describe("〔D28〕wire 层：TEAM_LEAD_MODE=off 的真实 daemon", () => {
  let root: string;
  let home: string;
  let proc: ChildProcess;
  let pending: Map<number, (msg: Record<string, unknown>) => void>;
  let nextId: number;

  function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d28-wire-"));
    home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    pending = new Map();
    nextId = 1;
    proc = execFile(process.execPath, [DAEMON], {
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME: home, TEAM_PLUGIN_DATA: root, TEAM_PROJECT_DIR: root, TEAM_LEAD_MODE: "off" },
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
        const id = msg.id as number | undefined;
        if (id !== undefined && pending.has(id)) {
          pending.get(id)!(msg);
          pending.delete(id);
        }
      }
    });
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "d28-wire", version: "0" },
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

  it("tools/list：0 团队工具（面板回环 team_panel_call 保留）", async () => {
    const res = (await rpc("tools/list")) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name);
    for (const tool of TEAM_TOOL_NAMES) {
      expect(names, `off 档不应注册 ${tool}`).not.toContain(tool);
    }
    expect(names).toContain("team_panel_call"); // 面板通道不受 leadMode 影响
  });

  it("tools/call：团队工具直接拒绝（错误含 leadMode 说明）", async () => {
    const res = (await rpc("tools/call", {
      name: "spawn_teammate",
      arguments: { name: "worker", description: "d", prompt: "p" },
      _meta: { session_id: "sess_d28_wire" },
    })) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
    const raw = res.result?.content?.[0]?.text ?? res.error?.message ?? "{}";
    let message = raw;
    try {
      message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
    } catch {
      /* 非 JSON（协议级 error.message）直接用原文 */
    }
    expect(message).toContain('leadMode "off"');
  });
});
