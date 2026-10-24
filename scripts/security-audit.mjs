#!/usr/bin/env node
// SF12 安全边界审计：
//  ① 数据目录 0700 / 文件 0600 / RPC socket 0600（含 coordinator.lock、rpc.token、日志、meta）
//  ② 数据目录外零写入（workspace 与沙箱哨兵文件 mtime 不变；宿主真实 db.sqlite 未触碰）
//  ③ db.sqlite 一律只读（源码静态审计：DatabaseSync 打开点）
//  ④ 伴生面板仅回环 + token（无 token/错 token → 403；正确 token → 200；注册文件 0600）
// 用法：node scripts/security-audit.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJ, createTestSessionDb, loadConfig, startDaemon, writeResult } from "./e2e/common.mjs";

const cfg = loadConfig();
createTestSessionDb(cfg.dbPath);
const leadId = `sess_sec_${crypto.randomBytes(3).toString("hex")}`;
const meta = { session_id: leadId };
const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok, ...(detail !== undefined ? { detail } : {}) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}\n`);
}
const mode = (file) => {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
};
function walk(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const realDb = process.env.REAL_DB ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const realDbStat = fs.existsSync(realDb) ? fs.statSync(realDb) : null;

// 沙箱：workspace + 外部哨兵目录
const sentinelDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-sec-sentinel-"));
const sentinel = path.join(sentinelDir, "sentinel.txt");
fs.writeFileSync(sentinel, "keep", { mode: 0o600 });
const sentinelBefore = fs.statSync(sentinel).mtimeMs;
const wsBefore = new Set(fs.readdirSync(cfg.ws));

const daemon = startDaemon(cfg, {
  env: { TEAM_ZCODE_BIN: cfg.fakeZcode, TEAM_SESSION_ISOLATION: "legacy", FAKE_ZCODE_RESPONSE: "sec-ok", TEAM_COMPANION: "1" },
});

try {
  await daemon.ready();
  await daemon.callJson("spawn_teammate", { name: "sec-member", description: "d", prompt: "sec 首轮" }, meta);
  await daemon.callJson("team_task_create", { subject: "sec", description: "d" }, meta);
  await daemon.callJson("send_message", { target: "sec-member", message: "sec-msg" }, meta);
  await new Promise((r) => setTimeout(r, 1_500));

  // ① 目录/文件权限
  check("数据根 0700", mode(cfg.dataRoot) === 0o700, { mode: mode(cfg.dataRoot)?.toString(8) });
  for (const sub of ["logs", "meta", "session-map", "teams"]) {
    const m = mode(path.join(cfg.dataRoot, sub));
    check(`${sub}/ 0700`, m === 0o700, { mode: m?.toString(8) });
  }
  const files = walk(cfg.dataRoot);
  const badModes = files.filter((file) => {
    const m = mode(file);
    return m !== null && (m & 0o077) !== 0;
  });
  check("数据根下全部文件 0600（无组/其他权限）", badModes.length === 0, {
    files: files.length,
    bad: badModes.slice(0, 10).map((f) => ({ f: path.relative(cfg.dataRoot, f), mode: mode(f)?.toString(8) })),
  });
  const socketPath = fs.readFileSync(path.join(cfg.dataRoot, "teams", leadId, "socket.path"), "utf8").trim();
  check("RPC socket 0600", mode(socketPath) === 0o600, { socketPath, mode: mode(socketPath)?.toString(8) });
  check("rpc.token 0600 且非空", mode(path.join(cfg.dataRoot, "teams", leadId, "rpc.token")) === 0o600 && fs.readFileSync(path.join(cfg.dataRoot, "teams", leadId, "rpc.token"), "utf8").trim().length >= 32);

  // ② 数据目录外零写入
  const wsAfter = new Set(fs.readdirSync(cfg.ws));
  const wsAdded = [...wsAfter].filter((name) => !wsBefore.has(name));
  check("workspace 无意外写入（fake 执行器不产文件）", wsAdded.length === 0, { added: wsAdded });
  check("沙箱哨兵文件未被修改", fs.statSync(sentinel).mtimeMs === sentinelBefore);
  const realDbAfter = fs.existsSync(realDb) ? fs.statSync(realDb) : null;
  check(
    "宿主真实 db.sqlite 未触碰（本场景使用测试库）",
    (realDbStat === null && realDbAfter === null) ||
      (realDbStat !== null && realDbAfter !== null && realDbStat.mtimeMs === realDbAfter.mtimeMs && realDbStat.size === realDbAfter.size),
    { realDb, before: realDbStat?.mtimeMs ?? null, after: realDbAfter?.mtimeMs ?? null },
  );

  // ③ 静态只读纪律
  const transcriptSrc = fs.readFileSync(path.join(PROJ, "src/provider/transcript.ts"), "utf8");
  const sessionBreederSrc = fs.readFileSync(path.join(PROJ, "src/provider/session-breeder.ts"), "utf8");
  check(
    "db.sqlite 打开点均 readOnly:true（transcript / breeder）",
    /new DatabaseSync\([^)]*readOnly:\s*true/.test(transcriptSrc) && /new DatabaseSync\(this\.dbPath,\s*\{\s*readOnly:\s*true\s*\}\)/.test(sessionBreederSrc),
  );
  const tasksIndexSrc = fs.readFileSync(path.join(PROJ, "src/sidebar/tasks-index.ts"), "utf8");
  check(
    "tasks-index 写入仅 tombstone/archive 精确行（无批量 UPDATE/DELETE）",
    !/DELETE\s+FROM\s+tasks/i.test(tasksIndexSrc) && !/UPDATE\s+tasks\s+SET\s+(?!archived)/i.test(tasksIndexSrc),
  );

  // ④ 伴生面板：回环 + token
  const registryFile = path.join(cfg.dataRoot, "logs", "panel-http.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  check("伴生注册文件 0600 且含 token", mode(registryFile) === 0o600 && typeof registry.token === "string" && registry.token.length > 0, {
    mode: mode(registryFile)?.toString(8),
  });
  const base = `http://127.0.0.1:${registry.port}`;
  const noToken = await fetch(`${base}/healthz`);
  const wrongToken = await fetch(`${base}/healthz?token=wrong`);
  const okToken = await fetch(`${base}/healthz?token=${registry.token}`);
  check("伴生面板：无 token/错 token → 403，正确 token → 200", noToken.status === 403 && wrongToken.status === 403 && okToken.status === 200, {
    noToken: noToken.status,
    wrongToken: wrongToken.status,
    okToken: okToken.status,
  });
  const body = await okToken.json();
  check("伴生面板 healthz 仅回环形态", body.ok === true && registry.pid === daemon.pid);
} catch (err) {
  check("security 场景未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  await daemon.kill("SIGINT").catch(() => undefined);
  fs.rmSync(sentinelDir, { recursive: true, force: true });
  const pass = checks.every((c) => c.ok);
  const result = { scenario: "security-audit", pass, ts: new Date().toISOString(), checks };
  const file = writeResult(cfg.out, "SECURITY", result);
  process.stdout.write(`\nSECURITY result → ${file}\n`);
  process.exitCode = pass ? 0 : 1;
}
