// S3 故障剧本（SF03）：stage-2 崩溃注入 12 点（vitest crash-matrix）+ stage-4 C1–C5（进程级矩阵）
// 合并为 17 点；每点断言「不丢 / 不重 / 状态连续」并输出映射表。
// 不丢：已应答 seq ≤ 落盘 seq；不重：messageId 唯一、delivered ⊆ queued；
// 状态连续：events.jsonl seq 从 1 连续、重放无 corrupt、终态 = 参考投影（由各自矩阵断言，脚本复核产物）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Checks, PROJ, loadConfig, writeResult } from "./common.mjs";

const cfg = loadConfig();
const checks = new Checks("S3");
const vitestBin = path.join(PROJ, "node_modules", ".bin", "vitest");
const stage2Out = path.join(os.tmpdir(), "at-stage2-evidence", "crash-matrix.json");

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(cmd, argv, { cwd: PROJ, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, env: process.env, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, ms: Date.now() - startedAt, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const evidence = { points: [], mapping: [] };

try {
  // —— ① stage-2 崩溃注入 12 点 = crash-matrix 9 点（5 注入点 + 接管中 + 随机杀×3）
  //        + services-journal 3 点（delivered:before / delivered:after / F29 续投）
  fs.rmSync(stage2Out, { force: true });
  const crashOut = path.join(cfg.out, "s3-stage2-crash-vitest.json");
  const servicesOut = path.join(cfg.out, "s3-stage2-services-vitest.json");
  const crashRun = await run(vitestBin, [
    "run",
    "test/coord/integration/crash-matrix.test.ts",
    "--reporter=json",
    "--outputFile=" + crashOut,
  ]);
  const servicesRun = await run(vitestBin, [
    "run",
    "test/coord/integration/services-journal.test.ts",
    "--reporter=json",
    "--outputFile=" + servicesOut,
  ]);
  const testsOf = (file) => {
    const report = readJson(file);
    return (report?.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  };
  const crashTests = testsOf(crashOut);
  const serviceTests = testsOf(servicesOut);
  const crashEvidence = readJson(stage2Out);
  const crashPoints = Array.isArray(crashEvidence) ? crashEvidence : [];
  const serviceCrashCases = serviceTests.filter((test) => /delivered:before|delivered:after|F29/.test(test.fullName ?? test.title ?? ""));
  const stage2Count = crashPoints.length + serviceCrashCases.length;
  checks.check("stage-2 崩溃矩阵（12 点）全过", crashRun.ok && servicesRun.ok && stage2Count === 12 &&
    crashTests.every((t) => t.status === "passed") && serviceTests.every((t) => t.status === "passed"), {
    crashPoints: crashPoints.length,
    serviceCrashCases: serviceCrashCases.length,
    crashExit: crashRun.code,
    servicesExit: servicesRun.code,
    ms: crashRun.ms + servicesRun.ms,
  });
  for (const point of crashPoints) {
    evidence.points.push({ group: "stage-2", name: point.point, pass: ["recovered", "healthy"].includes(point.outcome) });
  }
  for (const test of serviceCrashCases) {
    evidence.points.push({ group: "stage-2", name: test.fullName ?? test.title, pass: test.status === "passed" });
  }
  evidence.stage2Points = stage2Count;
  const ackViolations = crashPoints.filter(
    (point) => typeof point.maxAcked === "number" && typeof point.persistedSeq === "number" && point.maxAcked > point.persistedSeq,
  );
  checks.check("不丢：已应答 seq ≤ 落盘 seq（全部注入点）", ackViolations.length === 0, { violations: ackViolations });
  checks.check("状态连续：全部注入点 recovered/healthy", crashPoints.every((p) => ["recovered", "healthy"].includes(p.outcome)), {
    outcomes: crashPoints.map((p) => p.outcome),
  });

  // —— ② stage-4 C1–C5（真实进程故障）
  const c15Out = path.join(cfg.out, `s3-c1c5-${Date.now()}.json`);
  const c15 = await run(process.execPath, [path.join(PROJ, "scripts", "crash-matrix.mjs"), "--out", c15Out]);
  const c15Report = readJson(c15Out);
  const classes = c15Report?.results ?? [];
  checks.check("C1–C5 进程级故障矩阵全过", c15.ok && c15Report?.summary?.pass === true && classes.length === 5, {
    exit: c15.code,
    classes: classes.map((c) => ({ cls: c.class, pass: c.pass })),
    stderrTail: c15.stderr.slice(-800),
  });
  for (const item of classes) evidence.points.push({ group: "C1-C5", name: item.class, pass: item.pass });

  const total = evidence.points.length;
  checks.check("合并矩阵 = 17 点", total === 17, { total, mapping: evidence.points.map((p) => p.name) });
  evidence.mapping = evidence.points.map((point, index) => ({ no: index + 1, group: point.group, name: point.name, pass: point.pass }));
} catch (err) {
  checks.check("S3 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ evidence });
  const file = writeResult(cfg.out, "S3", result);
  process.stdout.write(`S3 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
