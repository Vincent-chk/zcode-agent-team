// 会话库只读探针（stage-4；H3/23-F08 实测 schema）。node:sqlite 只读打开 ~/.zcode/cli/db/db.sqlite，
// WAL 并发读无碍（stage-1 定案）。全部查询走索引（session.directory 无索引但表仅千行级；message/part
// 按 session_id 索引）。DB 路径可注入（TEAM_DB_PATH / 测试夹具用独立临时库）。
// 「未持久接收」与「读取失败」严格区分：库文件不存在 = 无记录（undefined/null）；SQL 损坏 = 抛错
// （→ 恢复对账 `child Session recovery failed: …`）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseModelSelection, type MemberModelSelection } from "./model-selection.js";

export interface TranscriptSessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  task_type: string | null;
  title: string | null;
  time_created: number;
}

export interface TranscriptUserMessage {
  messageId: string;
  text: string;
  timeCreated: number;
  origin: string | null;
  modelId: string | null;
}

export interface TurnExport {
  role: "user" | "assistant";
  text: string;
  toolNames: string[];
}

export interface TranscriptDeps {
  /** db 路径（默认 ~/.zcode/cli/db/db.sqlite）。 */
  dbPath?: string;
  now?: () => number;
}

export function defaultDbPath(): string {
  return process.env.TEAM_DB_PATH ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export class TranscriptReader {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;
  private dbMissing = false;

  constructor(deps: TranscriptDeps = {}) {
    this.dbPath = deps.dbPath ?? defaultDbPath();
  }

  get path(): string {
    return this.dbPath;
  }

  /** 库不存在 = 空库语义（探针方法走缺省值，不建临时库）。 */
  private missing(): boolean {
    if (!this.dbMissing) this.dbMissing = !fs.existsSync(this.dbPath);
    else if (!fs.existsSync(this.dbPath)) return true;
    else this.dbMissing = false; // 库后续出现（测试/宿主晚建）→ 重新打开
    return this.dbMissing;
  }

  private open(): DatabaseSync {
    if (this.db !== null) return this.db;
    if (!fs.existsSync(this.dbPath)) {
      throw new Error("transcript db missing"); // missing() 未拦截的路径（防御）
    }
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** 会话行实查；不存在 → undefined；读失败 → 抛错。 */
  session(sessionId: string): TranscriptSessionRow | undefined {
    if (this.missing()) return undefined;
    const row = this.open()
      .prepare(
        "SELECT id, parent_id, directory, task_type, title, time_created FROM session WHERE id = ?",
      )
      .get(sessionId) as Omit<TranscriptSessionRow, "time_created"> & { time_created: number } | undefined;
    return row ?? undefined;
  }

  /** 找「目录 = cwd 且创建于 sinceMs 之后、首条真实用户文本 = firstPrompt」的会话（fresh spawn 探针）。 */
  findSessionByFirstPrompt(args: {
    cwd: string;
    firstPrompt: string;
    sinceMs: number;
    excludeSessionIds?: ReadonlySet<string>;
  }): string | undefined {
    if (this.missing()) return undefined;
    const rows = this.open()
      .prepare(
        "SELECT id, time_created FROM session WHERE directory = ? AND time_created >= ? ORDER BY time_created ASC",
      )
      .all(args.cwd, args.sinceMs - 2_000) as Array<{ id: string; time_created: number }>;
    for (const row of rows) {
      if (args.excludeSessionIds?.has(row.id)) continue;
      const first = this.firstRealUserText(row.id);
      if (first === args.firstPrompt) return row.id;
    }
    return undefined;
  }

  /** 首条「真实用户」消息的文本部分（跳过 hook/系统注入的 model-only 消息）。 */
  firstRealUserText(sessionId: string): string | null {
    if (this.missing()) return null;
    const rows = this.open()
      .prepare(
        `SELECT p.data pdata FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data,'$.role') = 'user'
           AND json_extract(m.data,'$.semantics.origin') = 'real_user'
           AND json_extract(p.data,'$.type') = 'text'
         ORDER BY m.sequence, p.sequence LIMIT 1`,
      )
      .all(sessionId) as Array<{ pdata: string }>;
    if (rows.length === 0) return null;
    return extractText(rows[0].pdata);
  }

  /** 会话中是否已存在该文本的「真实用户」消息（delivered/去重探针：prompt 逐字落库）。 */
  hasUserText(sessionId: string, text: string): boolean {
    if (this.missing()) return false;
    const row = this.open()
      .prepare(
        `SELECT COUNT(*) n FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data,'$.role') = 'user'
           AND json_extract(m.data,'$.semantics.origin') = 'real_user'
           AND json_extract(p.data,'$.type') = 'text'
           AND json_extract(p.data,'$.text') = ? LIMIT 1`,
      )
      .get(sessionId, text) as { n: number };
    return row.n > 0;
  }

  /** 会话全部「真实用户」文本消息（时间序；轮次 prompt 审计/恰一次检索用）。 */
  realUserTexts(sessionId: string): TranscriptUserMessage[] {
    if (this.missing()) return [];
    const rows = this.open()
      .prepare(
        `SELECT m.id mid, m.time_created tc, p.data pdata,
                json_extract(m.data,'$.semantics.origin') origin,
                json_extract(m.data,'$.modelSelection.modelId') model
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data,'$.role') = 'user'
           AND json_extract(m.data,'$.semantics.origin') = 'real_user'
           AND json_extract(p.data,'$.type') = 'text'
         ORDER BY m.sequence, p.sequence`,
      )
      .all(sessionId) as Array<{
      mid: string;
      tc: number;
      pdata: string;
      origin: string | null;
      model: string | null;
    }>;
    return rows.map((r) => ({
      messageId: r.mid,
      text: extractText(r.pdata) ?? "",
      timeCreated: r.tc,
      origin: r.origin,
      modelId: r.model,
    }));
  }

  /** 会话最新使用的模型（成员行 model 字段实查；无消息 → undefined）。 */
  latestModel(sessionId: string): string | undefined {
    if (this.missing()) return undefined;
    const row = this.open()
      .prepare(
        `SELECT json_extract(m.data,'$.modelSelection.modelId') model FROM message m
         WHERE m.session_id = ? AND json_extract(m.data,'$.modelSelection.modelId') IS NOT NULL
         ORDER BY m.sequence DESC LIMIT 1`,
      )
      .get(sessionId) as { model: string } | undefined;
    return row?.model;
  }

  /**
   * 会话库中最近一次 setModel 的选择（Round A 实证：条目为 UPSERT 单行，canonical id
   * `<sessionId>:runtime-model-selection`，时间排序安全）。data 取嵌套 modelSelection 优先；
   * 兼容旧行把 providerId/modelId/thoughtLevel 平铺在顶层的形态。
   */
  latestModelSelection(sessionId: string): MemberModelSelection | undefined {
    if (this.missing()) return undefined;
    const row = this.open()
      .prepare(
        `SELECT data FROM session_entry
         WHERE session_id = ? AND type = 'runtime/model_selection'
         ORDER BY time_created DESC LIMIT 1`,
      )
      .get(sessionId) as { data: string } | undefined;
    if (row === undefined) return undefined;
    const data = parseOrNull(row.data) as
      | { modelSelection?: unknown; providerId?: unknown; modelId?: unknown; thoughtLevel?: unknown }
      | null;
    if (data === null) return undefined;
    const nested = parseModelSelection(data.modelSelection);
    if (nested !== undefined) return nested;
    // 旧行/别路写入的平铺形态（无嵌套对象时兜底）
    const providerId = typeof data.providerId === "string" ? data.providerId.trim() : "";
    const modelId = typeof data.modelId === "string" ? data.modelId.trim() : "";
    if (providerId.length === 0 || modelId.length === 0) return undefined;
    const thoughtLevel = typeof data.thoughtLevel === "string" ? data.thoughtLevel.trim() : "";
    return {
      providerId,
      modelId,
      ...(thoughtLevel.length > 0 ? { reasoningLevel: thoughtLevel } : {}),
    };
  }

  /** 最近一次真实模型调用（session_entry 缺失时的继承兜底；variant = 思考强度）。 */
  latestModelUsage(sessionId: string): MemberModelSelection | undefined {
    if (this.missing()) return undefined;
    const row = this.open()
      .prepare(
        `SELECT provider_id, model_id, variant FROM model_usage
         WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId) as { provider_id: string; model_id: string; variant: string | null } | undefined;
    if (row === undefined) return undefined;
    const providerId = row.provider_id.trim();
    const modelId = row.model_id.trim();
    if (providerId.length === 0 || modelId.length === 0) return undefined;
    const variant = typeof row.variant === "string" ? row.variant.trim() : "";
    return {
      providerId,
      modelId,
      ...(variant.length > 0 ? { reasoningLevel: variant } : {}),
    };
  }

  /** 完成回合导出（D3 fork 转录）：真实用户消息 + 助手文本；tool 部分记工具名。 */
  exportTurns(sessionId: string): TurnExport[] {
    if (this.missing()) return [];
    const rows = this.open()
      .prepare(
        `SELECT m.data mdata, p.data pdata FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
         ORDER BY m.sequence, p.sequence`,
      )
      .all(sessionId) as Array<{ mdata: string; pdata: string }>;
    const turns: TurnExport[] = [];
    for (const r of rows) {
      // 损坏行（写者中途死亡等）跳过：fork 转录是只读导出，单行损坏不阻断 spawn
      const message = parseOrNull(r.mdata) as { role?: string; semantics?: { origin?: string; kind?: string } } | null;
      const part = parseOrNull(r.pdata) as { type?: string; text?: string; tool?: string } | null;
      if (message === null || part === null) continue;
      const isUser = message.role === "user";
      const isAssistant = message.role === "assistant";
      const realUser = isUser && message.semantics?.origin === "real_user";
      if (part.type === "text" && typeof part.text === "string") {
        if (realUser) turns.push({ role: "user", text: part.text, toolNames: [] });
        else if (isAssistant) turns.push({ role: "assistant", text: part.text, toolNames: [] });
      } else if (isAssistant && part.type === "tool" && typeof part.tool === "string") {
        const last = turns[turns.length - 1];
        if (last !== undefined && last.role === "assistant" && !last.toolNames.length) {
          last.toolNames.push(part.tool);
        } else {
          turns.push({ role: "assistant", text: "", toolNames: [part.tool] });
        }
      }
    }
    return turns;
  }

  /**
   * T5.7 成员会话查看视图导出（detail 合成数据源；只读、走 session_id 索引）：
   * 时间序全量 part 行（text/tool 两型；其余 part 型跳过），损坏行跳过。
   * 与 exportTurns 的区别：保留每条 part 的时间戳/role/工具状态（面板折叠行渲染），
   * 不做回合聚合；hook 注入文本不落 transcript part（H14），framed 徽标由
   * panel/detail.ts 以 events 回填（不改写原文）。
   */
  exportDetailParts(sessionId: string): DetailPartRow[] {
    if (this.missing()) return [];
    const rows = this.open()
      .prepare(
        `SELECT m.data mdata, m.time_created mtc, p.data pdata, p.time_created ptc
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
         ORDER BY m.sequence, p.sequence`,
      )
      .all(sessionId) as Array<{ mdata: string; mtc: number; pdata: string; ptc: number }>;
    const out: DetailPartRow[] = [];
    for (const r of rows) {
      const message = parseOrNull(r.mdata) as {
        role?: string;
        semantics?: { origin?: string };
      } | null;
      const part = parseOrNull(r.pdata) as {
        type?: string;
        text?: string;
        tool?: string;
        state?: { status?: string; input?: unknown; output?: unknown };
      } | null;
      if (message === null || part === null) continue;
      const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
      if (role === undefined) continue;
      // 用户侧仅收真实用户文本（hook_context/系统注入不是 real_user；H14：注入不落 part）
      if (role === "user" && message.semantics?.origin !== "real_user") continue;
      const ts = typeof r.ptc === "number" ? r.ptc : r.mtc;
      if (part.type === "text" && typeof part.text === "string") {
        out.push({ ts, role, kind: "text", text: part.text });
      } else if (part.type === "tool" && typeof part.tool === "string") {
        const status = typeof part.state?.status === "string" ? part.state.status : "unknown";
        out.push({
          ts,
          role: "assistant",
          kind: "toolCall",
          toolName: part.tool,
          toolStatus: status,
          ...(part.state?.input !== undefined ? { toolInput: part.state.input } : {}),
          ...(part.state?.output !== undefined ? { toolOutput: part.state.output } : {}),
        });
      }
      // 其余 part 型（reasoning/step-*/timeline/file/compaction）不进查看视图（契约三 kind）
    }
    return out;
  }
}

/** exportDetailParts 行（panel/detail.ts 合成 detail 契约 items 的输入）。 */
export interface DetailPartRow {
  ts: number;
  role: "user" | "assistant";
  kind: "text" | "toolCall";
  text?: string;
  toolName?: string;
  toolStatus?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}

function parseOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractText(partData: string): string | null {
  try {
    const part = JSON.parse(partData) as { text?: unknown };
    return typeof part.text === "string" ? part.text : null;
  } catch {
    return null;
  }
}
