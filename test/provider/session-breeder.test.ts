// 会话培育器（stage-6）：v4 createSession（anchor）+ createSelectionSideSession（隐藏 child）
// + anchor tombstone。夹具 = fake-app-server.mjs（真子进程，NDJSON 协议）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppServerSessionBreeder, isolationModeFromEnv } from "../../src/provider/session-breeder.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const FAKE = path.join(PROJ, "test", "provider", "fake-app-server.mjs");

const DDL =
  "CREATE TABLE tasks (" +
  "workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT," +
  "task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT," +
  "mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT," +
  "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER," +
  "last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0," +
  "archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0," +
  "title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'," +
  "searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT," +
  "PRIMARY KEY (workspace_key, task_id))";

let root: string;
let tasksIndexPath: string;
let recordPath: string;

function createTasksIndex(file: string): void {
  const db = new DatabaseSync(file);
  db.prepare(DDL).run();
  db.close();
}

function taskRow(taskId: string): { title: string; archived: number; deleted: number } | undefined {
  const db = new DatabaseSync(tasksIndexPath, { readOnly: true });
  try {
    return db.prepare("select title, archived, deleted from tasks where task_id = ?").get(taskId) as
      | { title: string; archived: number; deleted: number }
      | undefined;
  } finally {
    db.close();
  }
}

function breeder(): AppServerSessionBreeder {
  return new AppServerSessionBreeder({
    zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
    tasksIndexPath,
    log: () => undefined,
    readyTimeoutMs: 8_000,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-breed-"));
  tasksIndexPath = path.join(root, "tasks-index.sqlite");
  recordPath = path.join(root, "requests.jsonl");
  createTasksIndex(tasksIndexPath);
  process.env.FAKE_APP_SERVER_RECORD = recordPath;
});

afterEach(() => {
  delete process.env.FAKE_APP_SERVER_RECORD;
  delete process.env.FAKE_APP_SERVER_FAIL;
  delete process.env.FAKE_APP_SERVER_CHILD;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("AppServerSessionBreeder.createChild", () => {
  it("建 anchor + 隐藏 child，并给 anchor 写 tombstone", async () => {
    const result = await breeder().createChild({ teamId: "sess_lead", workspacePath: root });
    expect(result.anchorSessionId).toBe("sess_fake_anchor");
    expect(result.childSessionId).toBe("sess_fake_child");
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1, archived: 0 });
    expect(taskRow("sess_fake_child")).toBeUndefined();
  });

  it("v4 请求形状：createSession(permissionScope) → createSelectionSideSession → session/setModel", async () => {
    await breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" },
    });
    const requests = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    expect(requests).toHaveLength(3);
    const create = requests[0]!;
    const side = requests[1]!;
    expect(create.method).toBe("v4/command");
    expect(create.params.type).toBe("createSession");
    expect(create.params.sessionId).toBeNull();
    expect(create.params.payload).toMatchObject({ workspaceId: root, permissionScope: "session" });
    expect(typeof create.params.commandId).toBe("string");
    expect(typeof create.params.clientId).toBe("string");
    expect(typeof create.params.issuedAt).toBe("number");
    expect(side.params.type).toBe("createSelectionSideSession");
    expect(side.params.sessionId).toBe("sess_fake_anchor");
    expect(side.params.payload).toEqual({});
    // 同实例 child 活跃时 setModel（Round A PoC-1）：持久化开关显式 false
    const setModel = requests[2]!;
    expect(setModel.method).toBe("session/setModel");
    expect(setModel.params).toEqual({
      sessionId: "sess_fake_child",
      model: { providerId: "prov-a", modelId: "model-a", options: { reasoningLevel: "high" } },
      persistAsWorkspaceLastUsed: false,
    });
  });

  it("无 modelSelection → 不调 setModel（仅 2 个 v4 请求）", async () => {
    await breeder().createChild({ teamId: "sess_lead", workspacePath: root });
    const requests = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string });
    expect(requests).toHaveLength(2);
    expect(requests.some((r) => r.method === "session/setModel")).toBe(false);
  });

  it("reasoningLevel 缺省 → setModel.model 不含 options", async () => {
    await breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: { providerId: "prov-b", modelId: "model-b" },
    });
    const requests = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params: { model?: unknown } });
    const setModel = requests.find((r) => r.method === "session/setModel")!;
    expect(setModel.params.model).toEqual({ providerId: "prov-b", modelId: "model-b" });
  });

  it("setModel 失败 → 容忍继续 spawn；只记目标三元组与错误文本（不落 result）", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: { providerId: "prov-c", modelId: "model-c", reasoningLevel: "max" },
    });
    expect(result.childSessionId).toBe("sess_fake_child");
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1 });
    expect(records.some((r) => r.event === "session-bred")).toBe(true);
    const failure = records.find((r) => r.event === "model-set-failed")!;
    expect(failure).toMatchObject({
      teamId: "sess_lead",
      childSessionId: "sess_fake_child",
      providerId: "prov-c",
      modelId: "model-c",
      reasoningLevel: "max",
      message: "fake setModel failure",
    });
    expect(failure).not.toHaveProperty("result"); // 巨型消息快照不得整包落日志
  });

  it("已存在同 task_id 的用户任务 → 拒绝 tombstone（保护用户行）", async () => {
    const db = new DatabaseSync(tasksIndexPath);
    db.prepare(
      "insert into tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at) values (?,?,?,?,?,?)",
    ).run(root, root, "sess_fake_anchor", "用户自己的任务", Date.now(), Date.now());
    db.close();
    // row-not-owned 不得静默：否则 anchor 会在下次基线补登时露出任务栏。
    await expect(
      breeder().createChild({ teamId: "sess_lead", workspacePath: root }),
    ).rejects.toMatchObject({ code: "create-rejected" });
    expect(taskRow("sess_fake_anchor")).toMatchObject({ title: "用户自己的任务", deleted: 0 });
  });

  it("app-server 未 ready → BreedError(startup-timeout)", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "ready";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      readyTimeoutMs: 600,
    });
    await expect(b.createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "startup-timeout",
    });
  });

  it("createSelectionSideSession 被拒 → BreedError(command-rejected)；anchor 已先 tombstone（不露任务栏）", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "side";
    await expect(breeder().createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "command-rejected",
    });
    // Round-2 B7：tombstone 前移到 child 之前 → 失败时 anchor 行存在但必须 deleted=1。
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1, archived: 0 });
  });

  it("createSession 成功后 RPC 崩溃 → 失败日志带 anchor id，且 anchor 保持 tombstone", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "side";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    await expect(b.createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "command-rejected",
    });
    const failure = records.find((r) => r.event === "session-breed-failed");
    expect(failure).toMatchObject({ code: "command-rejected", anchorSessionId: "sess_fake_anchor" });
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1 });
  });

  it("disposeBredSessions：幂等补 tombstone，不插入/不删行", () => {
    const b = breeder();
    // 行不存在 → tombstoneAnchor 会插入 anchor 行（这是允许的 D25 白名单写入）
    const first = b.disposeBredSessions({ anchorSessionId: "sess_orphan_anchor", workspacePath: root });
    expect(first.applied).toBe(true);
    expect(taskRow("sess_orphan_anchor")).toMatchObject({ deleted: 1 });
    const second = b.disposeBredSessions({ anchorSessionId: "sess_orphan_anchor", workspacePath: root });
    expect(second.applied).toBe(true); // upsert 幂等：仍是 deleted=1
    expect(taskRow("sess_orphan_anchor")).toMatchObject({ deleted: 1 });
  });

  it("可执行文件非绝对路径 → 立即 spawn-failed（不启动进程）", async () => {
    const b = new AppServerSessionBreeder({
      zcode: { command: "node", argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      readyTimeoutMs: 600,
    });
    await expect(b.createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "spawn-failed",
    });
  });

  it("createSession 被拒 → BreedError(create-rejected)", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "create";
    await expect(breeder().createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "create-rejected",
    });
  });

  it("协议层 RPC error → BreedError(unsupported)", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "error";
    await expect(breeder().createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("任务索引文件缺失 → 仍建 child（tombstone 跳过，不报错）", async () => {
    const missing = path.join(root, "no-such.sqlite");
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath: missing,
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({ teamId: "sess_lead", workspacePath: root });
    expect(result.childSessionId).toBe("sess_fake_child");
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe("AppServerSessionBreeder.applyModelSelection（mid-life）", () => {
  const SELECTION = { providerId: "prov-m", modelId: "model-m", reasoningLevel: "high" };

  function readRequests(): Array<{ method: string; params: Record<string, unknown> }> {
    return fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
  }

  it("临时实例：session/resume {sessionId} → session/setModel（persistAsWorkspaceLastUsed:false）", async () => {
    const result = await breeder().applyModelSelection({
      sessionId: "sess_existing",
      workspacePath: root,
      selection: SELECTION,
    });
    expect(result).toEqual({ applied: true });
    const requests = readRequests();
    expect(requests.map((r) => r.method)).toEqual(["session/resume", "session/setModel"]);
    expect(requests[0]!.params).toEqual({ sessionId: "sess_existing" });
    expect(requests[1]!.params).toEqual({
      sessionId: "sess_existing",
      model: { providerId: "prov-m", modelId: "model-m", options: { reasoningLevel: "high" } },
      persistAsWorkspaceLastUsed: false,
    });
  });

  it("resume 失败 → applied:false + reason（不抛错；只记目标，不落 result）", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "resume";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.applyModelSelection({
      sessionId: "sess_existing",
      workspacePath: root,
      selection: SELECTION,
    });
    expect(result).toMatchObject({ applied: false, reason: "fake resume failure" });
    const failure = records.find((r) => r.event === "model-apply-failed")!;
    expect(failure).toMatchObject({ sessionId: "sess_existing", reason: "fake resume failure" });
    expect(failure).not.toHaveProperty("result");
  });

  it("setModel 失败 → applied:false（resume 已成功后仍不崩）", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const result = await breeder().applyModelSelection({
      sessionId: "sess_existing",
      workspacePath: root,
      selection: SELECTION,
    });
    expect(result).toMatchObject({ applied: false, reason: "fake setModel failure" });
  });

  it("临时实例启动失败（可执行文件非绝对路径）→ applied:false", async () => {
    const b = new AppServerSessionBreeder({
      zcode: { command: "node", argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
    });
    const result = await b.applyModelSelection({
      sessionId: "sess_existing",
      workspacePath: root,
      selection: SELECTION,
    });
    expect(result).toMatchObject({ applied: false });
    expect(result.reason).toContain("absolute path");
  });

  it("app-server 未 ready → applied:false（超时不抛错）", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "ready";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      readyTimeoutMs: 600,
    });
    const result = await b.applyModelSelection({
      sessionId: "sess_existing",
      workspacePath: root,
      selection: SELECTION,
    });
    expect(result).toMatchObject({ applied: false });
    expect(result.reason).toContain("did not become ready");
  });
});

describe("AppServerSessionBreeder.createChild · 模型兜底（Round E-1）", () => {
  const PRIMARY = { providerId: "account:unavailable-plan", modelId: "GLM-5.3", reasoningLevel: "max" };
  const FALLBACK = { providerId: "fallback-prov", modelId: "fallback-model", reasoningLevel: "max" };

  function readRequests(): Array<{ method: string; params: Record<string, unknown> }> {
    return fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
  }

  it("主选成功 → appliedModel=primary；不尝试兜底；日志 model-set(primary)", async () => {
    const records: Array<Record<string, unknown>> = [];
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: PRIMARY,
      modelFallback: FALLBACK,
    });
    expect(result.appliedModel).toEqual(PRIMARY);
    // 主选成功 → 只有一次 setModel（3 个请求：create / side / setModel）
    expect(readRequests().filter((r) => r.method === "session/setModel")).toHaveLength(1);
    expect(records.find((r) => r.event === "model-set")).toMatchObject({
      which: "primary",
      providerId: PRIMARY.providerId,
      modelId: PRIMARY.modelId,
    });
    expect(records.some((r) => r.event === "model-set-failed")).toBe(false);
  });

  it("主选失败 → 兜底成功：appliedModel=fallback；日志 model-set-failed + model-set(fallback)", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "setModel-once";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: PRIMARY,
      modelFallback: FALLBACK,
    });
    expect(result.appliedModel).toEqual(FALLBACK);
    const setModelCalls = readRequests().filter((r) => r.method === "session/setModel");
    expect(setModelCalls).toHaveLength(2);
    expect(setModelCalls[0]!.params.model).toMatchObject({ modelId: PRIMARY.modelId });
    expect(setModelCalls[1]!.params.model).toMatchObject({ modelId: FALLBACK.modelId });
    expect(records.find((r) => r.event === "model-set-failed")).toMatchObject({
      childSessionId: "sess_fake_child",
      modelId: PRIMARY.modelId,
      message: "fake setModel failure",
    });
    expect(records.find((r) => r.event === "model-set")).toMatchObject({
      which: "fallback",
      modelId: FALLBACK.modelId,
    });
    expect(records.some((r) => r.event === "model-set-fallback-failed")).toBe(false);
  });

  it("主选失败 + 兜底也失败 → 无 appliedModel；两条失败日志", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: PRIMARY,
      modelFallback: FALLBACK,
    });
    expect(result.appliedModel).toBeUndefined();
    expect(result.childSessionId).toBe("sess_fake_child"); // spawn 仍然成功（不因模型失败而失败）
    expect(readRequests().filter((r) => r.method === "session/setModel")).toHaveLength(2);
    const primaryFail = records.find((r) => r.event === "model-set-failed")!;
    const fallbackFail = records.find((r) => r.event === "model-set-fallback-failed")!;
    expect(primaryFail).toMatchObject({ modelId: PRIMARY.modelId, message: "fake setModel failure" });
    expect(fallbackFail).toMatchObject({ modelId: FALLBACK.modelId, message: "fake setModel failure" });
    expect(primaryFail).not.toHaveProperty("result");
    expect(fallbackFail).not.toHaveProperty("result");
    expect(records.some((r) => r.event === "model-set")).toBe(false);
  });

  it("无兜底 + 主选失败 → 无 appliedModel，只记 model-set-failed（不出现 fallback 日志）", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const result = await b.createChild({
      teamId: "sess_lead",
      workspacePath: root,
      modelSelection: PRIMARY,
    });
    expect(result.appliedModel).toBeUndefined();
    expect(readRequests().filter((r) => r.method === "session/setModel")).toHaveLength(1);
    expect(records.some((r) => r.event === "model-set-failed")).toBe(true);
    expect(records.some((r) => r.event === "model-set-fallback-failed")).toBe(false);
  });
});

describe("isolationModeFromEnv", () => {
  it("默认 child；显式 legacy 才回滚", () => {
    expect(isolationModeFromEnv({})).toBe("child");
    expect(isolationModeFromEnv({ TEAM_SESSION_ISOLATION: "legacy" })).toBe("legacy");
    expect(isolationModeFromEnv({ TEAM_SESSION_ISOLATION: "child" })).toBe("child");
  });
});

describe("AppServerSessionBreeder.resolveWorkspace", () => {
  it("优先用会话库中 Lead 的真实目录（daemon env 可能是别的工作区）", () => {
    const dbPath = path.join(root, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
    ).run();
    db.prepare("insert into session (id, directory, time_created, time_updated) values (?,?,?,?)").run(
      "sess_lead_real",
      "/tmp/real-workspace",
      Date.now(),
      Date.now(),
    );
    db.close();
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      dbPath,
    });
    expect(b.resolveWorkspace("sess_lead_real", "/tmp/fallback")).toBe(path.resolve("/tmp/real-workspace"));
    // 查不到 / 库缺失 → 回退
    expect(b.resolveWorkspace("sess_unknown", "/tmp/fallback")).toBe(path.resolve("/tmp/fallback"));
    const missing = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      dbPath: path.join(root, "nope.sqlite"),
    });
    expect(missing.resolveWorkspace("sess_any", "/tmp/fallback")).toBe(path.resolve("/tmp/fallback"));
  });

  it("createChild 用解析后的工作区建 anchor（不信任传入的 env 值）", async () => {
    const dbPath = path.join(root, "session2.sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
    ).run();
    db.prepare("insert into session (id, directory, time_created, time_updated) values (?,?,?,?)").run(
      "sess_lead_ws",
      root,
      Date.now(),
      Date.now(),
    );
    db.close();
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      dbPath,
      readyTimeoutMs: 8_000,
    });
    await b.createChild({ teamId: "sess_lead_ws", workspacePath: "/tmp/wrong-env" });
    const requests = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { params: { payload?: { workspaceId?: string } } });
    expect(requests[0]!.params.payload?.workspaceId).toBe(root);
  });
});
