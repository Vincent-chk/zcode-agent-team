// 会话培育器（stage-6）：v4 createSession（anchor）+ createSelectionSideSession（隐藏 child）
// + anchor tombstone。夹具 = fake-app-server.mjs（真子进程，NDJSON 协议）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTasksIndexFixture } from "./tasks-index.js";
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

const createTasksIndex = createTasksIndexFixture;

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

function readRequests(): Array<{ method: string; params: Record<string, unknown> }> {
  if (!fs.existsSync(recordPath)) return [];
  const text = fs.readFileSync(recordPath, "utf8").trim();
  return text.length === 0
    ? []
    : text.split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
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
  delete process.env.FAKE_APP_SERVER_ANCHOR;
  delete process.env.FAKE_APP_SERVER_ANCHOR_KIND;
  delete process.env.FAKE_APP_SERVER_DROP;
  delete process.env.FAKE_APP_SERVER_COMMAND_TIMEOUT;
  delete process.env.FAKE_APP_SERVER_QUERY;
  delete process.env.FAKE_APP_SERVER_STATE;
  delete process.env.FAKE_APP_SERVER_SESSIONS;
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

  it("固定 commandId + 预分配 anchor：接受后上报宿主证据，不重造 id", async () => {
    const progress: Array<{ anchorSessionId?: string; childSessionId?: string; stage: string }> = [];
    const result = await breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      anchorCommandId: "cmd-anchor-fixed",
      childCommandId: "cmd-child-fixed",
      anchorSessionId: "sess_preallocated_anchor",
      recoveryEvidence: true,
      onProgress: (event) => { progress.push(event); },
    });
    expect(result).toMatchObject({
      anchorSessionId: "sess_preallocated_anchor",
      childSessionId: "sess_fake_child",
    });
    expect(progress).toEqual([
      { anchorSessionId: "sess_preallocated_anchor", stage: "anchor-created" },
      {
        anchorSessionId: "sess_preallocated_anchor",
        childSessionId: "sess_fake_child",
        stage: "child-created",
      },
    ]);
    const requests = readRequests();
    expect(requests.map((request) => request.method)).toEqual([
      "v4/commands/query",
      "session/list",
      "v4/command",
      "v4/command",
    ]);
    const anchorCommand = requests.find((request) => request.params.type === "createSession")!;
    const childCommand = requests.find((request) => request.params.type === "createSelectionSideSession")!;
    expect(anchorCommand.params).toMatchObject({
      commandId: "cmd-anchor-fixed",
      sessionId: null,
      payload: { sessionId: "sess_preallocated_anchor", workspaceId: root },
    });
    expect(childCommand.params).toMatchObject({
      commandId: "cmd-child-fixed",
      sessionId: "sess_preallocated_anchor",
    });
  });

  it("anchor 响应在副作用后丢失：同 client query 恢复，child 只建一次", async () => {
    process.env.FAKE_APP_SERVER_DROP = "create";
    const progress: Array<{ stage: string }> = [];
    const result = await breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-late-anchor",
      childCommandId: "cmd-late-child",
      anchorSessionId: "sess_late_anchor",
      onProgress: (event) => { progress.push(event); },
    });
    expect(result.anchorSessionId).toBe("sess_late_anchor");
    expect(result.childSessionId).toBe("sess_fake_child");
    const requests = readRequests();
    expect(requests.map((request) => request.method)).toEqual([
      "v4/command",
      "v4/commands/query",
      "v4/command",
    ]);
    expect(requests[1]!.params).toEqual({
      commands: [{ sessionId: null, commandId: "cmd-late-anchor" }],
    });
    expect(progress.map((event) => event.stage)).toEqual(["anchor-created", "child-created"]);
    expect(taskRow("sess_late_anchor")).toMatchObject({ deleted: 1 });
  });

  it("child 响应在副作用后丢失：query 恢复同一 child，不重复 createSelectionSideSession", async () => {
    process.env.FAKE_APP_SERVER_DROP = "side";
    const result = await breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-late-side-anchor",
      childCommandId: "cmd-late-side-child",
    });
    expect(result).toMatchObject({ anchorSessionId: "sess_fake_anchor", childSessionId: "sess_fake_child" });
    const requests = readRequests();
    expect(requests.map((request) => request.method)).toEqual([
      "v4/command",
      "v4/command",
      "v4/commands/query",
    ]);
    expect(requests[2]!.params).toEqual({
      commands: [{ sessionId: "sess_fake_anchor", commandId: "cmd-late-side-child" }],
    });
    expect(requests.filter((request) => request.params.type === "createSelectionSideSession")).toHaveLength(1);
  });

  it("query 无终态 → outcome-unknown；不换 commandId、不重复命令、不回收 anchor", async () => {
    process.env.FAKE_APP_SERVER_DROP = "side";
    process.env.FAKE_APP_SERVER_QUERY = "unknown";
    await expect(
      breeder().createChild({
        teamId: "sess_lead",
        workspacePath: root,
        timeoutMs: 100,
        anchorCommandId: "cmd-unknown-anchor",
        childCommandId: "cmd-unknown-child",
      }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    const requests = readRequests();
    expect(requests).toHaveLength(3);
    expect(requests.filter((request) => request.method === "v4/command")).toHaveLength(2);
    // child 的迟到副作用仍可能存在：失败 catch 不得重写 anchor tombstone。
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1 });
  });

  it("query 自身超时 → outcome-unknown；已知 anchor 保留原 tombstone", async () => {
    process.env.FAKE_APP_SERVER_DROP = "query";
    process.env.FAKE_APP_SERVER_COMMAND_TIMEOUT = "side";
    const records: Array<Record<string, unknown>> = [];
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      readyTimeoutMs: 8_000,
      log: (record) => records.push(record),
    });
    await expect(
      b.createChild({ teamId: "sess_lead", workspacePath: root, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(readRequests().map((request) => request.method)).toEqual([
      "v4/command",
      "v4/command",
      "v4/commands/query",
    ]);
    expect(taskRow("sess_fake_anchor")).toMatchObject({ deleted: 1 });
    expect(records.some((record) => record.event === "session-breed-dispose")).toBe(false);
  });

  it("query 返回明确拒绝 → 保留 command-rejected 分类", async () => {
    process.env.FAKE_APP_SERVER_DROP = "side";
    process.env.FAKE_APP_SERVER_QUERY = "rejected";
    await expect(
      breeder().createChild({ teamId: "sess_lead", workspacePath: root, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "command-rejected" });
    expect(readRequests().filter((request) => request.method === "v4/command")).toHaveLength(2);
  });

  it("取消传播到 RPC：不 tombstone 已知 anchor，也不再发 child 命令", async () => {
    process.env.FAKE_APP_SERVER_DROP = "create";
    const controller = new AbortController();
    const pending = breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 10_000,
      anchorSessionId: "sess_abort_anchor",
      signal: controller.signal,
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !readRequests().some((request) => request.method === "v4/command")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(readRequests().map((request) => request.method)).toEqual(["v4/command"]);
    expect(taskRow("sess_abort_anchor")).toBeUndefined();
  });

  it("重启恢复：新 client 查 anchor duplicate，再查/补原 child；绝不重发 createSession", async () => {
    process.env.FAKE_APP_SERVER_STATE = path.join(root, "host-state.json");
    process.env.FAKE_APP_SERVER_DROP = "create-exit";
    const identity = {
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-restart-anchor",
      childCommandId: "cmd-restart-child",
      anchorSessionId: "sess_restart_anchor",
      recoveryEvidence: true,
    } as const;
    await expect(breeder().createChild(identity)).rejects.toMatchObject({ code: "outcome-unknown" });
    delete process.env.FAKE_APP_SERVER_DROP;
    const result = await breeder().createChild(identity);
    expect(result).toMatchObject({ anchorSessionId: "sess_restart_anchor", childSessionId: "sess_fake_child" });
    const requests = readRequests();
    expect(requests.filter((request) => request.method === "v4/commands/query")).toHaveLength(3);
    expect(requests.filter((request) => request.params.type === "createSession")).toHaveLength(1);
    expect(requests.filter((request) => request.params.type === "createSelectionSideSession")).toHaveLength(1);
  });

  it("重启时 child 已落库：两个 query 都恢复，零条新 v4/command", async () => {
    process.env.FAKE_APP_SERVER_STATE = path.join(root, "host-state.json");
    const identity = {
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-complete-anchor",
      childCommandId: "cmd-complete-child",
      anchorSessionId: "sess_complete_anchor",
      recoveryEvidence: true,
    } as const;
    await breeder().createChild(identity);
    fs.truncateSync(recordPath);
    const result = await breeder().createChild(identity);
    expect(result.childSessionId).toBe("sess_fake_child");
    const requests = readRequests();
    expect(requests.map((request) => request.method)).toEqual(["v4/commands/query", "v4/commands/query"]);
    expect(requests.filter((request) => request.method === "v4/command")).toHaveLength(0);
  });

  it("anchor 查询无法重启恢复：session/list 校验预分配 id/workspace/type 后只发原 child id", async () => {
    process.env.FAKE_APP_SERVER_STATE = path.join(root, "host-state.json");
    process.env.FAKE_APP_SERVER_DROP = "create-exit";
    const identity = {
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-list-anchor",
      childCommandId: "cmd-list-child",
      anchorSessionId: "sess_list_anchor",
      recoveryEvidence: true,
    } as const;
    await expect(breeder().createChild(identity)).rejects.toMatchObject({ code: "outcome-unknown" });
    delete process.env.FAKE_APP_SERVER_DROP;
    // 模拟 anchor receipt 只保存在已退出 client；持久 session 仍可枚举。
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_APP_SERVER_STATE, "utf8")) as { commands: unknown[] };
    state.commands = [];
    fs.writeFileSync(process.env.FAKE_APP_SERVER_STATE, JSON.stringify(state));
    // 用独立的 session 存储模拟真实宿主的持久 session 与易失 command receipt。
    process.env.FAKE_APP_SERVER_SESSIONS = path.join(root, "sessions.json");
    fs.writeFileSync(process.env.FAKE_APP_SERVER_SESSIONS, JSON.stringify([{
      sessionId: "sess_list_anchor",
      sessionKind: "interactive",
      workspace: { workspacePath: root, workspaceKey: root },
    }]));
    const result = await breeder().createChild(identity);
    expect(result.childSessionId).toBe("sess_fake_child");
    const requests = readRequests();
    expect(requests.slice(-4).map((request) => request.method)).toEqual([
      "v4/commands/query",
      "session/list",
      "v4/commands/query",
      "v4/command",
    ]);
    expect(requests.at(-1)!.params).toMatchObject({ commandId: "cmd-list-child", type: "createSelectionSideSession" });
    expect(requests.filter((request) => request.params.type === "createSession")).toHaveLength(1);
  });

  it("session/list 的 sessionKind 不匹配 → outcome-unknown，不重建 anchor/child", async () => {
    process.env.FAKE_APP_SERVER_SESSIONS = path.join(root, "sessions.json");
    fs.writeFileSync(process.env.FAKE_APP_SERVER_SESSIONS, JSON.stringify([{
      sessionId: "sess_wrong_kind",
      sessionKind: "selection_side_chat",
      workspace: { workspacePath: root, workspaceKey: root },
    }]));
    await expect(breeder().createChild({
      teamId: "sess_lead",
      workspacePath: root,
      timeoutMs: 100,
      anchorCommandId: "cmd-wrong-kind-anchor",
      childCommandId: "cmd-wrong-kind-child",
      anchorSessionId: "sess_wrong_kind",
      recoveryEvidence: true,
    })).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(readRequests().map((request) => request.method)).toEqual(["v4/commands/query", "session/list"]);
    expect(taskRow("sess_wrong_kind")).toBeUndefined();
  });

  it("协议层 RPC error 不再假定未执行：query unknown → BreedError(outcome-unknown)", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "error";
    await expect(breeder().createChild({ teamId: "sess_lead", workspacePath: root })).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(readRequests().map((request) => request.method)).toEqual(["v4/command", "v4/commands/query"]);
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

describe("AppServerSessionBreeder.createChild · 继承模型同步失败即抛（0.4.0）", () => {
  const PRIMARY = { providerId: "account:unavailable-plan", modelId: "GLM-5.3", reasoningLevel: "max" };

  function readRequests(): Array<{ method: string; params: Record<string, unknown> }> {
    return fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
  }

  it("模型应用成功 → appliedModel 记录；一次 setModel；日志 model-set", async () => {
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
    });
    expect(result.appliedModel).toEqual(PRIMARY);
    expect(readRequests().filter((r) => r.method === "session/setModel")).toHaveLength(1);
    expect(records.find((r) => r.event === "model-set")).toMatchObject({
      providerId: PRIMARY.providerId,
      modelId: PRIMARY.modelId,
      reasoningLevel: "max",
    });
    expect(records.some((r) => r.event === "model-set-failed")).toBe(false);
  });

  it("模型应用失败 → 抛 BreedError(model-rejected)；绝不静默返回成功（不谎报继承）", async () => {
    const records: Array<Record<string, unknown>> = [];
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: (record) => records.push(record),
      readyTimeoutMs: 8_000,
    });
    const err = await b
      .createChild({ teamId: "sess_lead", workspacePath: root, modelSelection: PRIMARY })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "BreedError", code: "model-rejected" });
    // 错误文本 = 继承语义可读原因（resume-provider 据此写 model-failed）
    expect(String((err as Error).message)).toContain("inherited model");
    // 失败留痕 = model-set-failed（单次尝试：setModel 一次，无兜底档；
    // 巨型消息快照不得整包落日志 → 只记目标三元组与错误文本）
    expect(readRequests().filter((r) => r.method === "session/setModel")).toHaveLength(1);
    const failure = records.find((r) => r.event === "model-set-failed")!;
    expect(failure).toMatchObject({ providerId: PRIMARY.providerId, modelId: PRIMARY.modelId, message: "fake setModel failure" });
    expect(failure).not.toHaveProperty("result");
    expect(records.some((r) => r.event === "model-set")).toBe(false);
  });

  it("模型失败路径 anchor 已 tombstone（隐藏不露出）", async () => {
    process.env.FAKE_APP_SERVER_FAIL = "setModel";
    const b = new AppServerSessionBreeder({
      zcode: { command: process.execPath, argvPrefix: [FAKE], source: "env" },
      tasksIndexPath,
      log: () => undefined,
      readyTimeoutMs: 8_000,
    });
    const pending = b.createChild({ teamId: "sess_lead", workspacePath: root, modelSelection: PRIMARY });
    await expect(pending).rejects.toThrow(/inherited model/);
    const row = taskRow("sess_fake_anchor");
    expect(row).toBeDefined();
    expect(row!.deleted).toBe(1); // 培育失败清理（disposeBredSessions 幂等补写）
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
