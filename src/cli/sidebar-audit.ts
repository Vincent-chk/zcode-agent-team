// team-ctl sidebar-audit：把「已泄漏到左侧任务栏」的 teammate 会话归档（stage-6 迁移命令）。
// 只认 members/<id>/origin.json 记录的 sessionId；只对 tasks-index 中同 workspace 的精确行
// 置 archived=1（不删行、不改其他列、不插入新行）；默认 dry-run，--apply 才写；写台账可复核。
import fs from "node:fs";
import path from "node:path";
import { archiveTask, readTask, tombstoneAnchor, defaultTasksIndexPath } from "../sidebar/tasks-index.js";
import { readOrigin, memberPaths } from "../provider/member-files.js";

export interface SidebarAuditInput {
  teamDir: string;
  /** 任务索引路径（缺省 ~/.zcode/v2/tasks-index.sqlite）。 */
  tasksIndexPath?: string;
  /** 仅报告，不写库（缺省 true）。 */
  dryRun?: boolean;
  /** 迁移源码出处（写台账）。 */
  now?: () => number;
}

export type SidebarAuditAction =
  | "would-archive"
  | "archived"
  | "already-archived"
  | "would-tombstone"
  | "tombstoned"
  | "already-tombstoned"
  | "absent"
  | "mismatch";

export interface SidebarAuditEntry {
  memberId: string;
  name: string | null;
  sessionId: string;
  sessionIsolation: "child" | "legacy" | "unknown";
  action: SidebarAuditAction;
  title?: string;
  /** member = 成员会话行（archive）；anchor = 隐藏子会话的物理父（tombstone）。 */
  kind?: "member" | "anchor";
}

export interface SidebarAuditResult {
  teamDir: string;
  tasksIndexPath: string;
  dryRun: boolean;
  entries: SidebarAuditEntry[];
  applied: number;
  /** 其中 anchor tombstone 数（applied 的子集）。 */
  tombstoned: number;
  ledgerPath: string | null;
}

function listMemberIds(teamDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(teamDir, "members"))
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

export function auditSidebar(input: SidebarAuditInput): SidebarAuditResult {
  const teamDir = path.resolve(input.teamDir);
  const tasksIndexPath = input.tasksIndexPath ?? defaultTasksIndexPath();
  const dryRun = input.dryRun ?? true;
  const entries: SidebarAuditEntry[] = [];
  const seenAnchors = new Set<string>();

  for (const memberId of listMemberIds(teamDir)) {
    const origin = readOrigin(memberPaths(teamDir, memberId));
    if (origin === undefined || origin.sessionId === null) continue;
    const sessionId = origin.sessionId;
    const isolation = origin.sessionIsolation ?? "unknown";
    const row = readTask(tasksIndexPath, sessionId);
    // 归属校验：只认「团队 cwd」下的行（origin.cwd 是成员会话创建时的项目目录）。
    const expectedWorkspace = path.resolve(origin.cwd);
    const owned = row !== undefined && path.resolve(row.workspace_path) === expectedWorkspace;
    const needsArchive = owned && row!.archived !== 1;
    let action: SidebarAuditAction;
    if (row === undefined) {
      action = "absent";
    } else if (!owned) {
      action = "mismatch";
    } else if (!needsArchive) {
      action = "already-archived";
    } else {
      action = dryRun ? "would-archive" : "archived";
    }
    entries.push({
      memberId,
      name: origin.name ?? null,
      sessionId,
      sessionIsolation: isolation,
      action,
      kind: "member",
      ...(row !== undefined ? { title: row.title } : {}),
    });
    if (!dryRun && needsArchive) {
      const result = archiveTask({ taskId: sessionId, workspacePath: row!.workspace_path, dbPath: tasksIndexPath });
      entries[entries.length - 1]!.action = result.applied
        ? "archived"
        : result.reason === "row-not-owned"
          ? "mismatch"
          : "absent";
    }

    // anchor（child 的物理父）：存量库可能仍有 deleted=0 的行 → 补 tombstone。
    const anchorId = origin.anchorSessionId;
    if (typeof anchorId === "string" && anchorId.length > 0 && !seenAnchors.has(anchorId)) {
      seenAnchors.add(anchorId);
      const anchorRow = readTask(tasksIndexPath, anchorId);
      const anchorOwned = anchorRow !== undefined && path.resolve(anchorRow.workspace_path) === expectedWorkspace;
      let anchorAction: SidebarAuditAction;
      if (anchorRow === undefined) {
        anchorAction = "absent";
      } else if (!anchorOwned) {
        anchorAction = "mismatch";
      } else if (anchorRow.deleted === 1) {
        anchorAction = "already-tombstoned";
      } else {
        anchorAction = dryRun ? "would-tombstone" : "tombstoned";
      }
      entries.push({
        memberId,
        name: origin.name ?? null,
        sessionId: anchorId,
        sessionIsolation: isolation,
        action: anchorAction,
        kind: "anchor",
        ...(anchorRow !== undefined ? { title: anchorRow.title } : {}),
      });
      if (!dryRun && anchorOwned && anchorRow.deleted !== 1) {
        const result = tombstoneAnchor({
          taskId: anchorId,
          workspacePath: anchorRow.workspace_path,
          dbPath: tasksIndexPath,
        });
        entries[entries.length - 1]!.action = result.applied
          ? "tombstoned"
          : result.reason === "row-not-owned"
            ? "mismatch"
            : "absent";
      }
    }
  }

  const applied = entries.filter((e) => e.action === "archived" || e.action === "tombstoned").length;
  const tombstoned = entries.filter((e) => e.action === "tombstoned").length;
  let ledgerPath: string | null = null;
  if (!dryRun) {
    ledgerPath = path.join(teamDir, "sidebar-migration.json");
    const now = input.now ?? Date.now;
    const ledger = {
      kind: "sidebar-audit",
      version: 1,
      at: new Date(now()).toISOString(),
      tasksIndexPath,
      entries,
    };
    writeAtomic(ledgerPath, ledger);
  }
  return { teamDir, tasksIndexPath, dryRun, entries, applied, tombstoned, ledgerPath };
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function renderSidebarAudit(result: SidebarAuditResult): string {
  const lines: string[] = [];
  lines.push(`sidebar-audit ${result.teamDir}`);
  lines.push(`tasks-index: ${result.tasksIndexPath}`);
  lines.push(`mode: ${result.dryRun ? "dry-run（加 --apply 才写库）" : "apply"}`);
  if (result.entries.length === 0) {
    lines.push("（没有已落定的成员会话）");
    return lines.join("\n");
  }
  for (const e of result.entries) {
    const label = e.name !== null ? `${e.name} (${e.memberId})` : e.memberId;
    const kind = e.kind === "anchor" ? "anchor" : "member";
    const title = e.title !== undefined ? ` · ${e.title}` : "";
    lines.push(`- ${label} [${kind}/${e.sessionIsolation}] ${e.sessionId} → ${e.action}${title}`);
  }
  lines.push(
    result.dryRun
      ? `计划归档 ${result.entries.filter((e) => e.action === "would-archive").length} 条、tombstone ${result.entries.filter((e) => e.action === "would-tombstone").length} 个 anchor；未写库。`
      : `已归档 ${result.applied - result.tombstoned} 条、tombstone ${result.tombstoned} 个 anchor；台账 ${result.ledgerPath}`,
  );
  return lines.join("\n");
}
