// U-O2 收尾（〔issue #9 三档化 D28〕）：恢复默认（options 清空 → userConfig 默认 **auto**）后，
// 一个真实短会话应把 runtime-config.json 翻回 auto（闭环 + 无残留）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checks, loadConfig, runZcode, waitFor, writeResult } from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-u02r-ws-"));
const checks = new Checks("U-O2-restore");
const rcPath = path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "agent-team@inline", "meta", "runtime-config.json");

try {
  // prompt 走一次团队工具（list_agents）以拉起 daemon 落盘 runtime-config——「只回复 ok」不会
  // 触发 daemon 惰性启动，等待落盘会超时（0.4.3 时代靠读旧盘值侥幸通过）。
  const run = await runZcode(cfg, { prompt: "请执行一次 list_agents 然后只回复 ok。", cwd: ws, timeoutMs: 180_000 });
  const after = await waitFor(
    () => {
      const doc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      return doc.leadMode === "auto" ? doc : null;
    },
    { timeoutMs: 60_000, label: "runtime-config back to auto" },
  );
  checks.check(
    "恢复默认后生产链翻回 auto（无残留）",
    after.value.leadMode === "auto" && String(run.parsed?.response ?? "").trim().length > 0,
    { leadMode: after.value.leadMode, updatedAt: after.value.updatedAt },
  );
} catch (err) {
  checks.check("U-O2-restore 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 1200) });
} finally {
  const result = checks.toJSON({ env: { ws } });
  const file = writeResult(cfg.out, "U-O2-restore", result);
  process.stdout.write(`U-O2-restore result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
