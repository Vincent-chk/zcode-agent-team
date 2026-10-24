// S2 fork 剧本（SF02；真模型）：暗号跨 fork 边界可答；origin.context=fork；首轮注入转录；
// 不重复注入 Lead 身份消息（D2：无身份前缀）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Checks,
  assistantTexts,
  createTestSessionDb,
  firstRealUserText,
  loadConfig,
  originByName,
  realDbPath,
  runZcode,
  startDaemon,
  teamDirFor,
  waitFor,
  writeResult,
} from "./common.mjs";

const cfg = loadConfig();
const fake = process.env.E2E_FAKE === "1";
const dbPath = fake ? cfg.dbPath : realDbPath();
if (fake) createTestSessionDb(cfg.dbPath);
const code = `s2code-${crypto.randomBytes(4).toString("hex")}`;
const checks = new Checks("S2");
const evidence = { code };

const seed = await runZcode(cfg, { prompt: `请记住暗号 ${code}（后续会考），然后只回复 ok。` });
const leadId = seed.parsed?.sessionId;
if (typeof leadId !== "string" || leadId.length === 0) {
  checks.check("Lead 真会话建立", false, { seed });
  const file = writeResult(cfg.out, "S2", checks.toJSON({ evidence }));
  process.stdout.write(`S2 result → ${file}\n`);
  process.exit(1);
}
checks.check("Lead 真会话建立", (seed.parsed?.response ?? "").includes("ok"), { leadId, ms: seed.ms });
evidence.leadId = leadId;

const teamDir = teamDirFor(cfg, leadId);
const meta = { session_id: leadId };
const forkName = `s2-fork-${crypto.randomBytes(2).toString("hex")}`;
const daemon = startDaemon(cfg, {
  dbPath,
  env: {
    TEAM_SESSION_ISOLATION: fake ? "legacy" : "child",
    ...(fake ? { TEAM_ZCODE_BIN: cfg.fakeZcode, FAKE_ZCODE_RESPONSE: `暗号是 ${code}` } : {}),
  },
});

try {
  await daemon.ready();
  await daemon.callJson("spawn_teammate", {
    name: forkName,
    description: "S2 fork 上下文",
    prompt: "在你的上下文里，Team Lead 之前记住的暗号是什么？只回复暗号本身。",
    context: "fork",
  }, meta);
  const origin = await waitFor(() => {
    const found = originByName(teamDir, forkName);
    return found?.sessionId ? found : null;
  }, { timeoutMs: 180_000, label: "fork session settled" });
  evidence.origin = {
    memberId: origin.value.memberId,
    sessionId: origin.value.sessionId,
    context: origin.value.context,
    sessionIsolation: origin.value.sessionIsolation,
  };
  const answerMs = await waitFor(
    () => assistantTexts(dbPath, origin.value.sessionId).some((text) => text.includes(code)),
    { timeoutMs: 180_000, label: "fork answer contains code" },
  );
  const answer = assistantTexts(dbPath, origin.value.sessionId).join("\n");
  checks.check("fork 暗号跨边界可答", answer.includes(code), { answer: answer.slice(0, 400), ms: answerMs.ms });
  checks.check("origin.context = fork", origin.value.context === "fork", { context: origin.value.context });

  const turn1 = JSON.parse(
    fs.readFileSync(path.join(teamDir, "members", origin.value.memberId, "run", "turn-1.json"), "utf8"),
  );
  const firstUser = firstRealUserText(dbPath, origin.value.sessionId) ?? "";
  checks.check("首轮 prompt = 转录注入 + 任务原文（落库一致）", firstUser === turn1.promptText, {
    promptBytes: turn1.promptText.length,
    landedBytes: firstUser.length,
  });
  checks.check("fork 注入包含 Lead 种子内容（暗号）", turn1.promptText.includes(code), {
    promptHead: turn1.promptText.slice(0, 200),
  });
  // D2：身份不再以「你是 xxx」前缀注入（对齐轮删除身份前缀）
  checks.check("无重复身份前缀注入", !/^你是\s*\S+\s*[，,]/m.test(turn1.promptText) && !turn1.promptText.includes("TEAM_SPAWN_IDENTITY"), {
    head: turn1.promptText.slice(0, 120),
  });
} catch (err) {
  checks.check("S2 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const exited = await daemon.kill("SIGINT").catch(() => ({ code: null, signal: null }));
  const result = checks.toJSON({
    evidence,
    daemonExit: exited,
    daemonStderrTail: daemon.stderr().slice(-4000),
    env: { zcode: cfg.zcode, dataRoot: cfg.dataRoot, db: dbPath, ws: cfg.ws, fake },
  });
  const file = writeResult(cfg.out, "S2", result);
  process.stdout.write(`S2 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
