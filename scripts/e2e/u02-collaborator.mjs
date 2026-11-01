// U-O2 旧值迁移验收（〔issue #9 三档化 D28〕；原 stage-6.5 验收标准 C 的协作档翻转场景改版）：
// 生产 userConfig 链写入**旧值** leadMode=collaborator（宿主设置层不认识新枚举的老配置形态）→
// 真实短会话拉起 daemon → 验证全链归一：userConfig(旧值 collaborator) → daemon env → normalize →
// runtime-config.json.leadMode=**auto**（旧值统一迁移 auto，绝不落回激进档）+ 会话与工具面正常。
// 前置（操作者）：在宿主 Settings → Plugins → agent-team 的 leadMode 里填旧值 collaborator 后运行本脚本。
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
  // 前置：单测已证旧值归一（validateLeadMode/normalizeLeadMode）；此处补生产链迁移证据。
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
  checks.check("旧值配置下会话与工具面正常（有回复）", run.parsed?.sessionId != null && answer.trim().length > 0, {
    ms: run.ms,
    code: run.code,
    stderr: run.stderr.slice(-200),
  });

  const after = await waitFor(
    () => {
      const doc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      return doc.leadMode === "auto" ? doc : null;
    },
    { timeoutMs: 60_000, label: "runtime-config migrates legacy collaborator to auto" },
  );
  evidence.after = after.value;
  checks.check(
    "旧值迁移：userConfig=collaborator（旧） → 生效链落盘 leadMode=auto（不落回激进档；before 仅登记）",
    after.value.leadMode === "auto",
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
