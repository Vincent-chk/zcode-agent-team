// 文本与 write scope 校验纯函数（02 规格 §7.2/§7.5；F22 前置）。

import { TeamError } from "./errors.js";

/**
 * requiredText：trim 后非空且长度 ≤ maxLen（02 §7.2 subject/description、§5.3 成员 description 共用）。
 * 返回 trim 后文本；违反 → TEAM_INVALID_ARGUMENT，消息逐字
 * `<field> must be non-empty` / `<field> exceeds <n> characters`。
 */
export function requiredText(field: string, value: unknown, maxLen: number): string {
  if (typeof value !== "string") {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${field} must be non-empty`, { cause: { field } });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${field} must be non-empty`, { cause: { field } });
  }
  if (trimmed.length > maxLen) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${field} exceeds ${maxLen} characters`, {
      cause: { field, length: trimmed.length },
    });
  }
  return trimmed;
}

/**
 * writeScope 归一（02 §7.5 逐字口径）：`\`→`/`；去开头 `./`（循环）；去结尾 `/`（循环）；
 * 拒绝：空、以 `/` 开头、盘符前缀（/^[a-z]:/i）、任一段为空/`.`/`..`
 * → TEAM_INVALID_WRITE_SCOPE，消息 `invalid workspace-relative write scope "<json>"`（<json> = 输入的 JSON 编码）。
 */
export function writeScope(scope: unknown): string {
  if (typeof scope !== "string") {
    throw invalidWriteScope(scope);
  }
  let s = scope.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.length === 0) throw invalidWriteScope(scope);
  if (s.startsWith("/")) throw invalidWriteScope(scope);
  if (/^[a-z]:/i.test(s)) throw invalidWriteScope(scope);
  for (const segment of s.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") throw invalidWriteScope(scope);
  }
  return s;
}

/** writeScopes 归一 + 去重（保序）。 */
export function writeScopes(list: unknown): string[] {
  if (!Array.isArray(list)) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", "write_scopes must be an array");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of list) {
    const normalized = writeScope(scope);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function invalidWriteScope(scope: unknown): TeamError {
  return new TeamError(
    "TEAM_INVALID_WRITE_SCOPE",
    `invalid workspace-relative write scope ${JSON.stringify(scope)}`,
    { cause: { scope } },
  );
}
