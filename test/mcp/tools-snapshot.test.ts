// F01 · tools/list 逐字节快照（stage-3 T3.5a）。
// 两层：① 进程内 listTeamTools()（注册表原样）vs 期望生成器（02 §9 独立转写，test/mcp/
// expected-tools.ts）——同一序列化器（JSON.stringify 无缩进）逐字节 diff = 0（9/9）；
// ② wire 层：真实孵化 dist/team-daemon.mjs（stdio JSON-RPC）→ tools/list → 过滤 9 工具 →
// 同一序列化器逐字节 diff = 0（宿主实际看到的字节）。
// 〔0.4.0〕member_set_model 注销、team://models 资源下线（成员模型唯一路线 = 跟随 Lead）。
// 数据根 os.tmpdir()；孵化用 execFile 数组参数（Mimosa 纪律）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTeamTools } from "../../src/mcp/registry.js";
import { TEAM_TOOL_DEFINITIONS, serializeToolsList, teamToolDefinitions, teamToolNames } from "../../src/mcp/tools.js";
import { EXPECTED_TEAM_TOOLS, expectedToolsListJson } from "./expected-tools.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const DAEMON = path.join(PROJ, "dist", "team-daemon.mjs");

const NINE = EXPECTED_TEAM_TOOLS.map((t) => t.name as string);

describe("F01 · schema 逐字节快照（进程内注册表）", () => {
  it("9 工具注册表原样 = 期望 JSON（同一序列化器，diff = 0）", () => {
    expect(TEAM_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(NINE);
    const actual = serializeToolsList(listTeamTools());
    const expected = expectedToolsListJson();
    if (actual !== expected) {
      // 失败时给出定位信息（首个差异字节位）
      let i = 0;
      while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
      throw new Error(
        `byte diff at ${i}: actual …${actual.slice(Math.max(0, i - 60), i + 60)}… expected …${expected.slice(Math.max(0, i - 60), i + 60)}…`,
      );
    }
    expect(actual).toBe(expected);
    // 单行紧凑（无缩进无换行）
    expect(actual).not.toContain("\n");
    expect(actual).toMatch(/^\{"tools":\[.*\]\}$/);
  });

  it("每工具字段面 = name/description/inputSchema（+_meta 仅 spawn）；additionalProperties:false 全量", () => {
    for (const tool of TEAM_TOOL_DEFINITIONS) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const keys = Object.keys(tool).filter((k) => !["_meta"].includes(k));
      expect(keys).toEqual(["name", "description", "inputSchema"]);
      if (tool.name === "spawn_teammate") {
        expect(tool._meta).toEqual({
          ui: { resourceUri: "ui://agent-team/team-panel.html", surface: "agent-team-panel" },
        });
        // 0.4.0：spawn 无模型参数（成员模型唯一路线 = 跟随 Lead）
        const props = schema.properties as Record<string, unknown>;
        expect(props).not.toHaveProperty("model");
        expect(props).not.toHaveProperty("thoughtLevel");
      } else {
        expect(tool._meta).toBeUndefined();
      }
    }
    // member_set_model 彻底不在工具面
    expect(TEAM_TOOL_DEFINITIONS.map((t) => t.name)).not.toContain("member_set_model");
  });

  it("〔对齐轮 D3〕interrupt=false → 8 工具（interrupt_agent 不注册；其余逐字不变）", () => {
    const nine = teamToolDefinitions({ interrupt: true });
    const eight = teamToolDefinitions({ interrupt: false });
    expect(nine.map((t) => t.name)).toEqual(NINE);
    expect(eight.map((t) => t.name)).toEqual(NINE.filter((n) => n !== "interrupt_agent"));
    expect(eight).toHaveLength(8);
    // 其余 8 工具条目经 listTeamTools 序列化后逐字节不变
    expect(serializeToolsList(listTeamTools({ interrupt: false }))).toBe(
      serializeToolsList(listTeamTools({ interrupt: true }).filter((t) => (t.name as string) !== "interrupt_agent")),
    );
    expect(teamToolNames({ interrupt: false }).has("interrupt_agent")).toBe(false);
    expect(teamToolNames({ interrupt: true }).has("interrupt_agent")).toBe(true);
    // 默认（无参）= interrupt=true（9 工具）
    expect(teamToolDefinitions().map((t) => t.name)).toEqual(NINE);
  });
});

describe("F01 · schema 逐字节快照（wire 层：真实 stdio daemon）", () => {
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
    expect(fs.existsSync(DAEMON), "dist/team-daemon.mjs 缺失——先 npm run build").toBe(true);
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-snapshot-"));
    home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    pending = new Map();
    nextId = 1;
    proc = execFile(process.execPath, [DAEMON], {
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME: home, TEAM_PLUGIN_DATA: root, TEAM_PROJECT_DIR: root },
    }) as unknown as ChildProcess;
    // execFile 返回 ChildProcess（stdout 可用）；手动接管流解析
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
      clientInfo: { name: "f01-snapshot", version: "0" },
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

  it("wire tools/list 的 9 工具条目逐字节 = 期望 JSON（模型面不含 team_ping）", async () => {
    const res = (await rpc("tools/list")) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const allNames = res.result.tools.map((t) => t.name as string);
    // 模型面 = 9 个团队工具；team_ping 仅 TEAM_DEBUG_TOOLS=1 诊断暴露；panel 回环保留 app 通道。
    expect(allNames).not.toContain("team_ping");
    expect(allNames).not.toContain("member_set_model");
    expect(allNames).toContain("team_panel_call");
    const nine = res.result.tools.filter((t) => NINE.includes(t.name as string));
    expect(nine.map((t) => t.name)).toEqual(NINE); // 顺序冻结
    const actual = JSON.stringify({ tools: nine });
    expect(actual).toBe(expectedToolsListJson());
  });

  it("〔0.4.0〕资源面 = 面板 + 视图帧；team://models 已下线", async () => {
    const list = (await rpc("resources/list")) as {
      result: { resources: Array<{ uri: string }> };
    };
    const uris = list.result.resources.map((r) => r.uri);
    expect(uris).not.toContain("team://models");
    expect(uris).toContain("team://view");
    expect(uris).toContain("ui://agent-team/team-panel.html");
    const read = (await rpc("resources/read", { uri: "team://models" })) as { error?: { message?: string } };
    expect(read.error?.message).toContain("TEAM_UNKNOWN_RESOURCE");
  });
});
