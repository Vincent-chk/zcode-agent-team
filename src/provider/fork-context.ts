// D3 fork 上下文兜底（T4.2；ADR-4 定版：转录注入为主）。fresh 之外，context:"fork" 的 teammate
// 首轮 = Lead 已完成回合转录（截断预算内保留首回合 + 最近回合）+ 任务块。
// 位置口径（对齐轮）：转录在首轮任务文本内、位于任务块**之前**；身份由 hook 通道另行注入
// （0.2.1 无身份前缀块，D2）；不重复注入 Lead 身份消息（规格 §9.3 注——转录只含 user/assistant
// 文本，团队注入（hook_context）本就不落 transcript，天然不重复）。

import type { TranscriptReader, TurnExport } from "./transcript.js";

export const FORK_HEADER = "[Agent Teams fork context] Your Team Lead's session transcript so far (for context inheritance):";
export const FORK_FOOTER = "[End of fork context]";

export interface ForkBuildOptions {
  /** 截断预算（字符；缺省 24000 ≈ 6K token）。 */
  maxChars?: number;
}

export interface ForkBuildResult {
  prompt: string;
  includedTurns: number;
  truncated: boolean;
}

/** 由 Lead 会话 id 构造 fork 首轮 prompt（转录 + 任务块）。 */
export function buildForkFirstPrompt(
  reader: TranscriptReader,
  leadSessionId: string,
  task: string,
  opts: ForkBuildOptions = {},
): ForkBuildResult {
  const maxChars = opts.maxChars ?? Number(process.env.TEAM_FORK_MAX_CHARS ?? 24_000);
  const turns = reader.exportTurns(leadSessionId);
  const kept = truncateTurns(turns, maxChars);
  const lines: string[] = [FORK_HEADER];
  kept.turns.forEach((turn, i) => {
    lines.push(`--- ${turn.role} #${i + 1} ---`);
    if (turn.text.length > 0) lines.push(turn.text);
    if (turn.toolNames.length > 0) lines.push(`[tools used: ${turn.toolNames.join(", ")}]`);
  });
  lines.push(FORK_FOOTER);
  lines.push("");
  lines.push(task);
  return {
    prompt: lines.join("\n"),
    includedTurns: kept.turns.length,
    truncated: kept.truncated,
  };
}

/** 截断策略：预算内保留「首个回合 + 最近 N 回合」（首回合锚定任务源起，最近回合贴近现场）。 */
export function truncateTurns(turns: readonly TurnExport[], maxChars: number): { turns: TurnExport[]; truncated: boolean } {
  if (turns.length === 0) return { turns: [], truncated: false };
  const rendered = (t: TurnExport) => (t.text.length > 0 ? t.text : `[tools used: ${t.toolNames.join(", ")}]`);
  const totalChars = turns.reduce((sum, t) => sum + rendered(t).length, 0);
  if (totalChars <= maxChars) return { turns: [...turns], truncated: false };
  const first = turns[0];
  const budget = maxChars - rendered(first).length;
  const tail: TurnExport[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 1; i--) {
    const cost = rendered(turns[i]).length;
    if (used + cost > budget && tail.length > 0) break;
    tail.unshift(turns[i]);
    used += cost;
  }
  return { turns: [first, ...tail], truncated: true };
}
