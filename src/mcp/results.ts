// 工具结果整形（stage-3 T3.1 输出纪律）。
// 成功 = 单 text 块紧凑 JSON（JSON.stringify 无缩进无换行；F02 正则断言 ^\{.*\}$ 单行 /
// 数组输出同理 ^\[.*\]$）。失败 = isError:true + 单 text 块 {"error":{"code?","message"}}
// （TeamError code 透传供模型自恢复；F07）。fail-loud 警告行（D10）= 追加独立 text 块，
// 不改 JSON 结果本体。

import { isTeamError, type TeamErrorCode } from "../domain/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FAIL_LOUD_WARNING } from "./policy.js";
import type { ResolvedIdentity } from "./identity.js";

export type { CallToolResult };

/** 紧凑 JSON（无缩进；单 text 块）。 */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function successResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: compactJson(value) }] };
}

/**
 * 错误透传（F07 冻结格式）：{"error":{"code","message"}}；
 * TeamError → code+message；AggregateError → 首个 TeamError 的 code + 聚合消息；
 * 其他 → 仅 message（不贴假 code）。
 */
export function errorResult(err: unknown): CallToolResult {
  const body = normalizeError(err);
  return {
    isError: true,
    content: [{ type: "text", text: compactJson({ error: body }) }],
  };
}

export function normalizeError(err: unknown): { code?: TeamErrorCode; message: string } {
  if (isTeamError(err)) return { code: err.code, message: err.message };
  if (err instanceof AggregateError) {
    const first = err.errors.find(isTeamError);
    if (first !== undefined) {
      return { code: first.code, message: `${err.message}: ${first.message}` };
    }
    const firstPlain = err.errors[0];
    return {
      message:
        err.message +
        (firstPlain !== undefined ? `: ${firstPlain instanceof Error ? firstPlain.message : String(firstPlain)}` : ""),
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** fail-loud（D10）：hook 未注册本会话 → 结果尾部追加警告行（独立 text 块）。 */
export function withFailLoud(result: CallToolResult, identity: ResolvedIdentity): CallToolResult {
  if (identity.hookRegistered) return result;
  return { ...result, content: [...result.content, { type: "text", text: FAIL_LOUD_WARNING }] };
}
