// U-O2 收尾：恢复默认（options 清空 → userConfig 默认 orchestrator）后，
// 一个真实短会话应把 runtime-config.json 翻回 orchestrator（闭环 + 无残留）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checks, loadConfig, runZcode, waitFor, writeResult } from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-u02r-ws-"));
const checks = new Checks("U-O2-restore");
const rcPath = path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "agent-team@inline", "meta", "runtime-config.json");

try {
  const run = await runZcode(cfg, { prompt: "只回复 ok。", cwd: ws, timeoutMs: 180_000 });
  const after = await waitFor(
    () => {
      const doc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      return doc.leadMode === "orchestrator" ? doc : null;
    },
    { timeoutMs: 60_000, label: "runtime-config back to orchestrator" },
  );
  checks.check(
    "恢复默认后生产链翻回 orchestrator（无残留）",
    after.value.leadMode === "orchestrator" && String(run.parsed?.response ?? "").trim().length > 0,
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
