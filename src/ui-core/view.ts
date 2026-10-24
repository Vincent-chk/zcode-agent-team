// 视图帧类型（接口草案 §5「帧内容」冻结形状 + stage-5 增补，登记于开发记录）：
//  - members 行 = 02 §9.4 MEMBER_VIEW ⊕ { id }（面板下钻 detail 需要域侧成员 id；
//    增补字段不删除契约字段，lead 伪行 id = teamId）；
//  - tasks 行 = 02 §9.4 TASK_VIEW 原样；
//  - team = { teamId, status:"active"|"failure", failure?, seq } | null（尚无已知团队 →
//    null，面板呈现 §10.4 加载/不可用通知条）；
//  - meta.sessionId = 构帧时面板调用方的会话 id（当前会话高亮/禁用行判定，§10.5）。
// mailbox-only 变化不改变帧内容（不发帧口径，F02）：帧不含任何 mailbox 字段。

import type { MemberRow } from "../domain/roster.js";
import type { TeamTaskView } from "../domain/task-view.js";

export const VIEW_STATE_VERSION = 4;

export interface ViewFrameMember extends MemberRow {
  /** 域侧成员 id（detail 下钻 target；lead 行 = teamId）。 */
  id: string;
  /**
   * 成员会话 id（lead = teamId；teammate = origin.json 回填，未落定则缺省）。
   * 面板据此判「当前会话」高亮/禁用（§10.5）与「复制会话 id」（T5.7）；detail 下钻由
   * daemon 侧按成员 id 重新解析会话 id（面板不传会话 id 作为查询键）。
   */
  sessionId?: string;
}

export interface ViewFrame {
  type: "view";
  stateVersion: 4;
  team: {
    teamId: string;
    status: "active" | "failure";
    /** 投影 failure 终态文本（§10.4 第三型通知条数据源）。 */
    failure?: string;
    /** 事件日志 seq（重放/提交游标；诊断与 meta.revision 同源）。 */
    seq: number;
  } | null;
  members: ViewFrameMember[];
  tasks: TeamTaskView[];
  meta: {
    generatedAt: string;
    /** = team.seq（无团队时 0）。 */
    revision: number;
    /** 构帧请求方会话 id（team_panel_call _meta.session_id；无则缺省）。 */
    sessionId?: string;
  };
}

/** 空帧（daemon 尚无已知团队；面板显示加载/不可用通知）。 */
export function emptyViewFrame(generatedAt: string, sessionId?: string): ViewFrame {
  return {
    type: "view",
    stateVersion: VIEW_STATE_VERSION,
    team: null,
    members: [],
    tasks: [],
    meta: { generatedAt, revision: 0, ...(sessionId !== undefined ? { sessionId } : {}) },
  };
}
