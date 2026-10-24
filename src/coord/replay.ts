// 冷启动重放 + checkpoint（stage-2 §2 / F32）。
// 「冷启动 = 全量重放 + 恢复对账」是常态路径（宿主 30s 回收 daemon）；本模块必须是
// 无前置状态的纯函数式恢复：任何进程读同一 events.jsonl 必得同一状态。
//
// checkpoint（checkpoint.json，与接口草案 §5 视图快照同构——stateVersion=4 标记 + 全量视图）：
//   { kind, stateVersion: 4, lastSeq, lastOffset, savedAt, state: <持久状态 C9 schema>, view }
//   - 恢复游标（lastSeq/lastOffset）放外层包装字段，不污染冻结的帧形状；
//   - state 用第一轮 teamStateSchema（strict）校验；view 仅存档（载入时由 state 确定性重建）；
//   - 版本匹配 → 从 lastOffset 增量重放（仅校验首行 seq 衔接，衔接失败回退全量）；
//   - checkpoint 损坏/不匹配 → 忽略并全量重放（checkpoint 是加速器，不承载正确性）。
//
// 损坏行处置（fail-closed，不静默跳过）：坏 JSON / 缺 event 字段 / seq 断号 →
//   state.failure = `persisted Agent Teams <type> payload is invalid`（type 从原始行文本宽松提取
//   team/* 型名；提取不到用 "stream"），并记录 corrupt 定位信息。语义对齐 02 §3.2 C9（02 未覆盖
//   「行整体不可解析」的型名占位——本处为协调层登记口径，见交付说明）。

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  applyProjectionEvent,
  emptyTeamState,
  teamProjectionView,
  TEAM_PROJECTION_STATE_VERSION,
} from "../domain/projection.js";
import type { TeamProjectionView, TeamState } from "../domain/projection.js";
import { teamStateSchema } from "../domain/events.js";

export interface LoadedTeam {
  state: TeamState;
  view: TeamProjectionView;
  /** 已消费的行数（= 最后有效 seq；failure 行计入其位）。 */
  seq: number;
  fromCheckpoint: boolean;
  /** checkpoint 存在但被忽略的原因（损坏/版本不匹配/校验失败）。 */
  checkpointIgnored?: string;
  /** 日志损坏定位（fail-closed 已生效）。 */
  corrupt?: { line: number; reason: string };
  /** 首见顺序的 writer 变迁（双写排查依据）。 */
  writers: string[];
  /** 重放耗时（ms；F32 观测）。 */
  replayMs: number;
}

export interface CheckpointInput {
  state: TeamState;
  view: TeamProjectionView;
  seq: number;
  /** 前 seq 行的总字节数（journal 跟踪值；缺省时本函数扫描计算）。 */
  byteOffset?: number;
}

const checkpointDocSchema = z.strictObject({
  kind: z.literal("agent-team-checkpoint"),
  stateVersion: z.literal(TEAM_PROJECTION_STATE_VERSION),
  lastSeq: z.number().int().nonnegative(),
  lastOffset: z.number().int().nonnegative(),
  savedAt: z.string(),
  state: teamStateSchema,
  view: z.unknown(),
});

export type CheckpointDoc = z.infer<typeof checkpointDocSchema>;

export function checkpointPath(teamDir: string): string {
  return path.join(teamDir, "checkpoint.json");
}

/** 冷启动恢复（纯函数式；无内存前置）。 */
export async function load(teamDir: string, teamId: string): Promise<LoadedTeam> {
  const startedAt = Date.now();
  const eventsFile = path.join(teamDir, "events.jsonl");
  const raw = readBufferOrEmpty(eventsFile);

  let checkpointIgnored: string | undefined;
  let doc: CheckpointDoc | undefined;
  try {
    const rawDoc = fs.readFileSync(checkpointPath(teamDir), "utf8");
    const parsed = checkpointDocSchema.safeParse(JSON.parse(rawDoc));
    if (!parsed.success) {
      checkpointIgnored = `checkpoint invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`;
    } else if (parsed.data.state.id !== teamId) {
      checkpointIgnored = `checkpoint teamId mismatch (${parsed.data.state.id} != ${teamId})`;
    } else {
      doc = parsed.data;
    }
  } catch {
    /* 无 checkpoint → 全量重放（常态） */
  }

  const writers: string[] = [];
  let state = emptyTeamState(teamId);
  let seq = 0;
  let fromCheckpoint = false;
  let corrupt: LoadedTeam["corrupt"];

  if (doc !== undefined) {
    // 增量路径：从 lastOffset（字节）起读，校验首行 seq 衔接（切进行中间/断号均判脱同步 → 全量）
    const tail = raw.subarray(doc.lastOffset);
    const first = firstLineBytes(tail);
    if (tail.length > 0 && first === undefined) {
      checkpointIgnored = "checkpoint offset desync (tail not line-aligned) — full replay";
    } else if (first !== undefined && (JSON.parse(first.parsed) as { seq?: unknown }).seq !== doc.lastSeq + 1) {
      checkpointIgnored = "checkpoint offset desync (seq continuity broken) — full replay";
    } else {
      state = doc.state;
      seq = doc.lastSeq;
      fromCheckpoint = true;
    }
  }

  const startOffset = fromCheckpoint && doc !== undefined ? doc.lastOffset : 0;
  let offset = startOffset;
  let consumeRest = true;
  while (consumeRest && offset < raw.length) {
    const nl = raw.indexOf(0x0a, offset);
    if (nl === -1) {
      // 末尾无换行 = 半行（写者中途死亡且 write 未原子完成——健康 FS 不应出现；fail-closed）
      corrupt = { line: seq + 1, reason: "trailing partial line (no newline)" };
      state = withFailure(state, raw.subarray(offset).toString("utf8"));
      seq += 1;
      consumeRest = false;
      break;
    }
    const lineText = raw.subarray(offset, nl).toString("utf8");
    const lineNo = seq + 1;
    offset = nl + 1;
    if (lineText.length === 0) {
      corrupt = { line: lineNo, reason: "empty line" };
      state = withFailure(state, lineText);
      seq = lineNo;
      consumeRest = false;
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      corrupt = { line: lineNo, reason: "invalid JSON" };
      state = withFailure(state, lineText);
      seq = lineNo;
      consumeRest = false;
      break;
    }
    const line = parsed as { seq: number; writer?: string; event: unknown };
    // 溯源先于形状/连续性判定：违规行（含双写者行）也必须留下 writer 痕迹
    if (typeof line.writer === "string" && !writers.includes(line.writer)) writers.push(line.writer);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { seq?: unknown }).seq !== "number" ||
      !("event" in (parsed as object)) ||
      (parsed as { seq: number }).seq !== lineNo
    ) {
      corrupt = { line: lineNo, reason: "line shape invalid or seq discontinuous" };
      state = withFailure(state, lineText);
      seq = lineNo;
      consumeRest = false;
      break;
    }
    state = applyProjectionEvent(state, line.event);
    seq = lineNo;
    if (state.failure !== undefined) {
      // 域规则 fail-closed（消息逐字来自第一轮投影）；终态，停止消费
      consumeRest = false;
    }
  }

  return {
    state,
    view: teamProjectionView(state),
    seq,
    fromCheckpoint,
    checkpointIgnored,
    corrupt,
    writers,
    replayMs: Date.now() - startedAt,
  };
}

/** 写 checkpoint（tmp+rename 原子；state fsync 后 rename）。 */
export async function writeCheckpoint(teamDir: string, input: CheckpointInput): Promise<void> {
  const eventsFile = path.join(teamDir, "events.jsonl");
  const byteOffset = input.byteOffset ?? countBytesOfLines(eventsFile, input.seq);
  const doc: CheckpointDoc = {
    kind: "agent-team-checkpoint",
    stateVersion: TEAM_PROJECTION_STATE_VERSION,
    lastSeq: input.seq,
    lastOffset: byteOffset,
    savedAt: new Date().toISOString(),
    state: input.state,
    view: input.view,
  };
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  const target = checkpointPath(teamDir);
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(doc));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------- 内部辅助

/** 事件日志按**字节**读取：checkpoint.lastOffset 是字节偏移，不能拿 UTF-8 字符串下标直接比
 *  （含中文时字符数 < 字节数，会导致增量重放静默丢掉尾部事件）。 */
function readBufferOrEmpty(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

function firstLineBytes(buf: Buffer): { parsed: string } | undefined {
  const nl = buf.indexOf(0x0a);
  const first = (nl === -1 ? buf : buf.subarray(0, nl)).toString("utf8");
  if (first.length === 0) return undefined;
  try {
    JSON.parse(first);
    return { parsed: first };
  } catch {
    return undefined;
  }
}

/** 损坏行 → failure 保护（C9 模板；type 宽松提取，缺省 "stream"）。 */
function withFailure(state: TeamState, rawLine: string): TeamState {
  const m = rawLine.match(/"type"\s*:\s*"(team\/[A-Za-z/-]+)"/);
  const type = m?.[1] ?? "stream";
  return { ...state, failure: `persisted Agent Teams ${type} payload is invalid` };
}

/** 前 seq 行的总字节数（checkpoint 未携带 byteOffset 时扫描计算；按字节计数）。 */
function countBytesOfLines(eventsFile: string, seq: number): number {
  const raw = readBufferOrEmpty(eventsFile);
  let offset = 0;
  for (let i = 0; i < seq; i++) {
    const nl = raw.indexOf(0x0a, offset);
    if (nl === -1) return raw.length;
    offset = nl + 1;
  }
  return offset;
}
