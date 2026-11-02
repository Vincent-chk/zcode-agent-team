#!/usr/bin/env node
// 构建产物语法门（〔D31〕2026-11-02）：对 runtime 下全部 node 产物跑 `node --check`。
// 背景：exFAT 卷上 esbuild 写大 bundle 偶发字节撕裂（team-daemon.mjs ~1MB；实测 2026-11-02
// daemon 起不来 / wire 测试 10s 超时，重试即好）。此前只靠人工「build 后必跑 node --check」。
// 用法：CLI `node scripts/check-bundles.mjs`（坏 → 非零退出 + 文件名）；build.mjs/release.mjs
// 复用导出的 checkNodeSyntax（release 侧在 verifyPackageLayout 内校验 staged/解包树）。
// 注：ui/*.js 为浏览器 iife（无 import/export），作为普通脚本解析同样有效，撕裂同样可检出。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 标准校验集（相对仓库根）。 */
export const BUNDLE_FILES = [
  "runtime/team-daemon.mjs",
  "runtime/team-hooks.mjs",
  "runtime/team-ctl.mjs",
  "runtime/detach-helper.mjs",
  "runtime/app-server-bridge.mjs",
  "runtime/ui/panel.js",
  "runtime/ui/companion.js",
];

/**
 * 逐文件校验：空文件（0 字节是合法空程序，`node --check` 拦不住）视为坏；
 * 其余 `node --check`。返回第一个失败文件（传入原样路径），全过返回 null。不抛错。
 */
export function checkNodeSyntax(files) {
  for (const file of files) {
    try {
      if (fs.statSync(file).size === 0) return file;
    } catch {
      return file;
    }
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status !== 0) return file;
  }
  return null;
}

/** CLI 入口判定：symlink 调用时 argv[1] 可能是链接路径，与 import.meta.url 的 realpath 不同。 */
function isCliEntry() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const targets = BUNDLE_FILES.map((rel) => path.join(proj, rel));
  const missing = targets.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error(`[check-bundles] FAIL: missing build outputs: ${missing.join(", ")}（先 npm run build）`);
    process.exit(1);
  }
  const bad = checkNodeSyntax(targets);
  if (bad !== null) {
    console.error(`[check-bundles] FAIL: syntax/empty check on ${bad}（疑似落盘撕裂 → 重跑 npm run build）`);
    process.exit(1);
  }
  console.log(`[check-bundles] OK: ${targets.length} 个产物语法全过（含非空校验）`);
}
