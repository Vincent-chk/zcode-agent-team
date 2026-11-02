// S9 订阅降级自干剧本（〔issue #5 / D29·D30〕；出厂 hook 二进制确定性矩阵，零模型成本）：
//   直跑 runtime/team-hooks.mjs（与宿主同一二进制/同一 stdin 协议）+ 三源夹具库（createProbeDb），
//   覆盖：startup hint 注入+锚 / 同会话去重 / 第三方 hint 不注 / 首轮 UPS「仅选模条目无消息」
//   形态注入（= 宿主 ensureSessionPersisted 先于 UPS 的真实时序）/ 提交快照第三方不注 / off 整体
//   无输出 / 空库乐观不注 / 锚在 UPS 零输出 / hint 误报 UPS 撤回恰一次 / resume 载荷切第三方撤回。
// 说明：本剧本不依赖模型；真人套餐会话的用户旅程由 U-D30（dev 环境桌面实测）覆盖。
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Checks,
  PROJ,
  loadConfig,
  teamDirFor,
  writeResult,
  createProbeDb,
  insertProbeSubmission,
  insertProbeSelection,
  insertProbeUsage,
} from "./common.mjs";

const cfg = loadConfig();
const checks = new Checks("S9");
const PLAN = "account:bigmodel-individual-coding-plan";
const HINT_PLAN = `${PLAN}/GLM-5.3`;
const THIRD = "98331807-541d-4961-b55f-f2e4a0c4f870"; // 本机第三方 provider 形态（UUID）
const HINT_THIRD = `${THIRD}/deepseek-flash`;
const NOTE_MARK = "Teammates unavailable in this session";
const RETRACT_MARK = "Update: teammates are available in this session";

// 〔安全〕本剧本会**写**会话库（夹具三源），绝不能落在宿主库：
// 忽略 TEAM_DB_PATH（run.mjs 透传 process.env，可能指向 ~/.zcode/cli/db/db.sqlite）与 --db，
// 强制在 mkdtemp 内新建独立库；数据根同理（hook 只写 TEAM_PLUGIN_DATA 下）。
const ownRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s9-"));
const dbPath = path.join(ownRoot, "probe.sqlite");
const dataRoot = path.join(ownRoot, "data");
const hostDb = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
createProbeDb(dbPath);
checks.check(
  "S9 数据隔离：夹具库/数据根均在临时目录，且不指向宿主库",
  dbPath.startsWith(ownRoot) && !path.resolve(dbPath).startsWith(path.resolve(path.dirname(hostDb))) && fs.existsSync(dbPath),
  { dbPath, dataRoot },
);

const sid = (tag) => `${cfg.teamPrefix}-s9-${tag}-${crypto.randomUUID().slice(0, 8)}`;
const evidence = { db: dbPath, dataRoot, sessions: {} };

/** 继承环境全量净化（TEAM_* 一律清掉再按需显式注入；本进程可能身处 Lead/teammate 会话）。 */
function sanitizedEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TEAM_")) delete env[key];
  Object.assign(env, overrides);
  return env;
}

function runHook(leadId, hookEvent, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = sanitizedEnv({
      TEAM_PLUGIN_DATA: dataRoot,
      TEAM_PROJECT_DIR: cfg.ws,
      TEAM_DB_PATH: dbPath,
      ZCODE_SESSION_ID: leadId,
      TEAM_LEAD_MODE: "auto",
      ...extraEnv,
    });
    const child = execFile(
      process.execPath,
      [path.join(PROJ, "runtime", "team-hooks.mjs")],
      { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = stdout.trim() ? JSON.parse(stdout) : {};
        } catch {
          parsed = { parseError: stdout.slice(0, 500) };
        }
        resolve({ ok: !err && (err?.code ?? 0) === 0, parsed, stdout: String(stdout), stderr: String(stderr), code: err?.code ?? 0 });
      },
    );
    child.stdin.end(JSON.stringify({ hook_event_name: hookEvent, session_id: leadId, cwd: cfg.ws, ...payload }));
  });
}

/** 零输出的检查也必须证明进程正常退出（崩溃 = 空 stdout 不能算「按预期无输出」）。 */
const silent = (r) => r.ok && r.stdout.trim() === "";

const ctxOf = (r) => String(r.parsed?.hookSpecificOutput?.additionalContext ?? "");
function leadState(leadId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(teamDirFor({ dataRoot }, leadId), "lead", "state.json"), "utf8"));
  } catch {
    return undefined;
  }
}
function remember(tag, leadId, extra) {
  evidence.sessions[tag] = { leadId, state: leadState(leadId), ...extra };
}

try {
  // ① startup + 宿主 model 载荷（套餐）+ 三源空库 → 注入 + 锚（via=hint）——D30 缺口闭环主证
  const hintStart = sid("hintstart");
  const r1 = await runHook(hintStart, "SessionStart", { source: "startup", model: HINT_PLAN });
  const s1 = leadState(hintStart);
  checks.check(
    "①startup+model 提示（套餐）+空库 → 注入 DEGRADED_SOLO_NOTE 并写锚（via=hint）",
    ctxOf(r1).includes(NOTE_MARK) && ctxOf(r1).includes("Agent Teams") && typeof s1?.soloNotifiedAt === "string" && s1?.soloNotifiedVia === "hint",
    { ctxHead: ctxOf(r1).slice(0, 120), state: s1 },
  );

  // ② 同会话 SessionStart(resume) 重放 → 不重注、不撤回
  const r2 = await runHook(hintStart, "SessionStart", { source: "resume", model: HINT_PLAN });
  checks.check(
    "②同会话重放 → 不重注（锚去重）且不撤回",
    r2.ok && !ctxOf(r2).includes(NOTE_MARK) && !ctxOf(r2).includes(RETRACT_MARK) && ctxOf(r2).includes("Agent Teams"),
    { ctxHead: ctxOf(r2).slice(0, 120) },
  );
  remember("hintStart", hintStart);

  // ③ 第三方 hint → 不注（无误报）
  const hintThird = sid("hintthird");
  const r3 = await runHook(hintThird, "SessionStart", { source: "startup", model: HINT_THIRD });
  checks.check("③第三方 model 提示 → 不注入、无锚", !ctxOf(r3).includes(NOTE_MARK) && ctxOf(r3).includes("Agent Teams") && leadState(hintThird)?.soloNotifiedAt === undefined, {
    state: leadState(hintThird),
  });
  remember("hintThird", hintThird);

  // ④ 首轮 UPS 真实形态：仅选模条目（源2）、尚无消息（源1 晚于 UPS 落库）→ 注入（via=db）
  const upsEntry = sid("upsentry");
  insertProbeSelection(dbPath, { sessionId: upsEntry, providerId: PLAN, modelId: "GLM-5.3", timeCreated: 1_000 });
  const r4 = await runHook(upsEntry, "UserPromptSubmit", { prompt: "首轮" });
  const s4 = leadState(upsEntry);
  checks.check(
    "④UPS 仅选模条目无消息（=真实首轮时序）→ 注入 + 锚（via=db）",
    r4.parsed?.hookSpecificOutput?.hookEventName === "UserPromptSubmit" && ctxOf(r4).includes(NOTE_MARK) && typeof s4?.soloNotifiedAt === "string" && s4?.soloNotifiedVia === "db",
    { ctxHead: ctxOf(r4).slice(0, 120), state: s4 },
  );
  remember("upsEntry", upsEntry);

  // ⑤ 提交快照第三方 → 不注、零输出（无 pending）
  const upsThird = sid("upsthird");
  insertProbeSubmission(dbPath, { sessionId: upsThird, providerId: THIRD, modelId: "deepseek-flash", timeCreated: 1_000 });
  const r5 = await runHook(upsThird, "UserPromptSubmit", { prompt: "首轮" });
  checks.check("⑤提交快照第三方 → UPS 零输出、无锚", silent(r5) && leadState(upsThird)?.soloNotifiedAt === undefined, { code: r5.code, stdout: r5.stdout.slice(0, 120) });
  remember("upsThird", upsThird);

  // ⑤b 源1 正例：提交快照套餐（无选模条目）→ 必须经 db 注入（证明源 1 读取链路真实可用）
  const upsSnap = sid("upssnap");
  insertProbeSubmission(dbPath, { sessionId: upsSnap, providerId: PLAN, modelId: "GLM-5.3", timeCreated: 3_000 });
  const r5b = await runHook(upsSnap, "UserPromptSubmit", { prompt: "首轮" });
  checks.check(
    "⑤b 仅有提交快照（源1）·套餐 → 注入 + 锚（via=db）",
    r5b.ok && ctxOf(r5b).includes(NOTE_MARK) && leadState(upsSnap)?.soloNotifiedVia === "db",
    { ctxHead: ctxOf(r5b).slice(0, 100), state: leadState(upsSnap) },
  );
  remember("upsSnap", upsSnap);

  // ⑤c 源3 正例：仅 main_turn 实际调用（源3）·套餐 → 同样注入（三源任一可判）
  const upsUsage = sid("upsusage");
  insertProbeUsage(dbPath, { sessionId: upsUsage, providerId: PLAN, modelId: "GLM-5.4", startedAt: 4_000 });
  const r5c = await runHook(upsUsage, "UserPromptSubmit", { prompt: "首轮" });
  checks.check("⑤c 仅有 main_turn 调用（源3）·套餐 → 注入 + 锚", r5c.ok && ctxOf(r5c).includes(NOTE_MARK), {
    ctxHead: ctxOf(r5c).slice(0, 100),
  });
  remember("upsUsage", upsUsage);

  // ⑤d 源3 反向：仅 main_turn 第三方 → 不注（源3 过滤口径同样生效）
  const upsUsageThird = sid("upsusagethird");
  insertProbeUsage(dbPath, { sessionId: upsUsageThird, providerId: THIRD, modelId: "deepseek-flash", startedAt: 5_000 });
  const r5d = await runHook(upsUsageThird, "UserPromptSubmit", { prompt: "首轮" });
  checks.check("⑤d 仅有 main_turn 调用·第三方 → 零输出、无锚", silent(r5d) && leadState(upsUsageThird)?.soloNotifiedAt === undefined, {
    code: r5d.code,
  });

  // ⑥ off 档（套餐 hint）→ 整体无输出
  const offLead = sid("off");
  const r6 = await runHook(offLead, "SessionStart", { source: "startup", model: HINT_PLAN }, { TEAM_LEAD_MODE: "off" });
  checks.check("⑥off 档 → SessionStart 整体无输出（降级行同停）", silent(r6), { code: r6.code, stdout: r6.stdout.slice(0, 120) });

  // ⑦ 空库 + 无 hint（老宿主 startup 形态）→ 乐观不注，但策略正文照常注入
  const nobody = sid("nobody");
  const r7 = await runHook(nobody, "SessionStart", { source: "startup" });
  checks.check("⑦空库无 hint → 乐观不注（策略正文仍注入）", !ctxOf(r7).includes(NOTE_MARK) && ctxOf(r7).includes("Agent Teams") && leadState(nobody)?.soloNotifiedAt === undefined, {
    ctxHead: ctxOf(r7).slice(0, 120),
  });

  // ⑧ 锚在 + 三源仍空 → UPS 零输出（既不重注也不误撤回：evidence=none）
  const r8 = await runHook(hintStart, "UserPromptSubmit", { prompt: "再来" });
  checks.check("⑧锚在+三源空 → UPS 零输出（不重注/不误撤回）", silent(r8) && leadState(hintStart)?.soloNotifiedAt !== undefined && leadState(hintStart)?.soloRetractedAt === undefined, {
    code: r8.code,
    stdout: r8.stdout.slice(0, 120),
  });

  // ⑨ hint 误报：startup 套餐 → 用户首条消息前切第三方（源2 变第三方）→ UPS 撤回恰一次
  const retract = sid("retract");
  await runHook(retract, "SessionStart", { source: "startup", model: HINT_PLAN });
  insertProbeSelection(dbPath, { sessionId: retract, providerId: THIRD, modelId: "deepseek-flash", timeCreated: 2_000 });
  const r9a = await runHook(retract, "UserPromptSubmit", { prompt: "首轮" });
  const s9a = leadState(retract);
  const r9b = await runHook(retract, "UserPromptSubmit", { prompt: "次轮" });
  checks.check(
    "⑨hint 误报 → UPS 对账撤回（SOLO_RETRACT_NOTE）恰一次，通知锚保留",
    ctxOf(r9a).includes(RETRACT_MARK) && !ctxOf(r9a).includes(NOTE_MARK) && typeof s9a?.soloRetractedAt === "string" && typeof s9a?.soloNotifiedAt === "string" && silent(r9b),
    { ctxHead: ctxOf(r9a).slice(0, 120), state: s9a, second: r9b.stdout.slice(0, 80) },
  );
  remember("retract", retract);

  // ⑩ resume 载荷已切第三方 → SessionStart 即撤回
  const ssRetract = sid("ssretract");
  await runHook(ssRetract, "SessionStart", { source: "startup", model: HINT_PLAN });
  const r10 = await runHook(ssRetract, "SessionStart", { source: "resume", model: HINT_THIRD });
  checks.check("⑩resume 载荷切第三方 → SessionStart 撤回", ctxOf(r10).includes(RETRACT_MARK) && typeof leadState(ssRetract)?.soloRetractedAt === "string", {
    ctxHead: ctxOf(r10).slice(0, 120),
    state: leadState(ssRetract),
  });
  remember("ssRetract", ssRetract);
} catch (err) {
  checks.check("S9 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ evidence, env: { dataRoot, db: dbPath, ws: cfg.ws, tempRoot: ownRoot } });
  const file = writeResult(cfg.out, "S9", result);
  process.stdout.write(`S9 result → ${file}\n`);
  // 临时数据根/夹具库自助清理（evidence 已落盘，无需保留）。
  try {
    fs.rmSync(ownRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 清理失败不影响结果 */
  }
  if (!result.pass) process.exitCode = 1;
}
