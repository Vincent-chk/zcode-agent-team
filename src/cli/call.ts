// team-ctl call：经 socket 调协调者（无协调者 → 可读错误；供 U03 的 C5 退化检查与排障）。
import { callCoordinator } from "../coord/rpc.js";
import { COORDINATOR_UNAVAILABLE_MESSAGE } from "../coord/rpc.js";
import { TeamError } from "../domain/errors.js";

export interface CallOutcome {
  ok: boolean;
  /** 成功 = 方法结果 JSON；失败 = 单行错误摘要（无多行堆栈）。 */
  output: string;
  /** 结构化单行日志（关键路径审计：tool/action/teamDir/method/错误码）。 */
  audit: string;
}

export async function callTeam(teamDir: string, method: string, paramsJson: string | undefined): Promise<CallOutcome> {
  let params: unknown = {};
  if (paramsJson !== undefined && paramsJson.trim().length > 0) {
    try {
      params = JSON.parse(paramsJson);
    } catch (err) {
      return {
        ok: false,
        output: `call: params 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
        audit: JSON.stringify({ tool: "team-ctl", action: "call", teamDir, method, ok: false, reason: "bad-params" }),
      };
    }
  }
  try {
    const result = await callCoordinator(teamDir, "", method, params, { timeoutMs: 10_000 });
    return {
      ok: true,
      output: JSON.stringify(result, null, 2),
      audit: JSON.stringify({ tool: "team-ctl", action: "call", teamDir, method, ok: true }),
    };
  } catch (err) {
    const summary =
      err instanceof TeamError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error && err.message === COORDINATOR_UNAVAILABLE_MESSAGE
          ? COORDINATOR_UNAVAILABLE_MESSAGE
          : err instanceof Error
            ? err.message.split("\n")[0]
            : String(err);
    return {
      ok: false,
      output: `call ${method} 失败：${summary}`,
      audit: JSON.stringify({
        tool: "team-ctl",
        action: "call",
        teamDir,
        method,
        ok: false,
        code: err instanceof TeamError ? err.code : undefined,
      }),
    };
  }
}
