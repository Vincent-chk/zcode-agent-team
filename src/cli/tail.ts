// team-ctl tail：跟随 events.jsonl → 四类事件着色区分、failure 醒目、本地时区时间戳。
// 非法行（JSON 解析失败）红显原文；poll 跟随（exFAT 无可靠 inotify，轮询 250ms 稳妥）。
import fs from "node:fs";
import path from "node:path";
import type { Paint } from "./colors.js";

export interface TailLine {
  seq: number;
  ts: string;
  writer: string;
  event: {
    type: string;
    member?: { id: string; name: string; phase: string };
    task?: { id: string; subject?: string; status?: string; revision?: number };
    message?: { id: string; senderName: string; targetId: string };
    messageId?: string;
    targetId?: string;
    [key: string]: unknown;
  };
}

export type TailInput = { kind: "line"; line: TailLine } | { kind: "invalid"; raw: string };

/** 单行格式化（纯函数）：`HH:MM:SS.mmm  seq  TYPE  摘要  (writer)`，本地时区。 */
export function formatTailLine(input: TailInput, paint: Paint): string {
  if (input.kind === "invalid") {
    return paint.red(`!! 无法解析的行：${input.raw.slice(0, 160)}`);
  }
  const { line } = input;
  const time = localTime(line.ts);
  const summary = summarize(line);
  const type = line.event.type;
  const coloredType =
    type === "team/member"
      ? paint.cyan(type)
      : type === "team/task"
        ? paint.yellow(type)
        : type === "team/message/queued" || type === "team/message"
          ? paint.magenta(type)
          : type === "team/message/delivered"
            ? paint.green(type)
            : paint.dim(type);
  return `${paint.dim(time)}  ${paint.bold(String(line.seq).padStart(4))}  ${coloredType}  ${summary}  ${paint.dim(line.writer)}`;
}

function summarize(line: TailLine): string {
  const e = line.event;
  if (e.type === "team/member" && e.member !== undefined) {
    return `${e.member.name} (${e.member.id}) → ${e.member.phase}`;
  }
  if (e.type === "team/task" && e.task !== undefined) {
    return `${e.task.id} ${e.task.subject ?? ""} [${e.task.status ?? "?"} r${e.task.revision ?? "?"}]`;
  }
  if ((e.type === "team/message/queued" || e.type === "team/message") && e.message !== undefined) {
    return `${e.message.id} ${e.message.senderName} → ${e.message.targetId}`;
  }
  if (e.type === "team/message/delivered") {
    return `${e.messageId} → ${e.targetId}`;
  }
  return JSON.stringify(e);
}

/** ISO 时间 → 本地时区 HH:MM:SS.mmm（无时区后缀按 UTC 解析后本地呈现）。 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid-ts";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export interface FollowOptions {
  /** 起始显示的历史行数（默认 0 = 从末尾开始跟随）。 */
  fromLines?: number;
  pollMs?: number;
  signal?: AbortSignal;
  paint: Paint;
  onLine: (formatted: string, raw: TailInput) => void;
}

/** 跟随 events.jsonl：先回放 fromLines 历史，再轮询增量；文件缺失 → 可读错误。 */
export async function followEvents(eventsFile: string, opts: FollowOptions): Promise<void> {
  const paint = opts.paint;
  const pollMs = opts.pollMs ?? 250;
  let offset = 0;
  let buffer = "";
  if (!fs.existsSync(eventsFile)) {
    throw new Error(`events file not found: ${eventsFile}`);
  }
  const history = fs.readFileSync(eventsFile, "utf8");
  const lines = history.split("\n").filter((l) => l.length > 0);
  const start = opts.fromLines !== undefined ? Math.max(0, lines.length - opts.fromLines) : lines.length;
  const emit = (raw: string): void => {
    try {
      const parsed = JSON.parse(raw) as TailLine;
      opts.onLine(formatTailLine({ kind: "line", line: parsed }, paint), { kind: "line", line: parsed });
    } catch {
      opts.onLine(formatTailLine({ kind: "invalid", raw }, paint), { kind: "invalid", raw });
    }
  };
  for (const raw of lines.slice(start)) {
    emit(raw);
  }
  offset = Buffer.byteLength(history, "utf8"); // 字节长度（UTF-8 多字节 ≠ 字符串长度）

  for (;;) {
    if (opts.signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const stat = fs.statSync(eventsFile);
    if (stat.size < offset) {
      // 截断/轮转（inject 重写等）→ 重置到头部重读
      offset = 0;
      buffer = "";
    }
    if (stat.size > offset) {
      // 按 bytesRead 前进（短读/写者并发追加时 stat 尺寸只是提示）；半行残段留缓冲等换行
      const slack = 1 << 16;
      const chunk = Buffer.alloc(slack);
      const fd = fs.openSync(eventsFile, "r");
      try {
        const bytesRead = fs.readSync(fd, chunk, 0, slack, offset);
        if (bytesRead > 0) {
          buffer += chunk.toString("utf8", 0, bytesRead);
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (raw.length > 0) emit(raw);
          }
          offset += bytesRead;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}

export function eventsFileOf(teamDir: string): string {
  return path.join(teamDir, "events.jsonl");
}
