// Lead 套餐模型探针（〔issue #5 / D29〕2026-11-02）。
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
// 乐观默认（绝不误报、绝不阻断注入主流程）：三源全空（新会话首条消息前 db 无记录）或
// 读库失败（库锁/缺失/损坏）→ blocked:false。
import { TranscriptReader, defaultDbPath } from "./transcript.js";
import type { MemberModelSelection } from "./model-selection.js";

export interface LeadPlanModelProbe {
  /** true = Lead 最新已确认模型为官方套餐，队友不可孵化。 */
  blocked: boolean;
  /** blocked 时的 "providerId/modelId" 展示串。 */
  model?: string;
}

export function probeLeadPlanModel(sessionId: string, dbPath: string = defaultDbPath()): LeadPlanModelProbe {
  try {
    const reader = new TranscriptReader({ dbPath });
    try {
      const sources = [
        reader.latestSubmissionSelection(sessionId),
        reader.latestModelSelectionTimed(sessionId),
        reader.latestMainTurnUsage(sessionId),
      ].filter((source): source is NonNullable<typeof source> => source !== undefined);
      if (sources.length === 0) return { blocked: false };
      const latest: MemberModelSelection = sources.reduce((a, b) => (b.at > a.at ? b : a)).selection;
      const isOfficialPlan =
        latest.providerId.startsWith("account:") || latest.providerId.startsWith("builtin:");
      return isOfficialPlan
        ? { blocked: true, model: `${latest.providerId}/${latest.modelId}` }
        : { blocked: false };
    } finally {
      reader.close();
    }
  } catch {
    return { blocked: false };
  }
}
