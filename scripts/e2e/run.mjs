// stage-6 e2e 运行器：node scripts/e2e/run.mjs [--only s1,s3] [--retries 1] [--out dir]
// 每个剧本在独立子进程里跑（数据根/DB 隔离），输出统一 result.json；任一失败 → 非零退出。
// 剧本清单与依赖：
//   S1 协作（真模型）  S2 fork（真模型）  S3 崩溃矩阵（确定性）  S4 限额（真模型）
//   S5 并发（fake-zcode，确定性） S6 hook 通道（真模型）  S7 编排旅程（真模型；stage-6.5 D26）
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const only = new Set((argOf("only") ?? "s1,s2,s3,s4,s5,s6,s7").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const retries = Number(argOf("retries") ?? "1");
const outDir = path.resolve(argOf("out") ?? path.join(PROJ, "..", "zcode-agent-team-plan", "stage-6-e2e-acceptance", "evidence"));
fs.mkdirSync(outDir, { recursive: true });

const SCENARIOS = {
  s1: { file: "s1-collab.mjs", label: "S1 协作剧本", needsModel: true },
  s2: { file: "s2-fork.mjs", label: "S2 fork 剧本", needsModel: true },
  s3: { file: "s3-crash.mjs", label: "S3 故障剧本", needsModel: false },
  s4: { file: "s4-limits.mjs", label: "S4 限额剧本", needsModel: true },
  s5: { file: "s5-concurrency.mjs", label: "S5 并发剧本", needsModel: false },
  s6: { file: "s6-hook-channel.mjs", label: "S6 hook 通道剧本", needsModel: true },
  s7: { file: "s7-orchestration.mjs", label: "S7 编排旅程（stage-6.5）", needsModel: true },
};

function runOnce(id, scenario) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      process.execPath,
      [path.join(__dirname, scenario.file), "--out", outDir],
      { cwd: PROJ, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60_000, env: process.env },
      (err, stdout, stderr) => {
        resolve({
          id,
          label: scenario.label,
          ok: !err,
          ms: Date.now() - startedAt,
          code: err?.code ?? 0,
          signal: err?.signal ?? null,
          stdoutTail: String(stdout).slice(-4000),
          stderrTail: String(stderr).slice(-4000),
        });
      },
    );
  });
}

const results = [];
for (const [id, scenario] of Object.entries(SCENARIOS)) {
  if (!only.has(id)) continue;
  const file = path.join(__dirname, scenario.file);
  if (!fs.existsSync(file)) {
    results.push({ id, label: scenario.label, ok: false, skipped: `missing script ${scenario.file}`, attempts: 0 });
    process.stdout.write(`SKIP ${id}: missing ${scenario.file}\n`);
    continue;
  }
  let attempt = 0;
  let last;
  do {
    attempt += 1;
    process.stdout.write(`\n=== ${scenario.label}（attempt ${attempt}/${retries}）===\n`);
    last = await runOnce(id, scenario);
    if (last.ok) break;
  } while (attempt <= retries);
  results.push({ ...last, attempts: attempt });
}

const pass = results.every((r) => r.ok);
const summary = {
  scenario: "stage-6 e2e",
  pass,
  ts: new Date().toISOString(),
  results,
};
fs.writeFileSync(path.join(outDir, `E2E-SUMMARY-${summary.ts.replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2), {
  mode: 0o600,
});
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = pass ? 0 : 1;
