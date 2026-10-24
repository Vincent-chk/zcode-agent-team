// 任务索引（桌面左侧任务栏）最小写操作：仅用于「系统 anchor 隐藏」与「存量泄漏迁移」。
// 纪律：
//  - 只按精确 task_id + workspace_path 匹配，绝不批量/模糊改动；
//  - tombstone = deleted=1（系统 anchor，不进任何列表）；archive = archived=1（存量成员会话，可回滚）；
//  - 不触摸 title/meta/其他列（除 updated_at），不删除行，不改 schema；
//  - busy_timeout + BEGIN IMMEDIATE + SQLITE_BUSY 重试；库不存在（纯 CLI 环境）直接跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ANCHOR_TITLE = "Agent Team anchor";

export function defaultTasksIndexPath(): string {
  return process.env.TEAM_TASKS_INDEX ?? path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

export interface TaskRow {
  task_id: string;
  title: string;
  archived: number;
  deleted: number;
  workspace_path: string;
}

export interface TombstoneResult {
  applied: boolean;
  reason?: "tasks-index-missing" | "row-not-owned";
}

function withRetry<T>(fn: () => T, attempts = 3): T {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!/SQLITE_BUSY|database is locked/i.test(message)) throw err;
      // 同步睡眠（写窗口极短；避免引入 async 传染）
      const until = Date.now() + 100 * (i + 1);
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  throw last;
}

/** 读取单行（只读）。 */
export function readTask(dbPath: string, taskId: string): TaskRow | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("select task_id, title, archived, deleted, workspace_path from tasks where task_id = ?")
      .get(taskId) as TaskRow | undefined;
  } finally {
    db.close();
  }
}

/**
 * 给系统 anchor 写 tombstone：deleted=1。
 * 行不存在则插入（先于桌面基线补登，避免 seedTaskMetaIfMissing 再造一行）；
 * 行已存在但标题不是「空/Untitled session/Agent Team anchor」→ 拒绝（保护用户任务）。
 */
export function tombstoneAnchor(input: {
  taskId: string;
  workspacePath: string;
  dbPath?: string;
  now?: number;
}): TombstoneResult {
  const dbPath = input.dbPath ?? defaultTasksIndexPath();
  if (!fs.existsSync(dbPath)) return { applied: false, reason: "tasks-index-missing" };
  const now = input.now ?? Date.now();
  return withRetry(() => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      const existing = db
        .prepare("select task_id, title, workspace_path from tasks where task_id = ?")
        .get(input.taskId) as { title: string; workspace_path: string } | undefined;
      if (
        existing !== undefined &&
        existing.workspace_path === input.workspacePath &&
        existing.title !== "" &&
        existing.title !== "Untitled session" &&
        existing.title !== ANCHOR_TITLE
      ) {
        db.exec("ROLLBACK");
        return { applied: false, reason: "row-not-owned" as const };
      }
      if (existing !== undefined && existing.workspace_path !== input.workspacePath) {
        db.exec("ROLLBACK");
        return { applied: false, reason: "row-not-owned" as const };
      }
      const meta = JSON.stringify({
        taskId: input.taskId,
        title: ANCHOR_TITLE,
        workspacePath: input.workspacePath,
        createdAt: now,
        updatedAt: now,
        mode: "default",
        provider: "glm",
        status: "completed",
        titleOverridden: false,
      });
      db.prepare(
        `INSERT INTO tasks (
           workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
           provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
           off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned,
           archived, deleted, title_overridden, searchable_text, meta_json
         ) VALUES (
           @workspace_key, @workspace_path, NULL, @task_id, @title, 'completed',
           'glm', 'default', NULL, NULL, NULL, NULL,
           NULL, @now, @now, NULL, 0, 0,
           0, 1, 0, @searchable, @meta
         )
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           deleted = 1,
           updated_at = excluded.updated_at
         WHERE tasks.task_id = excluded.task_id
           AND (tasks.title = '' OR tasks.title = 'Untitled session' OR tasks.title = @title)`,
      ).run({
        workspace_key: input.workspacePath,
        workspace_path: input.workspacePath,
        task_id: input.taskId,
        title: ANCHOR_TITLE,
        now,
        searchable: ANCHOR_TITLE,
        meta,
      });
      db.exec("COMMIT");
      return { applied: true };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      db.close();
    }
  });
}

/** 存量成员会话归档：archived=1（可回滚；只对已存在的行生效，不插入）。 */
export function archiveTask(input: {
  taskId: string;
  workspacePath: string;
  dbPath?: string;
  now?: number;
}): TombstoneResult {
  const dbPath = input.dbPath ?? defaultTasksIndexPath();
  if (!fs.existsSync(dbPath)) return { applied: false, reason: "tasks-index-missing" };
  const now = input.now ?? Date.now();
  return withRetry(() => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      const existing = db
        .prepare("select task_id, workspace_path, archived from tasks where task_id = ?")
        .get(input.taskId) as { workspace_path: string; archived: number } | undefined;
      if (existing === undefined || existing.workspace_path !== input.workspacePath) {
        db.exec("ROLLBACK");
        return { applied: false, reason: "row-not-owned" as const };
      }
      if (existing.archived === 1) {
        db.exec("COMMIT");
        return { applied: false };
      }
      db.prepare("update tasks set archived = 1, updated_at = ? where task_id = ?").run(now, input.taskId);
      db.exec("COMMIT");
      return { applied: true };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      db.close();
    }
  });
}
