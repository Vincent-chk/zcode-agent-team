// sidebar-audit（stage-6 存量迁移）：默认 dry-run；--apply 只把成员会话行置 archived=1；
// 幂等；台账落盘；不存在的行/非本 workspace 行不动。
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROJ = path.resolve(import.meta.dirname, "../..");
const CTL = path.join(PROJ, "scripts", "team-ctl.mjs");
const TEAM = "sess_audit_lead";

let root: string;
let tasksIndex: string;
let teamDir: string;

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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CTL, ...args],
      { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TEAM_TASKS_INDEX: tasksIndex, NO_COLOR: "" } },
      (err, stdout, stderr) => {
        resolve({ code: child.exitCode ?? (err ? 1 : 0), stdout, stderr });
      },
    );
  });
}

function insertTask(taskId: string, title: string, workspace: string, archived = 0): void {
  const db = new DatabaseSync(tasksIndex);
  db.prepare(
    "insert into tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, archived) values (?,?,?,?,?,?,?)",
  ).run(workspace, workspace, taskId, title, Date.now(), Date.now(), archived);
  db.close();
}

function taskRow(taskId: string): { archived: number; title: string } | undefined {
  const db = new DatabaseSync(tasksIndex, { readOnly: true });
  try {
    return db.prepare("select archived, title from tasks where task_id = ?").get(taskId) as
      | { archived: number; title: string }
      | undefined;
  } finally {
    db.close();
  }
}

function writeMember(id: string, name: string, sessionId: string, isolation?: "child" | "legacy"): void {
  const dir = path.join(teamDir, "members", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "origin.json"),
    JSON.stringify({
      teamId: TEAM,
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
      ...(isolation !== undefined ? { sessionIsolation: isolation } : {}),
    }),
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [path.join(PROJ, "scripts", "build.mjs")], { maxBuffer: 32 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-sidebar-audit-"));
  tasksIndex = path.join(root, "tasks-index.sqlite");
  teamDir = path.join(root, "teams", TEAM);
  fs.mkdirSync(teamDir, { recursive: true });
  const db = new DatabaseSync(tasksIndex);
  db.prepare(DDL).run();
  db.close();
});

afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("team-ctl sidebar-audit", () => {
  it("默认 dry-run：报告 would-archive 但不写库", async () => {
    writeMember("m1", "alpha", "sess_leak_1", "legacy");
    insertTask("sess_leak_1", "你是 alpha…", root);
    const r = await run(["sidebar-audit", teamDir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).toContain("would-archive");
    expect(taskRow("sess_leak_1")?.archived).toBe(0);
    expect(fs.existsSync(path.join(teamDir, "sidebar-migration.json"))).toBe(false);
  });

  it("--apply：只把成员会话行置 archived=1，并写台账", async () => {
    writeMember("m1", "alpha", "sess_leak_1");
    writeMember("m2", "beta", "sess_leak_2");
    insertTask("sess_leak_1", "你是 alpha…", root);
    insertTask("sess_leak_2", "你是 beta…", root);
    insertTask("sess_user_task", "用户自己的任务", root);

    const r = await run(["sidebar-audit", teamDir, "--apply"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已归档 2 条");
    expect(taskRow("sess_leak_1")?.archived).toBe(1);
    expect(taskRow("sess_leak_2")?.archived).toBe(1);
    // 用户任务不受影响
    expect(taskRow("sess_user_task")?.archived).toBe(0);

    const ledger = JSON.parse(fs.readFileSync(path.join(teamDir, "sidebar-migration.json"), "utf8")) as {
      kind: string;
      entries: Array<{ sessionId: string; action: string }>;
    };
    expect(ledger.kind).toBe("sidebar-audit");
    expect(ledger.entries.map((e) => e.sessionId).sort()).toEqual(["sess_leak_1", "sess_leak_2"]);
    expect(ledger.entries.every((e) => e.action === "archived")).toBe(true);
  });

  it("幂等：重复 --apply 不重复计数", async () => {
    writeMember("m1", "alpha", "sess_leak_1");
    insertTask("sess_leak_1", "你是 alpha…", root);
    await run(["sidebar-audit", teamDir, "--apply"]);
    const again = await run(["sidebar-audit", teamDir, "--apply"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("已归档 0 条");
    expect(again.stdout).toContain("already-archived");
  });

  it("缺失行 / 未落定成员：absent & 跳过（不插入新行）", async () => {
    writeMember("m1", "alpha", "sess_absent");
    await run(["sidebar-audit", teamDir, "--apply"]);
    expect(taskRow("sess_absent")).toBeUndefined();
    // 没有 sessionId 的成员不参与
    writeMember("m2", "beta", null as unknown as string);
    const r = await run(["sidebar-audit", teamDir, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { entries: Array<{ memberId: string }> };
    expect(parsed.entries.map((e) => e.memberId)).toEqual(["m1"]);
  });

  it("--json 输出机器可读结构", async () => {
    writeMember("m1", "alpha", "sess_leak_1", "child");
    insertTask("sess_leak_1", "Selection side chat", root);
    const r = await run(["sidebar-audit", teamDir, "--json"]);
    const parsed = JSON.parse(r.stdout) as {
      dryRun: boolean;
      entries: Array<{ sessionIsolation: string; action: string }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.entries[0]).toMatchObject({ sessionIsolation: "child", action: "would-archive" });
  });

  it("缺少 teamDir → usage 错误（退出码 2）", async () => {
    const r = await run(["sidebar-audit"]);
    expect(r.code).toBe(2);
  });
});
