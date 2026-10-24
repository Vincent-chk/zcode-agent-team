// U-O2 collaborator 回退验收（stage-6.5 验收标准 C）：生产 userConfig 链切换 leadMode=collaborator
// → 真实短会话拉起 daemon → 验证 runtime-config.json 翻转（userConfig→env→daemon→落盘 全链）+ 会话正常。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checks, loadConfig, runZcode, waitFor, writeResult } from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-u02-ws-"));
const checks = new Checks("U-O2");
const evidence = {};
const rcPath = path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "agent-team@inline", "meta", "runtime-config.json");

try {
  // 前置：单测已证 collaborator 注入与扩展前逐字节一致（F-O2）；此处补生产链翻转证据。
  const before = JSON.parse(fs.readFileSync(rcPath, "utf8"));
  evidence.before = before;

  const run = await runZcode(cfg, {
    prompt: "请用你的团队工具面执行一次 list_agents 然后只回复 ok。",
    cwd: ws,
    timeoutMs: 180_000,
  });
  const answer = String(run.parsed?.response ?? "");
  evidence.answer = answer.slice(0, 400);
  evidence.sessionId = run.parsed?.sessionId;
  checks.check("collaborator 模式下会话与工具面正常（有回复）", run.parsed?.sessionId != null && answer.trim().length > 0, {
    ms: run.ms,
    code: run.code,
    stderr: run.stderr.slice(-200),
  });

  const after = await waitFor(
    () => {
      const doc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      return doc.leadMode === "collaborator" ? doc : null;
    },
    { timeoutMs: 60_000, label: "runtime-config flips to collaborator" },
  );
  evidence.after = after.value;
  checks.check(
    "生产链翻转：userConfig=collaborator → daemon env → runtime-config.json.leadMode=collaborator",
    after.value.leadMode === "collaborator" && before.leadMode !== after.value.leadMode,
    { before: before.leadMode, after: after.value.leadMode, updatedAt: after.value.updatedAt },
  );
} catch (err) {
  checks.check("U-O2 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 1500) });
} finally {
  const result = checks.toJSON({ evidence, env: { ws } });
  const file = writeResult(cfg.out, "U-O2", result);
  process.stdout.write(`U-O2 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
