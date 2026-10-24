#!/usr/bin/env node
// SF08 文本审计（0.2.1-alpha.5 基准）：策略全文/注入形态、身份两分支、框架头（无 id）、
// noProgress、27 错误码模板、UI 词典 25 键（zh/en 键集一致、无 status.deleted）、
// 默认无探针 / TEAM_POLICY_PROBE=1 才出现。
// 做法：esbuild 现场把 src 的文本常量打包成临时 ESM 再断言（与运行时代码同源，不复制文本）。
// 用法：node scripts/text-audit.mjs [--json]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(fs.realpathSync(os.tmpdir()), `at-text-audit-${crypto.randomBytes(4).toString("hex")}.mjs`);

const entry = `
export {
  teamPolicy, IDENTITY_LEAD_TEXT, identityTeammateText, buildSessionStartContext,
  POLICY_PROBE_MARKER, POLICY_TEXT, NO_PROGRESS_MESSAGE, NO_PROGRESS_REASON,
  D7_ORIGINAL_SENTENCE, D7_REPLACEMENT_SENTENCE, HOOK_POLICY_PREFIX, FAIL_LOUD_WARNING,
  ORCHESTRATOR_SECTION_TEXT,
} from ${JSON.stringify(path.join(proj, "src/mcp/policy.ts"))};
export { TEAM_ERROR_CODES, TEAM_ERROR_CATALOG } from ${JSON.stringify(path.join(proj, "src/domain/errors.ts"))};
export { DICT, DICT_KEYS } from ${JSON.stringify(path.join(proj, "src/ui-core/dict.ts"))};
export { frameMessage } from ${JSON.stringify(path.join(proj, "src/domain/mailbox.ts"))};
`;

const failures = [];
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}\n`);
}

try {
  await build({
    stdin: { contents: entry, resolveDir: proj, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: tmp,
    logLevel: "silent",
  });
  const m = await import(pathToFileURL(tmp).href);

  // ① 策略全文（0.2.1 换版）
  const policyOn = m.teamPolicy(true);
  const policyOff = m.teamPolicy(false);
  check(
    "策略首段 = D5 换版（无门控从句）",
    policyOn.split("\n")[0] === "Agent Teams is available in this session",
    { firstLine: policyOn.split("\n")[0] },
  );
  check(
    "策略四段（空行分隔）",
    policyOn.split("\n\n").length === 4,
    { paragraphs: policyOn.split("\n\n").length },
  );
  check(
    "D7 替换句在场、原句不在",
    policyOn.includes(m.D7_REPLACEMENT_SENTENCE) && !policyOn.includes(m.D7_ORIGINAL_SENTENCE),
    { replacement: m.D7_REPLACEMENT_SENTENCE.slice(0, 60) },
  );
  check(
    "interrupt 插值：true 含 interrupt_agent、false 不含",
    policyOn.includes("send_message and interrupt_agent") && !policyOff.includes("interrupt_agent"),
    { offHead: policyOff.split("\n\n")[3].slice(0, 80) },
  );
  check(
    "send 语义句（0.2.1：不承诺已处理）",
    policyOn.includes("A successful send does not mean the recipient has processed it."),
  );
  check(
    "旧句已删（do not resend）",
    !policyOn.includes("do not resend"),
  );

  // ② 身份两分支（逐字）
  check(
    "Lead 身份分支逐字",
    m.IDENTITY_LEAD_TEXT ===
      `You are the Team Lead named "lead".\n` +
        `Use list_agents({}) to find your teammates and their names.\n` +
        `To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`,
    { head: m.IDENTITY_LEAD_TEXT.slice(0, 60) },
  );
  const mateText = m.identityTeammateText("alpha");
  check(
    "teammate 身份分支逐字（name 替换）",
    mateText.startsWith(`You are teammate "alpha".\n`) && mateText.includes(`To message your Team Lead, use send_message({ target: "lead", message: "..." }).`),
    { head: mateText.slice(0, 60) },
  );
  check("身份前缀不注入任务原文（D2：send 工具描述不含身份句）", !policyOn.includes(`You are teammate "`), {});

  // ③ 注入形态与探针
  const ctxDefault = m.buildSessionStartContext(m.IDENTITY_LEAD_TEXT, true);
  check(
    "SessionStart 注入 = [agent-team] 前缀 + 策略 + 身份；默认无探针",
    ctxDefault.startsWith(`${m.HOOK_POLICY_PREFIX} Agent Teams is available`) &&
      ctxDefault.includes(m.IDENTITY_LEAD_TEXT) &&
      !ctxDefault.includes(m.POLICY_PROBE_MARKER),
    { marker: m.POLICY_PROBE_MARKER },
  );
  process.env.TEAM_POLICY_PROBE = "1";
  const ctxProbe = m.buildSessionStartContext(m.IDENTITY_LEAD_TEXT, true);
  delete process.env.TEAM_POLICY_PROBE;
  check("TEAM_POLICY_PROBE=1 才注入探针标记", ctxProbe.includes(m.POLICY_PROBE_MARKER), {
    marker: m.POLICY_PROBE_MARKER,
  });
  check("探针标记不属于策略正文", !policyOn.includes(m.POLICY_PROBE_MARKER));

  // ④ 框架头（无 id）
  const framed = m.frameMessage({
    id: "team-message-should-not-appear",
    senderId: "s1",
    senderName: "alpha",
    targetId: "lead",
    content: [{ type: "text", text: "hello" }],
  });
  const framedJson = JSON.stringify(framed);
  check(
    "框架头 = `Team message from alpha:` 且不含 messageId",
    framed[0].text === "Team message from alpha:" && !framedJson.includes("team-message-should-not-appear"),
    { header: framed[0].text },
  );

  // ⑤ noProgress
  const EXPECTED_NO_PROGRESS =
    "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.";
  check(
    "noProgress 常量逐字（02 §8）",
    m.NO_PROGRESS_REASON === "no-active-peer" && m.NO_PROGRESS_MESSAGE === EXPECTED_NO_PROGRESS,
    { reason: m.NO_PROGRESS_REASON },
  );

  // ⑥ 27 错误码 + 目录
  const codes = m.TEAM_ERROR_CODES;
  const catalog = m.TEAM_ERROR_CATALOG;
  check("错误码恰 27 个", codes.length === 27, { count: codes.length });
  check("错误码无重复", new Set(codes).size === codes.length);
  check(
    "目录键集 = 错误码集合，每条至少一个非空消息模板",
    Object.keys(catalog).length === codes.length &&
      codes.every(
        (code) =>
          Array.isArray(catalog[code]?.messages) &&
          catalog[code].messages.length > 0 &&
          catalog[code].messages.every((template) => typeof template === "string" && template.length > 0),
      ),
    { catalogKeys: Object.keys(catalog).length },
  );
  check("已删 TEAM_MAILBOX_FULL（0.2.1 28→27）", !codes.includes("TEAM_MAILBOX_FULL"));

  // ⑦ UI 词典：25 键、zh/en 一致、无 status.deleted
  const keys = m.DICT_KEYS;
  check("UI 词典恰 25 键", keys.length === 25, { count: keys.length });
  check(
    "zh/en 键集一致且值非空",
    keys.every((key) => typeof m.DICT.zh[key] === "string" && typeof m.DICT.en[key] === "string" && m.DICT.zh[key].length > 0 && m.DICT.en[key].length > 0),
    { zh: Object.keys(m.DICT.zh).length, en: Object.keys(m.DICT.en).length },
  );
  check("词典无 status.deleted 键", !keys.includes("status.deleted") && !("status.deleted" in m.DICT.zh));

  // ⑧ fail-loud 警告行（D10）
  check(
    "fail-loud 警告行存在且指向策略注入",
    typeof m.FAIL_LOUD_WARNING === "string" && m.FAIL_LOUD_WARNING.includes("策略注入"),
  );

  // ⑨ 〔stage-6.5 D26，2026-10-24〕Lead 编排附加段：orchestrator 注入含段且禁词；collaborator/两参缺省不注入
  const ctxOrch = m.buildSessionStartContext(m.IDENTITY_LEAD_TEXT, true, "orchestrator");
  const ctxCollab = m.buildSessionStartContext(m.IDENTITY_LEAD_TEXT, true, "collaborator");
  check(
    "D26 编排段：orchestrator 含段、禁 interrupt_agent；collaborator/缺省不含段",
    ctxOrch.includes(m.ORCHESTRATOR_SECTION_TEXT) &&
      !m.ORCHESTRATOR_SECTION_TEXT.includes("interrupt_agent") &&
      !m.ORCHESTRATOR_SECTION_TEXT.includes("do not resend") &&
      !ctxCollab.includes("Lead operating mode") &&
      !ctxDefault.includes("Lead operating mode"),
    { sectionLen: m.ORCHESTRATOR_SECTION_TEXT.length },
  );
} catch (err) {
  check("text-audit 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  fs.rmSync(tmp, { force: true });
}

const summary = { audit: "text-audit", pass: failures.length === 0, total: results.length, failures };
process.stdout.write(`\n${JSON.stringify(summary)}\n`);
if (process.argv.includes("--json")) {
  const file = process.argv[process.argv.indexOf("--json") + 1];
  if (file !== undefined) fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2), { mode: 0o600 });
}
process.exitCode = failures.length === 0 ? 0 : 1;
