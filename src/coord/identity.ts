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
  /** 每次获锁唯一；旧 writer 缺省只能操作旧格式锁。 */
  token?: string;
}

/** 解析 writerId（"bootId:pid" / "bootId:pid:lockToken"）；不合法返回 undefined。 */
export function parseWriterId(writer: string): WriterIdentity | undefined {
  const parts = writer.split(":");
  if (parts.length === 3) {
    const [boot, rawPid, token] = parts;
    const pid = Number(rawPid);
    if (boot.length > 0 && token.length > 0 && Number.isInteger(pid)) return { bootId: boot, pid, token };
    return undefined;
  }
  if (parts.length !== 2) return undefined;
  const [boot, rawPid] = parts;
  const pid = Number(rawPid);
  if (boot.length === 0 || !Number.isInteger(pid)) return undefined;
  return { bootId: boot, pid };
}
