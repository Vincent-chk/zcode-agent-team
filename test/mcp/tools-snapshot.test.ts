// F01 · tools/list 逐字节快照（stage-3 T3.5a）。
// 两层：① 进程内 listTeamTools()（注册表原样）vs 期望生成器（02 §9 独立转写，test/mcp/
// expected-tools.ts）——同一序列化器（JSON.stringify 无缩进）逐字节 diff = 0（9/9）；
// ② wire 层：真实孵化 dist/team-daemon.mjs（stdio JSON-RPC）→ tools/list → 过滤 10 工具 →
// 同一序列化器逐字节 diff = 0（宿主实际看到的字节）。
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

/** team://models 夹具占位符（不是可用凭据；仅验证脱敏投影）。 */
const PLACEHOLDER_VALUE = "placeholder-not-a-real-credential";
const PLACEHOLDER_URL = "https://placeholder.invalid/v1";

const TEN = EXPECTED_TEAM_TOOLS.map((t) => t.name as string);

describe("F01 · schema 逐字节快照（进程内注册表）", () => {
  it("10 工具注册表原样 = 期望 JSON（同一序列化器，diff = 0）", () => {
    expect(TEAM_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(TEN);
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
      } else {
        expect(tool._meta).toBeUndefined();
      }
    }
  });

  it("〔对齐轮 D3〕interrupt=false → 9 工具（interrupt_agent 不注册；其余逐字不变）", () => {
    const ten = teamToolDefinitions({ interrupt: true });
    const nine = teamToolDefinitions({ interrupt: false });
    expect(ten.map((t) => t.name)).toEqual(TEN);
    expect(nine.map((t) => t.name)).toEqual(TEN.filter((n) => n !== "interrupt_agent"));
    expect(nine).toHaveLength(9);
    // 其余 9 工具条目经 listTeamTools 序列化后逐字节不变
    expect(serializeToolsList(listTeamTools({ interrupt: false }))).toBe(
      serializeToolsList(listTeamTools({ interrupt: true }).filter((t) => (t.name as string) !== "interrupt_agent")),
    );
    expect(teamToolNames({ interrupt: false }).has("interrupt_agent")).toBe(false);
    expect(teamToolNames({ interrupt: true }).has("interrupt_agent")).toBe(true);
    // 默认（无参）= interrupt=true（10 工具）
    expect(teamToolDefinitions().map((t) => t.name)).toEqual(TEN);
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
    // stage-8 Round C/E-1b：team://models 读 HOME 下固定配置。
    // 主源 = provider_config.json（注册表；含明文占位凭据→必须脱敏）；config.json 只提供 reasoning 元数据。
    home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "v2", "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ["prov-x"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "prov-x",
                providerName: "Provider X",
                config: {
                  access: { type: "api-key", apiKey: PLACEHOLDER_VALUE },
                  api: { type: "anthropic", baseUrl: PLACEHOLDER_URL },
                  modelOrder: ["model-x", "model-plain", "model-off"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              { providerId: "prov-x", modelId: "model-off", config: { enabled: false } },
            ],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".zcode", "v2", "config.json"),
      JSON.stringify({
        provider: {
          "prov-x": {
            name: "Ignored Config Name",
            kind: "ignored",
            options: { apiKey: PLACEHOLDER_VALUE, baseURL: PLACEHOLDER_URL },
            models: {
              "model-x": { reasoning: { enabled: true, variants: ["low", "max"], defaultVariant: "max" } },
            },
          },
        },
      }),
    );
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

  it("wire tools/list 的 10 工具条目逐字节 = 期望 JSON（模型面不含 team_ping）", async () => {
    const res = (await rpc("tools/list")) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const allNames = res.result.tools.map((t) => t.name as string);
    // 模型面 = 10 个团队工具；team_ping 仅 TEAM_DEBUG_TOOLS=1 诊断暴露；panel 回环保留 app 通道。
    expect(allNames).not.toContain("team_ping");
    expect(allNames).toContain("team_panel_call");
    const ten = res.result.tools.filter((t) => TEN.includes(t.name as string));
    expect(ten.map((t) => t.name)).toEqual(TEN); // 顺序冻结
    const actual = JSON.stringify({ tools: ten });
    expect(actual).toBe(expectedToolsListJson());
  });

  it("〔stage-8 C/E-1b〕team://models 资源：注册表主源 + 白名单投影（不含 access/api/凭据）", async () => {
    const list = (await rpc("resources/list")) as {
      result: { resources: Array<{ uri: string; name: string; mimeType: string }> };
    };
    expect(list.result.resources.find((r) => r.uri === "team://models")).toMatchObject({
      name: "agent-team-models",
      mimeType: "application/json",
    });
    const read = (await rpc("resources/read", { uri: "team://models" })) as {
      result: { contents: Array<{ uri: string; mimeType: string; text: string }> };
    };
    const content = read.result.contents[0]!;
    expect(content).toMatchObject({ uri: "team://models", mimeType: "application/json" });
    expect(JSON.parse(content.text)).toEqual({
      providers: [
        {
          providerId: "prov-x",
          name: "Provider X",
          kind: "anthropic",
          enabled: true,
          models: [
            {
              id: "model-x",
              enabled: true,
              reasoning: { variants: ["low", "max"], defaultVariant: "max" },
            },
            { id: "model-plain", enabled: true },
            // Registry 的 providerModelRules 停用位
            { id: "model-off", enabled: false },
          ],
        },
      ],
    });
    expect(content.text).not.toContain(PLACEHOLDER_VALUE);
    expect(content.text).not.toContain(PLACEHOLDER_URL);
    expect(content.text).not.toContain("options");
    expect(content.text).not.toContain('"access"');
    expect(content.text).not.toContain('"api"');
    expect(content.text).toContain("model-off"); // 停用模型仍列出但 enabled:false
    // 重复读命中 mtime 缓存：内容稳定
    const again = (await rpc("resources/read", { uri: "team://models" })) as {
      result: { contents: Array<{ text: string }> };
    };
    expect(again.result.contents[0]!.text).toBe(content.text);
  });
});
