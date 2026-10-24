// 进程身份（writerId / bootId）：事件行 writer 字段与审计痕迹的来源。
// bootId = 进程生命周期内稳定的随机 id（randomUUID）；writerId = "<bootId>:<pid>"。

import { randomUUID } from "node:crypto";

let cachedBootId: string | undefined;

export function bootId(): string {
  cachedBootId ??= randomUUID();
  return cachedBootId;
}

export function writerId(): string {
  return `${bootId()}:${process.pid}`;
}

export interface WriterIdentity {
  bootId: string;
  pid: number;
}

/** 解析 writerId（"bootId:pid"）；不合法返回 undefined（审计容错）。 */
export function parseWriterId(writer: string): WriterIdentity | undefined {
  const sep = writer.lastIndexOf(":");
  if (sep <= 0) return undefined;
  const pid = Number(writer.slice(sep + 1));
  const id = writer.slice(0, sep);
  if (!Number.isInteger(pid) || id.length === 0) return undefined;
  return { bootId: id, pid };
}
