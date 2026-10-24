// 4 限额启动校验（02 规格 §4 / F31；〔对齐轮修订〕0.2.1-alpha.5：删 maxPendingMessagesPerMember，5→4）。
// 纯函数：输入 env-like 对象 → 配置或抛 TeamError。不读 process.env（接线归 daemon 层）；缺省值由注入层负责，缺键即非法（fail loud）。

import { TeamError } from "./errors.js";

export interface TeamLimits {
  maxMembers: number;
  maxTasks: number;
  maxMessageBytes: number;
  disposalTimeoutMs: number;
}

export const TEAM_LIMIT_KEYS = [
  "maxMembers",
  "maxTasks",
  "maxMessageBytes",
  "disposalTimeoutMs",
] as const satisfies readonly (keyof TeamLimits)[];

/** 校验输入（env-like：数值或可严格解析为整数的字符串）。任一键非正 safe integer → TEAM_INVALID_CONFIG。 */
export function validateTeamLimits(input: Record<string, unknown>): TeamLimits {
  const out = {} as TeamLimits;
  for (const key of TEAM_LIMIT_KEYS) {
    const raw = input[key];
    const n = coerceInteger(raw);
    if (n === undefined || !Number.isSafeInteger(n) || n < 1) {
      throw new TeamError("TEAM_INVALID_CONFIG", `${key} must be a positive safe integer`, {
        cause: { key, value: raw },
      });
    }
    out[key] = n;
  }
  return out;
}

/** 数值原样（整数检查交由调用方）；字符串须为严格十进制整数形式（env 注入形态）；其余不可解析。 */
function coerceInteger(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

// —— Lead 编排模式（D26；stage-6.5，2026-10-24）——
// userConfig.leadMode（宿主 userConfig schema 无 enum 字段，取值约束只能在运行时校验）。
// 校验策略 = 宽松回落（与 interrupt 同类，区别于 4 限额的 fail-loud）：非法值回落默认并由调用方
// warn；**不并入 config.ok** —— 一个拼写错误不得禁用整个团队工具面（daemon 的 config.ok=false
// 会拦截全部 tools/call）。

/** Lead 模式：orchestrator = Lead-only 编排段注入（默认，用户产品方向）；collaborator = DSH 复刻口径（无编排段）。 */
export type LeadMode = "orchestrator" | "collaborator";

export const DEFAULT_LEAD_MODE: LeadMode = "orchestrator";

/** 校验 leadMode 输入（env 形态 / JSON 字段均可）：合法值原样返回，其余（含 undefined/空串/拼写错）回落默认。 */
export function validateLeadMode(raw: unknown): LeadMode {
  return raw === "collaborator" ? "collaborator" : "orchestrator";
}
