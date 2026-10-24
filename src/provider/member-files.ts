// 成员持久布局（stage-4；05 §2 的 ZCode 落地，pending 除外——pending 由 events.jsonl 派生，
// stage-2 已定案，见开发记录披露）：
//   <teamDir>/members/<memberId>/
//     origin.json          供给四条件对账记录（rootSessionId/provider/mode/初始消息指纹/sessionId）
//     receipts.jsonl       Hook 回执（Lead 目标投递的 delivered 依据；协调者冷启动折叠为事件）
//     stop-budget.json     Stop hook block 预算（≤3 次/run，runKey = stop_hook_active 复位语义）
//     run/current.json     当前轮次指针 { turnId }
//     run/turn-<n>.json    轮次记录（argv/pid/pgid/messageIds/promptText/status/landed）
//     run/turn-<n>.out     轮次进程 stdout+stderr（--json 输出留存，daemon 回收后仍可取证）
// 写纪律：状态文件 tmp+fsync+rename 原子替换；回执 O_APPEND+fsync（多写者安全——hook 进程与
// 协调者进程都可能写）；读失败一律显式（undefined 只表示「文件不存在」）。

import fs from "node:fs";
import path from "node:path";
import type { MemberModelSelection } from "./model-selection.js";

export interface OriginRecord {
  teamId: string;
  memberId: string;
  name: string;
  /** 成员行 provider 字段（"spawn" | "fork"）。 */
  provider: string;
  /** 四条件之一：mode === "continuable"。 */
  mode: "continuable";
  context: "fresh" | "fork";
  createdAt: string;
  cwd: string;
  /** 首轮实际 prompt 文本（fork = 转录+任务块；db 探针与 landed 判定的锚点）。 */
  firstPromptText: string;
  firstPromptSha256: string;
  /** 首轮会话 id（探测/认领后回填；null = 未落定）。 */
  sessionId: string | null;
  /** 首条用户消息已持久接收（db 实查；对账四条件之一）。 */
  initialUserMessageAccepted: boolean;
  /** spawn 请求的 model（缺省 = CLI 默认；成员行 model 由 transcript 实查优先）。 */
  model?: string;
  /** 生效的结构化模型选择（继承/显式；展示/审计用，非生效机制）。 */
  modelSelection?: MemberModelSelection;
  /** 选择来源：explicit = spawn/对话显式指定；inherited = 继承自 Lead。 */
  modelSource?: "inherited" | "explicit";
  /** 会话隔离形态（stage-6）：child = 宿主原生隐藏子会话；legacy = 旧顶层 interactive（回滚用）。 */
  sessionIsolation?: "child" | "legacy";
  /** 隐藏子会话的物理 parent（anchor 会话 id；仅 sessionIsolation=child 时存在）。 */
  anchorSessionId?: string;
  /** 逻辑父会话（= 团队的 Lead 会话 id = teamId）。 */
  logicalParentSessionId?: string;
  /** 宿主会话类型（仅记录；child = selection_side_chat）。 */
  sessionKind?: "selection_side_chat" | "interactive";
}

export interface TurnRecord {
  turnId: string;
  memberId: string;
  kind: "first" | "deliver";
  sessionId: string | null;
  /** 本轮 prompt 所含消息 id（内部去重/恰一次锚点；不进模型可见文本，D1）。 */
  messageIds: string[];
  promptText: string;
  argv: string[];
  pid: number | null;
  pgid: number | null;
  status: "starting" | "running" | "exited" | "interrupted" | "failed" | "spawn-error";
  /** 已请求中断但尚未确认进程组退出：status 仍为 running，watcher 负责收尾。 */
  interruptRequestedAt?: string;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** prompt 已落目标会话 transcript（db 实查）。 */
  landed?: boolean;
  stdoutFile: string;
}

export interface Receipt {
  messageId: string;
  channel: "stop" | "userpromptsubmit" | "sessionstart";
  ts: string;
}

export interface StopBudget {
  /** 本次 run 的 block 计数；runKey 变更时复位。 */
  runKey: string;
  blocks: number;
}

export interface MemberPaths {
  memberDir: string;
  originFile: string;
  receiptsFile: string;
  stopBudgetFile: string;
  runDir: string;
  currentFile: string;
  drainMarkerFile: string;
  /** mid-life 模型修改的待应用标记（下一轮拉起前应用；成功即删）。 */
  modelPendingFile: string;
}

export function memberPaths(teamDir: string, memberId: string): MemberPaths {
  const memberDir = path.join(teamDir, "members", memberId);
  const runDir = path.join(memberDir, "run");
  return {
    memberDir,
    originFile: path.join(memberDir, "origin.json"),
    receiptsFile: path.join(memberDir, "receipts.jsonl"),
    stopBudgetFile: path.join(memberDir, "stop-budget.json"),
    runDir,
    currentFile: path.join(runDir, "current.json"),
    drainMarkerFile: path.join(runDir, "drain-requested.json"),
    modelPendingFile: path.join(memberDir, "model-pending.json"),
  };
}

export function turnFile(runDir: string, turnId: string): string {
  return path.join(runDir, `${turnId}.json`);
}

// ---------------------------------------------------------------- 原子 JSON 读写

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 读 JSON：不存在 → undefined；存在但损坏 → 抛错（显式失败，不静默）。 */
export function readJson<T>(file: string): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------- origin / turn / current

export function writeOrigin(paths: MemberPaths, origin: OriginRecord): void {
  writeJsonAtomic(paths.originFile, origin);
}

export function readOrigin(paths: MemberPaths): OriginRecord | undefined {
  return readJson<OriginRecord>(paths.originFile);
}

export function writeTurn(runDir: string, turn: TurnRecord): void {
  writeJsonAtomic(turnFile(runDir, turn.turnId), turn);
}

export function readTurn(runDir: string, turnId: string): TurnRecord | undefined {
  return readJson<TurnRecord>(turnFile(runDir, turnId));
}

export function setCurrentTurn(paths: MemberPaths, turnId: string): void {
  writeJsonAtomic(paths.currentFile, { turnId });
}

export function readCurrentTurnId(paths: MemberPaths): string | undefined {
  return readJson<{ turnId: string }>(paths.currentFile)?.turnId;
}

/** run/ 全部轮次记录（按序号升序；损坏文件抛错）。 */
export function listTurns(runDir: string): TurnRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => /^turn-\d+\.json$/.test(n))
    .sort((a, b) => turnNumber(a) - turnNumber(b))
    .map((n) => readJson<TurnRecord>(path.join(runDir, n)))
    .filter((t): t is TurnRecord => t !== undefined);
}

function turnNumber(name: string): number {
  return Number(name.slice("turn-".length, -".json".length));
}

export function nextTurnId(runDir: string): string {
  let names: string[] = [];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    /* 无 run 目录 → 1 */
  }
  let max = 0;
  for (const n of names) {
    if (/^turn-\d+\.json$/.test(n)) max = Math.max(max, turnNumber(n));
  }
  return `turn-${max + 1}`;
}

// ---------------------------------------------------------------- 回执（多写者 O_APPEND）

export function appendReceipt(paths: MemberPaths, receipt: Receipt): void {
  fs.mkdirSync(path.dirname(paths.receiptsFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(paths.receiptsFile, "a", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(receipt) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readReceipts(paths: MemberPaths): Receipt[] {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.receiptsFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const receipts: Receipt[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    receipts.push(JSON.parse(line) as Receipt); // 损坏行显式抛错
  }
  return receipts;
}

export function receiptMessageIds(paths: MemberPaths): Set<string> {
  return new Set(readReceipts(paths).map((r) => r.messageId));
}

// ---------------------------------------------------------------- Stop 预算

export function readStopBudget(paths: MemberPaths): StopBudget | undefined {
  return readJson<StopBudget>(paths.stopBudgetFile);
}

export function writeStopBudget(paths: MemberPaths, budget: StopBudget): void {
  writeJsonAtomic(paths.stopBudgetFile, budget);
}
