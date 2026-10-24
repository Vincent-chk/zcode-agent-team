// 追加前不变量（02 规格 §3.2 不变量伴随 / 〔核查增补 C8〕；F07）。
// 「先校验后追加」：候选事件必须先在「已提交前缀 + 候选」上重放通过，才允许进入已提交序列
// （journal 轮在 append 前调用本函数；非法事件绝不落盘）。
// 失败消息逐字：`session event <seq> violates the Agent Teams stream: <failure>`。

import { applyProjectionEvent, emptyTeamState } from "./projection.js";

/**
 * 校验候选事件可否追加到已提交前缀之后（纯函数，零 IO；journal 在 append 前调用，通过才允许写）。
 * seq = 行号（committed.length + 1，1-based）。
 * 已提交前缀自身已损坏（按构造不可能——每条都经本校验；外部截断/篡改除外）时，
 * 报告前缀中首个违规行的 seq。
 */
export function assertAppendable(
  teamId: string,
  committed: readonly unknown[],
  candidate: unknown,
): void {
  let state = emptyTeamState(teamId);
  for (let i = 0; i < committed.length; i++) {
    const next = applyProjectionEvent(state, committed[i]);
    if (next.failure !== undefined) {
      throw new Error(
        `session event ${i + 1} violates the Agent Teams stream: ${next.failure}`,
      );
    }
    state = next;
  }
  const withCandidate = applyProjectionEvent(state, candidate);
  if (withCandidate.failure !== undefined) {
    throw new Error(
      `session event ${committed.length + 1} violates the Agent Teams stream: ${withCandidate.failure}`,
    );
  }
}
