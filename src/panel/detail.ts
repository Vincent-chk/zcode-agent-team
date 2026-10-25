// T5.7 成员会话查看视图 · detail 合成器（契约 = stage-1《接口草案》§5 冻结草案）。
// 请求：{action:"detail", target:<memberId>, cursor?, limit?=100}
// 响应：{sessionId, memberId, page:{items:[{seq, ts, role, kind, text?, tool?,
//        tools?, count?, framed?}], nextCursor?}, truncated?, total, sourceTotal}
// 〔视图修订 2026-10-25·二次〕双模式取消：detail 仅按轮摘要（用户指令 + toolGroup +
// 每轮结论）；全量转录不进视图。items.kind 增 "toolGroup"（按轮动作组，携带 count +
// tools 逐条载荷），响应新增 sourceTotal（投影前原始条数）；total/seq/nextCursor 与
// 256KiB 预算均基于投影后条目。
// items 合成 = db.sqlite message/part 只读导出（时间序）+ events.jsonl/delivered（经
// 重放态 state.messages/delivered）回填 framed 徽标（H14：hook 注入不落 transcript part
// → 团队消息以徽标标注在**其落库的首条 real_user 文本 item**上，不改写原文）。
// 分页 = seq 游标（默认 100/页、上限 200；首屏取末页=最近上下文）；单页载荷 ≤256KiB
// （合成后逐 item 累计，超限截断页尾并置 truncated）。
// 错误复用 27 码子集：TEAM_NOT_MEMBER / TEAM_MEMBER_NOT_FOUND（草案误记 TEAM_NOT_FOUND，
// 目录正名 TEAM_MEMBER_NOT_FOUND——登记于开发记录）。
// CLI 对等：team-ctl transcript 复用本合成函数（不写第二实现）。

import { TeamError } from "../domain/errors.js";
import type { TeamState } from "../domain/projection.js";
import type { TranscriptReader, DetailPartRow } from "../provider/transcript.js";

/** toolGroup 组内逐条工具（载荷形态同 toolCall item；text 已按 2000 字符截断）。 */
export interface DetailToolEntry {
  /** 该工具条目的时间戳（ISO，同 toItem）。 */
  ts: string;
  name: string;
  status: string;
  text?: string;
}

/** detail 契约 item（接口草案 §5）。 */
export interface DetailItem {
  seq: number;
  /** 消息时间戳（ISO）。 */
  ts: string;
  role: "user" | "assistant";
  kind: "text" | "toolCall" | "toolGroup";
  text?: string;
  tool?: { name: string; status: string };
  /** toolGroup：组内逐条工具（仅 kind="toolGroup"）。 */
  tools?: DetailToolEntry[];
  /** toolGroup：动作条数 = tools.length（仅 kind="toolGroup"）。 */
  count?: number;
  /** 团队消息/hook 注入回填徽标（源 events/delivered；不改写原文）。 */
  framed?: { messageId: string; from: string };
}

export interface DetailPage {
  items: DetailItem[];
  /** 下一页游标（向更早方向 = seq 递减分页；无更早 → 缺省）。 */
  nextCursor?: number;
}

export interface DetailResult {
  sessionId: string;
  memberId: string;
  page: DetailPage;
  /** 单页载荷超 256KiB 截断页尾（H15a 预算保护）。 */
  truncated?: boolean;
  /** 投影后条目总数（分页定位）。 */
  total: number;
  /** 投影前原始条目数（计数文案 `n | 共 sourceTotal 条转录` 的数据源）。 */
  sourceTotal: number;
}

export const DETAIL_DEFAULT_LIMIT = 100;
export const DETAIL_MAX_LIMIT = 200;
/** 单页载荷预算（H15a 冻结草案 256KiB）。 */
export const DETAIL_PAGE_BYTES = 256 * 1024;

/** 工具结果内联文本预算（折叠展开可见；超出截断 + 省略标记）。 */
const TOOL_PAYLOAD_CHARS = 2000;

export interface DetailDeps {
  teamDir: string;
  teamId: string;
  state: TeamState;
  reader: TranscriptReader;
}

/**
 * 解析成员会话 id：lead → teamId；teammate → origin.json（member-files 读）。
 * 非成员/未落定 → TeamError（TEAM_MEMBER_NOT_FOUND；消息逐字对齐 02 §11 目录模板）。
 * 「未落定」以 SessionNotSettledError 子类区分（消息仍逐字；reason 由 panel-call 读取
 * → 面板呈现 detail.noSession 可读态，不留死按钮）。
 */
export class SessionNotSettledError extends TeamError {
  readonly sessionNotSettled = true;
}

export function resolveMemberSessionId(
  deps: DetailDeps,
  target: string,
  readOriginSession: (memberId: string) => string | null | undefined,
): { memberId: string; sessionId: string; name: string } {
  if (target === deps.teamId || target === "lead") {
    return { memberId: deps.teamId, sessionId: deps.teamId, name: "lead" };
  }
  const member = deps.state.members.find((m) => m.id === target || m.name === target);
  if (member === undefined) {
    throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${target}" not found`);
  }
  const sessionId = readOriginSession(member.id);
  if (sessionId === null || sessionId === undefined) {
    throw new SessionNotSettledError(
      "TEAM_MEMBER_NOT_FOUND",
      `active teammate "${member.name}" not found`,
    );
  }
  return { memberId: member.id, sessionId, name: member.name };
}

/**
 * 合成成员会话流（db 导出 + framed 徽标回填）。
 * framed 回填规则：目标成员收到的团队消息（state.messages 中 targetId = memberId 且已
 * delivered）按轮次 prompt 合并注入（stage-4 口径）→ 其框架头文本
 * `Team message from <name>:` 出现在**落库的 real_user 文本**里；按文本包含关系匹配
 * （每条消息只标注一次，取首个未标注的匹配 item；消息序 = 队列序）。
 * lead 目标：回执（receipts）折叠的 delivered 同规则回填。
 */
export function synthesizeDetailStream(deps: DetailDeps, sessionId: string, memberId: string): {
  items: Omit<DetailItem, "seq">[];
} {
  const rows = deps.reader.exportDetailParts(sessionId);
  const framedQueue = framedFor(deps.state, memberId);
  const items: Omit<DetailItem, "seq">[] = [];
  const used = new Set<number>();
  for (const row of rows) {
    const item = toItem(row);
    // framed 徽标回填：user 文本 item 且包含某条未标注团队消息的框架头/正文
    if (item.role === "user" && item.kind === "text" && item.text !== undefined) {
      const idx = framedQueue.findIndex((f, i) => !used.has(i) && textCarriesFrame(item.text!, f));
      if (idx >= 0) {
        used.add(idx);
        item.framed = { messageId: framedQueue[idx].messageId, from: framedQueue[idx].from };
      }
    }
    items.push(item);
  }
  return { items };
}

interface FramedEntry {
  messageId: string;
  from: string;
  body: string;
}

/** 目标成员已投递的团队消息（时间序 = 事件队列序；delivered 才回填——徽标语义「已送达」）。 */
export function framedFor(state: TeamState, memberId: string): FramedEntry[] {
  const delivered = new Set(state.delivered);
  return state.messages
    .filter((m) => m.targetId === memberId && delivered.has(m.id))
    .map((m) => ({
      messageId: m.id,
      from: m.senderName,
      body: m.content
        .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
        .join("\n"),
    }));
}

/** 落库文本是否携带该团队消息（框架头或正文子串匹配；stage-4 合并注入 = 逐字包含）。 */
function textCarriesFrame(text: string, framed: FramedEntry): boolean {
  if (text.includes(`Team message from ${framed.from}:`)) return true;
  // 正文锚（首 64 字符）防框架头缺失（宿主截断/改写前缀）
  const anchor = framed.body.slice(0, 64);
  return anchor.length >= 8 && text.includes(anchor);
}

function toItem(row: DetailPartRow): Omit<DetailItem, "seq"> {
  const base = { ts: new Date(row.ts).toISOString(), role: row.role };
  if (row.kind === "text") {
    return { ...base, kind: "text", text: row.text ?? "" };
  }
  const tool = { name: row.toolName ?? "unknown", status: row.toolStatus ?? "unknown" };
  // 折叠展开后的载荷（面板 tool-detail 区）：文本化 + 预算截断
  const parts: string[] = [];
  if (row.toolInput !== undefined) parts.push(`input: ${stringify(row.toolInput)}`);
  if (row.toolOutput !== undefined) parts.push(`output: ${stringify(row.toolOutput)}`);
  if (parts.length === 0) return { ...base, kind: "toolCall", tool };
  const payload = parts.join("\n");
  return {
    ...base,
    kind: "toolCall",
    tool,
    text: payload.length > TOOL_PAYLOAD_CHARS
      ? payload.slice(0, TOOL_PAYLOAD_CHARS) + "\n…(truncated)"
      : payload,
  };
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

interface SummaryRound {
  /** 轮边界 user 文本条目（虚拟轮 0 无）。 */
  user?: Omit<DetailItem, "seq">;
  /** 本轮全部 toolCall 条目（时间序）。 */
  tools: Array<Omit<DetailItem, "seq">>;
  /** 本轮最后一条非空 assistant 文本（trim 后长度 > 0）。 */
  conclusion?: Omit<DetailItem, "seq">;
}

/**
 * 按轮摘要投影（〔视图修订 2026-10-25〕；作用于 framed 回填后的合成流，pageDetail 之前）。
 * 轮边界 = role==="user" && kind==="text"；每轮输出①该 user 条目原样（含 framed 徽标）
 * ②一条 toolGroup（聚合本轮全部 toolCall；本轮无工具 → 不输出）③本轮最后一条非空
 * assistant text（无 → 不输出）。首个 user 之前的孤儿条目归虚拟轮 0（只按②③输出）。
 */
export function projectSummary(
  items: ReadonlyArray<Omit<DetailItem, "seq">>,
): Omit<DetailItem, "seq">[] {
  const out: Omit<DetailItem, "seq">[] = [];
  let round: SummaryRound = { tools: [] };
  for (const item of items) {
    if (item.role === "user" && item.kind === "text") {
      flushRound(out, round);
      round = { user: item, tools: [] };
      continue;
    }
    if (item.kind === "toolCall") {
      round.tools.push(item);
      continue;
    }
    if (item.role === "assistant" && item.kind === "text" && (item.text ?? "").trim().length > 0) {
      round.conclusion = item;
    }
  }
  flushRound(out, round);
  return out;
}

function flushRound(out: Omit<DetailItem, "seq">[], round: SummaryRound): void {
  if (round.user !== undefined) out.push(round.user);
  if (round.tools.length > 0) out.push(toolGroupItem(round.tools));
  if (round.conclusion !== undefined) out.push(round.conclusion);
}

/** 动作组条目：ts = 组内最后一个工具的 ts；成员逐条沿用 toolCall 载荷（已截断）。 */
function toolGroupItem(
  tools: ReadonlyArray<Omit<DetailItem, "seq">>,
): Omit<DetailItem, "seq"> {
  const entries: DetailToolEntry[] = tools.map((item) => ({
    ts: item.ts,
    name: item.tool?.name ?? "unknown",
    status: item.tool?.status ?? "unknown",
    ...(item.text !== undefined ? { text: item.text } : {}),
  }));
  const last = entries[entries.length - 1];
  return { ts: last.ts, role: "assistant", kind: "toolGroup", count: entries.length, tools: entries };
}

/**
 * 分页（seq 游标）：items 全量编号（seq = 1 起时间序）；cursor 语义 = 「返回 seq < cursor
 * 的最近 limit 条」（首屏 cursor 缺省 = 取末页/最近上下文；nextCursor = 页首 seq，仍有更早
 * 时给出）。单页字节预算超限 → 截断页尾（丢最旧条）并置 truncated。
 */
export function pageDetail(
  items: ReadonlyArray<Omit<DetailItem, "seq">>,
  opts: { cursor?: number; limit?: number },
): { page: DetailPage; total: number; truncated: boolean } {
  const limit = normalizeLimit(opts.limit);
  const total = items.length;
  const upper = opts.cursor !== undefined ? Math.min(opts.cursor - 1, total) : total;
  const start = Math.max(0, upper - limit);
  let slice = items.slice(start, upper);
  let truncated = false;
  // 字节预算（H15a）：UTF-8 字节，不是 UTF-16 码元；从页尾（最旧）向前裁剪
  const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
  let bytes = bytesOf(slice);
  while (slice.length > 1 && bytes > DETAIL_PAGE_BYTES) {
    slice = slice.slice(1);
    truncated = true;
    bytes = bytesOf(slice);
  }
  const firstSeq = start + (items.slice(start, upper).length - slice.length) + 1;
  const numbered: DetailItem[] = slice.map((item, i) => ({ seq: firstSeq + i, ...item }));
  const page: DetailPage = { items: numbered };
  if (start > 0) page.nextCursor = firstSeq;
  return { page, total, truncated };
}

export function normalizeLimit(limit: unknown): number {
  if (limit === undefined) return DETAIL_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", "limit must be a positive safe integer");
  }
  return Math.min(limit, DETAIL_MAX_LIMIT);
}

/** detail 请求全链（team_panel_call 与 team-ctl transcript 共用入口）。 */
export function buildDetail(
  deps: DetailDeps,
  args: { target: string; cursor?: number; limit?: number },
  readOriginSession: (memberId: string) => string | null | undefined,
): DetailResult {
  const { memberId, sessionId } = resolveMemberSessionId(deps, args.target, readOriginSession);
  const stream = synthesizeDetailStream(deps, sessionId, memberId);
  const sourceTotal = stream.items.length;
  const projected = projectSummary(stream.items);
  const { page, total, truncated } = pageDetail(projected, {
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return {
    sessionId,
    memberId,
    page,
    ...(truncated ? { truncated: true } : {}),
    total,
    sourceTotal,
  };
}

/** team-ctl transcript 的纯文本渲染（CLI 对等，F12；同一合成流，不写第二实现）。 */
export function renderDetailText(result: DetailResult, memberName: string): string {
  const lines: string[] = [];
  lines.push(
    `member ${memberName} (${result.memberId}) · session ${result.sessionId} · ${result.total} items (summary of ${result.sourceTotal})`,
  );
  for (const item of result.page.items) {
    const time = item.ts.slice(11, 19);
    if (item.kind === "toolCall") {
      lines.push(`[${time}] ${item.role} tool ${item.tool?.name ?? "?"} (${item.tool?.status ?? "?"})`);
      if (item.text !== undefined) {
        for (const l of item.text.split("\n").slice(0, 6)) lines.push(`    ${l.slice(0, 160)}`);
      }
      continue;
    }
    if (item.kind === "toolGroup") {
      const counts = new Map<string, number>();
      for (const tool of item.tools ?? []) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      const list = [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, n]) => `${name}×${n}`)
        .join(" · ");
      lines.push(`[${time}] ${item.role} · ${item.count ?? item.tools?.length ?? 0} 个动作（${list}）`);
      continue;
    }
    const badge = item.framed !== undefined ? ` [team ← ${item.framed.from}]` : "";
    lines.push(`[${time}] ${item.role}${badge}:`);
    for (const l of (item.text ?? "").split("\n")) lines.push(`    ${l}`);
  }
  if (result.truncated === true) lines.push(`(page truncated to ${DETAIL_PAGE_BYTES / 1024}KiB budget)`);
  if (result.page.nextCursor !== undefined) lines.push(`(earlier messages: cursor=${result.page.nextCursor})`);
  return lines.join("\n");
}
