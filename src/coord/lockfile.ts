// 锁文件归属观察（journal 单写者纪律的支撑）：读取 lock 文件并判断是否属于给定 writer。
// 独立小模块，避免 journal ↔ lock 的循环依赖。

import fs from "node:fs";
import { parseWriterId } from "./identity.js";

export interface LockOwnership {
  ok: boolean;
  reason: string;
}

/** 判断 lockFile 当前持有者是否 = writer（"bootId:pid"）。 */
export function observeLockFileFor(lockFile: string, writer: string): LockOwnership {
  const identity = parseWriterId(writer);
  if (identity === undefined) {
    return { ok: false, reason: `writer id "${writer}" is malformed` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, "utf8");
  } catch (err) {
    return { ok: false, reason: `lock unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  let parsed: { pid?: unknown; bootId?: unknown };
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; bootId?: unknown };
  } catch {
    return { ok: false, reason: "lock file is not valid JSON" };
  }
  if (parsed.pid !== identity.pid || parsed.bootId !== identity.bootId) {
    return {
      ok: false,
      reason: `lock held by pid=${String(parsed.pid)} bootId=${String(parsed.bootId)}`,
    };
  }
  return { ok: true, reason: "owned" };
}
