// Lead 套餐模型探针（〔issue #5 / D29〕2026-11-02；〔D30〕2026-11-02 加 modelHint/evidence）。
// 用途：hook 侧（SessionStart/UserPromptSubmit）在注入时判定「Lead 模型是否为官方订阅套餐
// （account:* / builtin:*）」——该形态下 teammate CLI 子进程拿不到订阅凭据，spawn_teammate
// 预检必然失败（daemon 侧判定 = resume-provider.ts resolveLeadInheritance 的官方套餐分支）。
// 判定后 hooks 注入 DEGRADED_SOLO_NOTE（单 agent 兜底：自己干全部工作，别试 spawn）。
//
// 判定口径（与 resume-provider.ts:1092-1101 三源取最新逐字同源；〔D29 登记〕判定逻辑双源——
// provider 侧带 throw/目录分类等完整语义，本探针只取「套餐前缀」快判，目录外等少见场景仍由
// spawn 报错兜底）：
//   三源（提交快照 / session_entry 选模条目 / main_turn 实际调用）reduce 取最新 →
//   providerId 以 account:/builtin: 开头 → blocked:true。
// 〔D30〕modelHint = 宿主 SessionStart 载荷的 model 字段（"providerId/modelId" 扁平串，仅
// SessionStart 有、UPS/Stop 无）：非空时**宿主权威直判**（evidence:"hint"）——startup 全新
// 会话 hook 早于会话行落库（实测 ~1.4s）三源必空，hint 补齐该路径；缺省/空串回落三源。
// 乐观默认（绝不误报、绝不阻断注入主流程）：三源全空或读库失败 → blocked:false + evidence:"none"
// ——撤回判定（D30 对账）必须要求 evidence:"db" 才生效，防止「没证据」被当成「第三方」。
//
// 时序口径（2026-11-02 实测，zcode.cjs executeTurn + 本机 db 抽样）：
//   startup：hook 先于会话行/选模条目落库 → 三源空，靠 hint；
//   首轮 UPS：宿主轮首 ensureSessionPersisted 已写会话行+选模条目（源2 必可见），
//   消息快照（源1）要等本轮回落后（+25ms~1.2s）；resume/派生：条目创建即复制。
import { TranscriptReader, defaultDbPath } from "./transcript.js";
import type { MemberModelSelection } from "./model-selection.js";

export interface LeadPlanModelProbe {
  /** true = Lead 最新已确认模型为官方套餐，队友不可孵化。 */
  blocked: boolean;
  /** blocked 时的 "providerId/modelId" 展示串。 */
  model?: string;
  /** 判定依据：hint=宿主 SessionStart 载荷；db=三源有记录；none=三源全空/读库失败（未判定）。 */
  evidence: "hint" | "db" | "none";
}

const PLAN_PREFIXES = ["account:", "builtin:"] as const;

function isPlanPrefix(providerId: string): boolean {
  return PLAN_PREFIXES.some((prefix) => providerId.startsWith(prefix));
}

export function probeLeadPlanModel(
  sessionId: string,
  dbPath?: string,
  modelHint?: string,
): LeadPlanModelProbe {
  // 〔D30〕hint 优先：宿主在 SessionStart 给出的当前选模快照（"providerId/modelId" 扁平串，
  // providerId 不含 "/"，前缀判定不受 modelId 影响）。
  const hint = typeof modelHint === "string" ? modelHint.trim() : "";
  if (hint.length > 0) {
    return isPlanPrefix(hint) ? { blocked: true, model: hint, evidence: "hint" } : { blocked: false, evidence: "hint" };
  }
  try {
    // defaultDbPath() 放进 try：连路径解析失败也不抛（探针永不打断 hook 主流程）。
    const reader = new TranscriptReader({ dbPath: dbPath ?? defaultDbPath() });
    try {
      const sources = [
        reader.latestSubmissionSelection(sessionId),
        reader.latestModelSelectionTimed(sessionId),
        reader.latestMainTurnUsage(sessionId),
      ].filter((source): source is NonNullable<typeof source> => source !== undefined);
      if (sources.length === 0) return { blocked: false, evidence: "none" };
      const latest: MemberModelSelection = sources.reduce((a, b) => (b.at > a.at ? b : a)).selection;
      const isOfficialPlan = isPlanPrefix(latest.providerId);
      return isOfficialPlan
        ? { blocked: true, model: `${latest.providerId}/${latest.modelId}`, evidence: "db" }
        : { blocked: false, evidence: "db" };
    } finally {
      reader.close();
    }
  } catch {
    return { blocked: false, evidence: "none" };
  }
}
