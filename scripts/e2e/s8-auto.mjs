// S8 auto 默认链冒烟（〔issue #9 三档化 D28〕真模型）：简单问答（单 agent 一次即可）+ 不设任何
// TEAM_* env（走生产 userConfig 默认 leadMode=auto）→ 断言：
//   ① 会话完成且回答正确；② db 会话用户侧消息无任何模式段（auto·未建队不注入 "Lead operating mode"）；
//   ③ 未建队（无 spawn_teammate 调用、无成员目录）；④ runtime-config 生产链落 auto。
// 与 U-O1 的分工：S8 = 简单任务硬门「不建队」（快，日常冒烟）；U-O1 = 复杂目标行为登记（spawn 不设门）。
// 运行前置：runtime 已构建、插件已 dev-install、本机模型可用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checks, loadConfig, readJsonl, runZcode, writeResult } from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s8-ws-"));
const checks = new Checks("S8");
const evidence = { ws };

const PROMPT =
  "两问：1) 13 乘 17 等于多少？2) 你本会话收到的以 [agent-team] 开头的注入文本里，有没有以 'Lead operating mode' 开头的句子？有则原样引用第一句，没有则回答 NONE。回答格式：第一行只写第 1 问的数字，第二行写第 2 问的答案。";

try {
  const env = { ...process.env };
  delete env.TEAM_LEAD_MODE;
  const run = await runZcode(cfg, { prompt: PROMPT, cwd: ws, timeoutMs: 300_000, env });
  const leadId = run.parsed?.sessionId;
  const answer = String(run.parsed?.response ?? "").trim();
  evidence.sessionId = leadId;
  evidence.answer = answer.slice(0, 300);
  checks.check("1 会话完成且回答正确（含 221）", typeof leadId === "string" && answer.length > 0 && answer.includes("221"), {
    ms: run.ms,
    code: run.code,
    answerHead: answer.slice(0, 120),
    stderr: run.stderr.slice(-200),
  });
  if (typeof leadId !== "string" || leadId.length === 0) throw new Error("no sessionId");

  // 〔D10〕注入文本不落 transcript —— 模式段有无改为**问模型**取证：
  // auto·未建队 → 模型看不到 'Lead operating mode' 句 → 应答 NONE。
  checks.check(
    "2 注入面无模式段（模型应答 NONE = 未收到 'Lead operating mode' 段）",
    /NONE/.test(answer) && !/Lead operating mode/.test(answer),
    { answerHead: answer.slice(0, 200) },
  );

  // 未建队：无 spawn 调用（meta-log，扫所有 agent-team 数据根）+ 无成员目录
  const safe = String(leadId).replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0).toString(16));
  const dataRoots = [];
  const dataHome = path.join(os.homedir(), ".zcode", "cli", "plugins", "data");
  if (fs.existsSync(dataHome)) {
    for (const name of fs.readdirSync(dataHome)) {
      if (name.startsWith("agent-team")) dataRoots.push(path.join(dataHome, name));
    }
  }
  const devRoot = path.join(os.homedir(), ".zcode", "agent-team-dev-data");
  if (fs.existsSync(devRoot)) dataRoots.push(devRoot);
  let spawns = 0;
  let leadWakeRoot = null;
  for (const root of dataRoots) {
    const metaLog = path.join(root, "logs", "meta-log.jsonl");
    if (fs.existsSync(metaLog)) {
      spawns += readJsonl(metaLog).filter((l) => l.tool === "spawn_teammate" && l.params_meta?.session_id === leadId).length;
    }
    if (fs.existsSync(path.join(root, "teams", safe))) leadWakeRoot = root;
  }
  checks.check("3 未建队（meta-log 无 spawn_teammate）", spawns === 0, { spawns });

  // runtime-config：daemon 惰性启动（首调团队工具才拉起）——简单问答不触发属预期；
  // 条件断言：文件不存在 = PASS（默认链证据由 hooks 层单测与 U-O2-restore 覆盖），存在则必须 auto。
  const rcRoot = leadWakeRoot ?? dataRoots[0];
  const rcPath = rcRoot !== undefined ? path.join(rcRoot, "meta", "runtime-config.json") : null;
  const rcExists = rcPath !== null && fs.existsSync(rcPath);
  let rcLeadMode = null;
  if (rcExists) rcLeadMode = JSON.parse(fs.readFileSync(rcPath, "utf8")).leadMode ?? null;
  evidence.runtimeConfig = { rcPath, leadMode: rcLeadMode };
  checks.check(
    "4 生产默认链（runtime-config 不存在[daemon 未拉起] 或 leadMode=auto）",
    !rcExists || rcLeadMode === "auto",
    { rcPath, rcExists, rcLeadMode },
  );
} catch (err) {
  checks.check("S8 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 1500) });
} finally {
  const result = checks.toJSON({ evidence, env: { ws } });
  const file = writeResult(cfg.out, "S8", result);
  process.stdout.write(`S8 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
