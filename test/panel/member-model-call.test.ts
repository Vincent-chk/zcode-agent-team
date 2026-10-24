// 面板模型设置通道（stage-8 Round D）：team_panel_call modelOptions / setMemberModel。
// 夹具 = MockProvider + 真实 backend（方法表通路）+ 注入的固定模型目录 + 独立测试库。
// 安全：目录为白名单投影（本测试用占位值反查脱敏）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { teamPaths } from "../../src/coord/paths.js";
import { PanelViewService } from "../../src/panel/view-service.js";
import { handlePanelCall, type PanelCallResult } from "../../src/panel/panel-call.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { memberPaths, writeOrigin, type OriginRecord } from "../../src/provider/member-files.js";
import { createTestDb, insertSessionEntry } from "../provider/kit.js";
import type { ModelCatalog } from "../../src/provider/model-catalog.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

const LEAD = "sess_s8_panel_lead";
const BOOT = Date.now();
/** 占位符：验证目录透传不夹带凭据；不是可用凭据。 */
const PLACEHOLDER_VALUE = "placeholder-not-a-real-credential";

const CATALOG: ModelCatalog = {
  providers: [
    {
      providerId: "prov-a",
      name: "Provider A",
      kind: "anthropic",
      enabled: true,
      models: [{ id: "model-a", reasoning: { variants: ["low", "high"], defaultVariant: "high" } }],
    },
  ],
};

let root = "";
let dataRoot = "";
let dbPath = "";
let db: DatabaseSync;
let backend: TeamToolBackend;
let provider: MockProvider;
let service: PanelViewService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s8-settings-"));
  dataRoot = path.join(root, "data");
  dbPath = path.join(root, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
  provider = new MockProvider();
  backend = new TeamToolBackend({
    dataRoot,
    limits: LIMITS,
    provider,
    // 目录注入：白名单投影（真实读取在 model-catalog.test / wire 资源测试覆盖）
    modelCatalog: () => ({ providers: [{ ...CATALOG.providers[0]!, name: "Provider A" }] }),
  });
  service = new PanelViewService({ dataRoot, bootTimeMs: BOOT, backend });
});

afterEach(async () => {
  await backend.close().catch(() => undefined);
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const leadMeta = { session_id: LEAD };

function deps(extra: Partial<Parameters<typeof handlePanelCall>[0]> = {}): Parameters<typeof handlePanelCall>[0] {
  let counter = 0;
  return {
    view: service,
    dataRoot,
    bootTimeMs: BOOT,
    reader: new TranscriptReader({ dbPath }),
    bumpCounter: () => (counter += 1),
    backend,
    catalog: () => CATALOG,
    ...extra,
  };
}

const IDENTITY = {
  sessionId: LEAD,
  teamId: LEAD,
  role: "lead" as const,
  name: "lead",
  agentId: LEAD,
  source: "meta" as const,
  hookRegistered: true,
};

async function spawn(name: string): Promise<string> {
  await backend.spawnTeammate(IDENTITY, { name, description: `${name} desc`, prompt: `work ${name}` });
  const frame = await service.buildFrame(leadMeta);
  return frame.members.find((m) => m.target === name)!.id;
}

function teamDir(): string {
  return teamPaths(dataRoot, LEAD).teamDir;
}

function writeMemberOrigin(memberId: string, extra: Partial<OriginRecord> = {}): void {
  writeOrigin(memberPaths(teamDir(), memberId), {
    teamId: LEAD,
    memberId,
    name: "alice",
    provider: "spawn",
    mode: "continuable",
    context: "fresh",
    createdAt: new Date().toISOString(),
    cwd: root,
    firstPromptText: "work alice",
    firstPromptSha256: "sha",
    initialUserMessageAccepted: true,
    sessionId: "sess_child_alice",
    ...extra,
  });
}

async function modelOptions(memberId?: string): Promise<Extract<PanelCallResult, { kind: "modelOptions" }>> {
  const result = await handlePanelCall(
    deps(),
    { action: "modelOptions", ...(memberId !== undefined ? { memberId } : {}) },
    leadMeta,
  );
  expect(result.kind, JSON.stringify(result)).toBe("modelOptions");
  return result as Extract<PanelCallResult, { kind: "modelOptions" }>;
}

async function setModel(
  args: Record<string, unknown>,
  overrides: Partial<Parameters<typeof handlePanelCall>[0]> = {},
): Promise<PanelCallResult> {
  return handlePanelCall(deps(overrides), { action: "setMemberModel", ...args }, leadMeta);
}

async function errorOf(p: Promise<PanelCallResult>): Promise<{ code: string; message: string }> {
  const result = await p;
  expect(result.kind, JSON.stringify(result)).toBe("error");
  return result as Extract<PanelCallResult, { kind: "error" }>;
}

describe("modelOptions", () => {
  it("memberId 缺省 → 仅目录（面板全局刷新）", async () => {
    const result = await modelOptions();
    expect(result.catalog).toEqual(CATALOG);
    expect(result.memberId).toBeUndefined();
    expect(result.current).toBeUndefined();
  });

  it("无 origin/session_entry → cli-default", async () => {
    const memberId = await spawn("alice");
    const result = await modelOptions(memberId);
    expect(result).toMatchObject({ memberId, memberName: "alice" });
    expect(result.current).toEqual({ source: "cli-default" });
  });

  it("origin explicit → 当前值 + explicit", async () => {
    const memberId = await spawn("alice");
    writeMemberOrigin(memberId, {
      modelSelection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" },
      modelSource: "explicit",
    });
    expect((await modelOptions(memberId)).current).toEqual({
      model: "model-a",
      providerId: "prov-a",
      reasoningLevel: "high",
      source: "explicit",
    });
  });

  it("origin inherited → inherited（继承自 Lead）", async () => {
    const memberId = await spawn("alice");
    writeMemberOrigin(memberId, {
      modelSelection: { providerId: "lead-prov", modelId: "lead-model" },
      modelSource: "inherited",
    });
    expect((await modelOptions(memberId)).current).toEqual({
      model: "lead-model",
      providerId: "lead-prov",
      source: "inherited",
    });
  });

  it("无 origin 选择 → session_entry 条目（observed，含强度）", async () => {
    const memberId = await spawn("alice");
    writeMemberOrigin(memberId); // 只有 sessionId
    insertSessionEntry(dbPath, {
      sessionId: "sess_child_alice",
      data: { modelSelection: { providerId: "prov-x", modelId: "model-x", options: { reasoningLevel: "max" } } },
    });
    expect((await modelOptions(memberId)).current).toEqual({
      model: "model-x",
      providerId: "prov-x",
      reasoningLevel: "max",
      source: "observed",
    });
  });

  it("无 session_entry → 消息实测模型（observed，仅模型名）", async () => {
    const memberId = await spawn("alice");
    writeMemberOrigin(memberId);
    const d = new DatabaseSync(dbPath);
    d.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)",
    ).run(
      "msg_observed",
      "sess_child_alice",
      Date.now(),
      Date.now(),
      JSON.stringify({
        role: "user",
        semantics: { origin: "real_user" },
        modelSelection: { providerId: "p", modelId: "message-model" },
      }),
      0,
    );
    d.close();
    expect((await modelOptions(memberId)).current).toEqual({ model: "message-model", source: "observed" });
  });

  it("目标不存在 → TEAM_MEMBER_NOT_FOUND；memberId 空串 → TEAM_INVALID_ARGUMENT", async () => {
    expect(
      await errorOf(
        handlePanelCall(deps(), { action: "modelOptions", memberId: "m_ghost" }, leadMeta),
      ),
    ).toMatchObject({
      code: "TEAM_MEMBER_NOT_FOUND",
      message: 'active teammate "m_ghost" not found',
    });
    const empty = await handlePanelCall(deps(), { action: "modelOptions", memberId: "" }, leadMeta);
    expect(empty).toMatchObject({ kind: "error", code: "TEAM_INVALID_ARGUMENT" });
  });

  it("目录透传不夹带凭据（白名单投影的调用约定）", async () => {
    const result = await modelOptions();
    const text = JSON.stringify(result.catalog);
    expect(text).not.toContain(PLACEHOLDER_VALUE);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("baseURL");
  });
});

describe("setMemberModel", () => {
  it("Lead 空闲成员 → applied:now；backend 按 target 名下发结构化选择", async () => {
    const memberId = await spawn("alice");
    const result = await setModel({ memberId, model: "prov-a$model-a", thoughtLevel: "high" });
    expect(result).toMatchObject({ kind: "modelSet", applied: "now", memberId });
    expect(provider.modelSetCalls).toEqual([
      {
        memberId,
        modelSelection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" },
      },
    ]);
  });

  it("provider 返回 next-turn → 原样透出", async () => {
    const memberId = await spawn("alice");
    provider.programWith({ modelSetResults: ["next-turn"] });
    expect(await setModel({ memberId, model: "prov-a$model-a" })).toMatchObject({
      kind: "modelSet",
      applied: "next-turn",
    });
  });

  it("thoughtLevel-only → 只下发强度（模型基底由 provider 合并）", async () => {
    const memberId = await spawn("alice");
    await setModel({ memberId, thoughtLevel: "low" });
    expect(provider.modelSetCalls).toEqual([{ memberId, thoughtLevel: "low" }]);
  });

  it("参数守卫：缺 memberId / 缺 model+thoughtLevel / 空串 / 非字符串", async () => {
    const memberId = await spawn("alice");
    expect(await errorOf(setModel({ model: "prov-a$model-a" }))).toMatchObject({
      code: "TEAM_INVALID_ARGUMENT",
      message: 'param "memberId" must be a non-empty string',
    });
    expect(await errorOf(setModel({ memberId }))).toMatchObject({
      code: "TEAM_INVALID_ARGUMENT",
      message: 'param "model" or "thoughtLevel" is required',
    });
    expect(await errorOf(setModel({ memberId, model: "" }))).toMatchObject({
      code: "TEAM_INVALID_ARGUMENT",
      message: 'param "model" must be a non-empty string',
    });
    expect(await errorOf(setModel({ memberId, thoughtLevel: "" }))).toMatchObject({
      code: "TEAM_INVALID_ARGUMENT",
      message: 'param "thoughtLevel" must be a non-empty string',
    });
    expect(await errorOf(setModel({ memberId, model: 42 }))).toMatchObject({
      code: "TEAM_INVALID_ARGUMENT",
    });
  });

  it("目标不存在 → TEAM_MEMBER_NOT_FOUND", async () => {
    expect(await errorOf(setModel({ memberId: "m_ghost", model: "prov-a$model-a" }))).toMatchObject({
      code: "TEAM_MEMBER_NOT_FOUND",
    });
  });

  it("未注入 backend → 可读错误（不静默）", async () => {
    const memberId = await spawn("alice");
    const result = await handlePanelCall(
      deps({ backend: undefined }),
      { action: "setMemberModel", memberId, model: "prov-a$model-a" },
      leadMeta,
    );
    expect(result).toMatchObject({
      kind: "error",
      code: "TEAM_INVALID_ARGUMENT",
      message: "model changes are unavailable in this panel session",
    });
  });

  it("目录校验失败（thoughtLevel 不在 variants）→ 错误透传", async () => {
    const memberId = await spawn("alice");
    const err = await errorOf(setModel({ memberId, model: "prov-a$model-a", thoughtLevel: "max" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toContain("thoughtLevel \"max\" is not supported");
  });
});
