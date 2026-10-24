// team-ctl inject-event：直写原始行到 events.jsonl —— **test-only**（绕过 journal：
// 无追加前不变量、无锁、无 fsync）。演练用途：注入非法事件 → 重放进入 failure 终态。
import fs from "node:fs";
import path from "node:path";

export interface InjectResult {
  seq: number;
  line: string;
  file: string;
}

/** 注入原始行（自动补行尾换行与 seq/writer 缺省；显式给定字段优先）。 */
export function injectEvent(
  teamDir: string,
  rawLine: string,
  opts: { writer?: string } = {},
): InjectResult {
  const eventsFile = path.join(teamDir, "events.jsonl");
  fs.mkdirSync(teamDir, { recursive: true });
  const existing = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "";
  const lineCount = existing.length === 0 ? 0 : existing.split("\n").filter((l) => l.length > 0).length;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    throw new Error(`inject-event: 参数必须是合法 JSON 行，收到：${rawLine.slice(0, 120)}`);
  }
  const line = JSON.stringify({
    seq: lineCount + 1,
    ts: new Date().toISOString(),
    writer: opts.writer ?? "team-ctl:inject",
    ...parsed,
  });
  fs.appendFileSync(eventsFile, line + "\n", { mode: 0o600 });
  return { seq: lineCount + 1, line, file: eventsFile };
}

/** 非法 member 事件样例：新成员直接 active（违反「必须从 provisioning 开始」→ 重放 failure 终态）。 */
export function invalidMemberSample(teamId: string): string {
  return JSON.stringify({
    event: {
      type: "team/member",
      version: 2,
      teamId,
      member: { id: "sess-injected-ghost", name: "ghost", description: "injected", provider: "spawn", context: "fresh", phase: "active" },
    },
  });
}
