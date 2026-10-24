// sidebar-audit 单元层（直接 import src）：dry-run/apply/mismatch/absent 分支 + 渲染文案。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditSidebar, renderSidebarAudit } from "../../src/cli/sidebar-audit.js";
import { archiveTask, readTask, tombstoneAnchor } from "../../src/sidebar/tasks-index.js";

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
let db: string;
let teamDir: string;

function insertTask(taskId: string, title: string, workspace: string): void {
  const conn = new DatabaseSync(db);
  conn
    .prepare(
      "insert into tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at) values (?,?,?,?,?,?)",
    )
    .run(workspace, workspace, taskId, title, Date.now(), Date.now());
  conn.close();
}

function writeMember(id: string, name: string, sessionId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(teamDir, "members", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "origin.json"),
    JSON.stringify({
      teamId: "t",
      memberId: id,
      name,
      provider: "spawn",
      mode: "continuable",
      context: "fresh",
      createdAt: new Date().toISOString(),
      cwd: root,
      firstPromptText: "p",
      firstPromptSha256: "x",
      sessionId,
      initialUserMessageAccepted: true,
      ...extra,
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-audit-unit-"));
  db = path.join(root, "tasks-index.sqlite");
  teamDir = path.join(root, "teams", "t");
  fs.mkdirSync(teamDir, { recursive: true });
  const conn = new DatabaseSync(db);
  conn.prepare(DDL).run();
  conn.close();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("auditSidebar", () => {
  it("dry-run 列出计划；apply 后置 archived + 写台账 + 幂等", () => {
    writeMember("m1", "alpha", "sess_a", { sessionIsolation: "legacy" });
    writeMember("m2", "beta", "sess_b", { sessionIsolation: "child" });
    insertTask("sess_a", "你是 alpha", root);
    insertTask("sess_b", "Selection side chat", root);

    const dry = auditSidebar({ teamDir, tasksIndexPath: db });
    expect(dry.dryRun).toBe(true);
    expect(dry.entries.map((e) => e.action)).toEqual(["would-archive", "would-archive"]);
    expect(readTask(db, "sess_a")?.archived).toBe(0);

    const applied = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(applied.applied).toBe(2);
    expect(readTask(db, "sess_a")?.archived).toBe(1);
    expect(fs.existsSync(path.join(teamDir, "sidebar-migration.json"))).toBe(true);

    const again = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(again.applied).toBe(0);
    expect(again.entries.every((e) => e.action === "already-archived")).toBe(true);
  });

  it("anchor 行：dry-run would-tombstone；apply 置 deleted=1；幂等 already-tombstoned", () => {
    writeMember("m1", "alpha", "sess_child", {
      sessionIsolation: "child",
      anchorSessionId: "sess_anchor",
      sessionKind: "selection_side_chat",
    });
    insertTask("sess_child", "Selection side chat", root);
    insertTask("sess_anchor", "Untitled session", root);

    const dry = auditSidebar({ teamDir, tasksIndexPath: db });
    const anchorEntry = dry.entries.find((e) => e.kind === "anchor");
    expect(anchorEntry).toMatchObject({ sessionId: "sess_anchor", action: "would-tombstone" });
    expect(readTask(db, "sess_anchor")?.deleted).toBe(0);

    const applied = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(applied.tombstoned).toBe(1);
    expect(readTask(db, "sess_anchor")).toMatchObject({ deleted: 1, archived: 0 }); // anchor 走 tombstone，不 archive

    const again = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(again.tombstoned).toBe(0);
    expect(again.entries.find((e) => e.kind === "anchor")?.action).toBe("already-tombstoned");
  });

  it("anchor 跨 workspace → mismatch，不写库", () => {
    writeMember("m1", "alpha", "sess_child2", { sessionIsolation: "child", anchorSessionId: "sess_anchor2" });
    insertTask("sess_child2", "Selection side chat", root);
    insertTask("sess_anchor2", "Untitled session", "/another/workspace");
    const applied = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(applied.entries.find((e) => e.kind === "anchor")?.action).toBe("mismatch");
    expect(readTask(db, "sess_anchor2")?.deleted).toBe(0);
  });

  it("缺失行 → absent；空团队成员 → 提示文案", () => {
    writeMember("m1", "alpha", "sess_missing");
    const result = auditSidebar({ teamDir, tasksIndexPath: db });
    expect(result.entries[0]!.action).toBe("absent");
    const empty = auditSidebar({ teamDir: path.join(root, "nope"), tasksIndexPath: db });
    expect(renderSidebarAudit(empty)).toContain("没有已落定的成员会话");
  });

  it("跨 workspace 的行 → mismatch（不误归档）", () => {
    writeMember("m1", "alpha", "sess_other");
    insertTask("sess_other", "别的工作区的任务", "/another/workspace");
    const result = auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false });
    expect(result.entries[0]!.action).toBe("mismatch");
    expect(readTask(db, "sess_other")?.archived).toBe(0);
  });

  it("renderSidebarAudit：dry-run 与 apply 两种收尾文案", () => {
    writeMember("m1", "alpha", "sess_a");
    insertTask("sess_a", "你是 alpha", root);
    expect(renderSidebarAudit(auditSidebar({ teamDir, tasksIndexPath: db }))).toContain("未写库");
    expect(renderSidebarAudit(auditSidebar({ teamDir, tasksIndexPath: db, dryRun: false }))).toContain("已归档 1 条");
  });
});

describe("tasks-index 写操作边界", () => {
  it("tombstoneAnchor：不存在库 → 跳过；用户标题 → 拒绝；空标题 → 允许", () => {
    expect(tombstoneAnchor({ taskId: "sess_x", workspacePath: root, dbPath: path.join(root, "none.sqlite") })).toEqual({
      applied: false,
      reason: "tasks-index-missing",
    });
    insertTask("sess_user", "用户任务", root);
    expect(tombstoneAnchor({ taskId: "sess_user", workspacePath: root, dbPath: db })).toEqual({
      applied: false,
      reason: "row-not-owned",
    });
    const conn = new DatabaseSync(db);
    conn.prepare(
      "insert into tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at) values (?,?,?,?,?,?)",
    ).run(root, root, "sess_empty", "", Date.now(), Date.now());
    conn.close();
    expect(tombstoneAnchor({ taskId: "sess_empty", workspacePath: root, dbPath: db }).applied).toBe(true);
    expect(readTask(db, "sess_empty")).toMatchObject({ deleted: 1 });
  });

  it("archiveTask：行不存在 → 不插入；跨 workspace → 拒绝", () => {
    expect(archiveTask({ taskId: "sess_none", workspacePath: root, dbPath: db })).toEqual({
      applied: false,
      reason: "row-not-owned",
    });
    expect(readTask(db, "sess_none")).toBeUndefined();
  });
});
