// zcode 二进制定位（stage-4）：daemon env 无 zcode 路径，但桌面捆绑布局可推导——
//   ZCODE_RG_BINARY=/Applications/ZCode.app/Contents/Resources/tools/ripgrep/rg
//   → …/Resources/glm/zcode.cjs（Desktop 3.15.3 实测）。
// 链条：TEAM_ZCODE_BIN（显式覆盖/测试注入）→ ZCODE_RG_BINARY 推导 → Desktop 常驻路径 → which zcode。
// 找不到 → 抛可读错误（spawn 前显式失败，F03 供给失败路径的注入点）。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DESKTOP_ZCODE_CJS = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

export interface ZcodeBin {
  /** 完整命令（zcode.cjs 需要 node 解释；原生二进制直接执行）。 */
  command: string;
  /** command 之外的 argv 前缀（node + cjs 路径 / 空数组）。 */
  argvPrefix: string[];
  /** 来源（日志取证）。 */
  source: "env" | "rg-derive" | "desktop-default" | "which";
}

export function resolveZcodeBin(env: NodeJS.ProcessEnv = process.env): ZcodeBin {
  const explicit = env.TEAM_ZCODE_BIN;
  if (explicit && explicit.trim()) {
    return binFor(explicit.trim(), "env");
  }
  const rg = env.ZCODE_RG_BINARY;
  if (rg && rg.trim()) {
    const derived = path.join(path.dirname(path.dirname(path.dirname(rg))), "glm", "zcode.cjs");
    if (fs.existsSync(derived)) return binFor(derived, "rg-derive");
  }
  if (fs.existsSync(DESKTOP_ZCODE_CJS)) return binFor(DESKTOP_ZCODE_CJS, "desktop-default");
  try {
    const which = execFileSync("which", ["zcode"], { encoding: "utf8" }).trim();
    if (which.length > 0) return binFor(which, "which");
  } catch {
    /* which 不可用 → 落入显式错误 */
  }
  throw new Error(
    "cannot locate the zcode CLI binary: set TEAM_ZCODE_BIN (daemon env) or install ZCode Desktop",
  );
}

function binFor(p: string, source: ZcodeBin["source"]): ZcodeBin {
  if (/\.(cjs|mjs|js)$/.test(p)) {
    return { command: process.execPath, argvPrefix: [p], source };
  }
  return { command: p, argvPrefix: [], source };
}
