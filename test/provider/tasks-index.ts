import { DatabaseSync } from "node:sqlite";

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

export function createTasksIndexFixture(file: string): void {
  const db = new DatabaseSync(file);
  db.prepare(DDL).run();
  db.close();
}
