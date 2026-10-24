// team-ctl state：读盘重放 → Roster/Tasks/Mailbox 分区表格渲染（纯函数，可单测）。
// 表格对齐 = 固定列宽 pad；空态有占位文案；failure 终态醒目置顶。
import type { LoadedTeam } from "../coord/replay.js";
import type { Paint } from "./colors.js";

export interface StateRenderInput {
  teamId: string;
  loaded: LoadedTeam;
  json: boolean;
}

/** state 输出（字符串整体；--json 分支返回机器可读单 JSON）。 */
export function renderState(input: StateRenderInput, paint: Paint): string {
  const { teamId, loaded, json } = input;
  if (json) {
    return JSON.stringify(
      {
        teamId,
        seq: loaded.seq,
        fromCheckpoint: loaded.fromCheckpoint,
        checkpointIgnored: loaded.checkpointIgnored,
        corrupt: loaded.corrupt,
        writers: loaded.writers,
        replayMs: loaded.replayMs,
        failure: loaded.state.failure,
        view: loaded.view,
        mailbox: {
          messages: loaded.state.messages,
          delivered: loaded.state.delivered,
        },
      },
      null,
      2,
    );
  }
  const lines: string[] = [];
  const mode = loaded.fromCheckpoint ? "checkpoint+tail" : "full-replay";
  lines.push(
    `${paint.bold(`Agent Team ${teamId}`)}  seq ${loaded.seq}  ${paint.dim(`${mode} · ${loaded.replayMs}ms · writers ${loaded.writers.length}`)}`,
  );
  if (loaded.corrupt !== undefined) {
    lines.push(paint.red(`⚠ 日志损坏 fail-closed（行 ${loaded.corrupt.line}）：${loaded.corrupt.reason}`));
  }
  if (loaded.state.failure !== undefined) {
    lines.push(paint.red(`⚠ FAILURE（终态，后续合法事件不再改变视图）：${loaded.state.failure}`));
  }

  // ---- Roster
  const members = loaded.view.members;
  lines.push("");
  lines.push(paint.bold(`Roster (${members.length})`));
  if (members.length === 0) {
    lines.push(paint.dim("  （空）"));
  } else {
    lines.push(`  ${pad("NAME", 16)}${pad("ROLE", 10)}PHASE`);
    for (const m of members) {
      const row = `  ${pad(m.name, 16)}${pad(m.role, 10)}${m.phase}`;
      lines.push(m.error !== undefined ? paint.red(`${row}  ⚠ ${m.error}`) : row);
    }
  }

  // ---- Tasks
  const tasks = loaded.view.tasks;
  lines.push("");
  lines.push(paint.bold(`Tasks (${tasks.length})`));
  if (tasks.length === 0) {
    lines.push(paint.dim("  （暂无任务）"));
  } else {
    lines.push(`  ${pad("ID", 10)}${pad("STATUS", 12)}${pad("OWNER", 12)}${pad("REV", 5)}${pad("READY", 7)}SUBJECT`);
    for (const t of tasks) {
      const owner = t.ownerName ?? "—";
      const statusCell = pad(t.status, 12); // 先按纯文本占位再着色，列宽不被 ANSI 码破坏
      const status =
        t.status === "completed" ? paint.green(statusCell) : t.status === "in_progress" ? paint.yellow(statusCell) : statusCell;
      lines.push(`  ${pad(t.id, 10)}${status}${pad(owner, 12)}${pad(String(t.revision), 5)}${pad(String(t.ready), 7)}${t.subject}`);
      if (t.blockedBy.length > 0) lines.push(paint.dim(`    ${" ".repeat(34)}blockedBy: ${t.blockedBy.join(", ")}`));
    }
  }

  // ---- Mailbox
  const deliveredIds = new Set(loaded.state.delivered);
  const pending = loaded.state.messages.filter((m) => !deliveredIds.has(m.id));
  lines.push("");
  lines.push(paint.bold(`Mailbox（pending ${pending.length} / delivered ${loaded.state.delivered.length}）`));
  if (loaded.state.messages.length === 0) {
    lines.push(paint.dim("  （邮箱空闲）"));
  } else {
    for (const m of loaded.state.messages) {
      const state = deliveredIds.has(m.id) ? paint.green("delivered") : paint.yellow("queued");
      lines.push(`  ${m.id}  ${m.senderName} → ${targetLabel(loaded, m.targetId)}  [${state}]`);
    }
  }
  return lines.join("\n");
}

function targetLabel(loaded: LoadedTeam, targetId: string): string {
  if (targetId === loaded.state.id) return "lead";
  return loaded.view.members.find((m) => m.id === targetId)?.name ?? targetId;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text + " " : text + " ".repeat(width - text.length);
}
