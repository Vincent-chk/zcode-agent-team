// 环境自检探针（stage-2 规划 §3 风险表：工程目录在外置 exFAT 卷，非理论风险）。
// 三项探针（真实子进程；execFile 固定脚本 + 参数数组，无 shell 参与）：
//   ① 原子追加：2 个子进程并发 O_APPEND 各写 200 行 → 无半行、无交错撕裂、无丢失；
//   ② 独占锁：两进程同时 O_EXCL 抢锁 → 恰一成功；
//   ③ fsync 语义：子进程 write+fsync 后**自杀于 SIGKILL**（进程级强杀，语义 = kill -9 写者）
//     → 父进程验数据完整可读（验证「进程死亡不丢已 fsync 数据」；OS 级宕机不在探针范围，
//     口径如实登记）。
// 探针文件用后即删。tmpdir 探针必须全绿（自动化测试）；目标卷失败 = 登记环境限制并走
// daemon 启动告警路径。「回退模式（单协调者+本机临时目录）」本轮不实现（仅文档口径）。

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ProbeResult {
  probe: "append" | "lock" | "fsync";
  ok: boolean;
  detail: string;
  ms: number;
}

export interface FsCheckReport {
  root: string;
  results: ProbeResult[];
  ok: boolean;
}

// 固定子进程脚本（CommonJS；argv: [role, targetFile, who, count]）
const CHILD_SCRIPT = `const role = process.argv[2];
const file = process.argv[3];
const fs = require("node:fs");
if (role === "append") {
  const who = process.argv[4];
  const n = Number(process.argv[5]);
  const fd = fs.openSync(file, "a");
  for (let i = 0; i < n; i++) fs.writeSync(fd, JSON.stringify({ who, i }) + "\\n");
  fs.closeSync(fd);
  process.stdout.write("DONE " + who + "\\n");
} else if (role === "lock") {
  const who = process.argv[4];
  let fd;
  try {
    fd = fs.openSync(file, "wx");
  } catch {
    process.stdout.write("LOST " + who + "\\n");
    process.exit(0);
  }
  fs.writeFileSync(fd, who);
  fs.closeSync(fd);
  process.stdout.write("ACQUIRED " + who + "\\n");
} else if (role === "fsync") {
  const fd = fs.openSync(file, "a");
  for (let i = 0; i < 100; i++) fs.writeSync(fd, JSON.stringify({ i, pad: "x".repeat(64) }) + "\\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  process.stdout.write("SYNCED\\n");
  // fsync 完成后自杀于 SIGKILL（进程级强杀，等价 kill -9 写者；父进程验数据存活）
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
} else {
  process.stderr.write("unknown role\\n");
  process.exit(2);
}
`;

/** 对给定 root 跑三项探针（root 须已存在；探针文件放 root 下临时子目录，用后即删）。 */
export async function runProbes(root: string): Promise<FsCheckReport> {
  const dir = path.join(root, `.fscheck-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const childScript = path.join(dir, "fscheck-child.cjs");
    fs.writeFileSync(childScript, CHILD_SCRIPT, { mode: 0o600 });
    const append = await probeAppend(dir, childScript);
    const lock = await probeLock(dir, childScript);
    const fsync = await probeFsync(dir, childScript);
    return { root, results: [append, lock, fsync], ok: [append, lock, fsync].every((r) => r.ok) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 边界校验：目标文件必须位于本探针目录内（子进程只接收目录内路径与固定常量）。 */
function assertInside(dir: string, file: string): void {
  const root = path.resolve(dir) + path.sep;
  if (!path.resolve(file).startsWith(root)) {
    throw new Error(`probe target escapes probe dir: ${file}`);
  }
}

async function probeAppend(dir: string, childScript: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const file = path.join(dir, "append.jsonl");
  assertInside(dir, file);
  const lines = 200;
  const children = ["a", "b"].map((who) =>
    runProbeChild(childScript, dir, ["append", file, who, String(lines)]),
  );
  await Promise.all(children);
  const raw = fs.readFileSync(file, "utf8");
  const linesOut = raw.split("\n").filter((l) => l.length > 0);
  const counts: Record<string, number> = {};
  let torn = 0;
  for (const line of linesOut) {
    try {
      const parsed = JSON.parse(line) as { who: string };
      counts[parsed.who] = (counts[parsed.who] ?? 0) + 1;
    } catch {
      torn += 1;
    }
  }
  const ok = torn === 0 && counts.a === lines && counts.b === lines;
  return {
    probe: "append",
    ok,
    detail: ok
      ? `2 writers x ${lines} lines interleaved atomically (a=${counts.a}, b=${counts.b}, torn=0)`
      : `torn=${torn}, counts=${JSON.stringify(counts)} (expect a=b=${lines})`,
    ms: Date.now() - startedAt,
  };
}

async function probeLock(dir: string, childScript: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const file = path.join(dir, "probe.lock");
  assertInside(dir, file);
  const outs = await Promise.all([
    runProbeChild(childScript, dir, ["lock", file, "a", ""]),
    runProbeChild(childScript, dir, ["lock", file, "b", ""]),
  ]);
  const acquired = outs.filter((o) => o.startsWith("ACQUIRED"));
  const ok = acquired.length === 1;
  return {
    probe: "lock",
    ok,
    detail: ok
      ? `exactly one of two concurrent claimers won (${acquired[0].trim()})`
      : `expected exactly 1 winner, got ${acquired.length}: ${outs.map((o) => o.trim()).join(" | ")}`,
    ms: Date.now() - startedAt,
  };
}

async function probeFsync(dir: string, childScript: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const file = path.join(dir, "fsync.jsonl");
  assertInside(dir, file);
  // 子进程：写 100 行 → fsync → 自杀 SIGKILL。父进程等待退出并验信号 + 数据完整。
  const outcome = await new Promise<{ signal: string | null }>((resolve, reject) => {
    execFile(process.execPath, [childScript, "fsync", file, "", ""], (err) => {
      if (err && err.killed !== true) {
        // 期望的退出形态 = signal SIGKILL（err.signal）；其他错误才 reject
        if (err.signal === "SIGKILL") resolve({ signal: err.signal });
        else reject(new Error(`fsync probe child failed: ${err.message}`));
      } else if (!err) {
        reject(new Error("fsync probe child exited cleanly (expected SIGKILL self-kill)"));
      } else {
        resolve({ signal: (err as NodeJS.ErrnoException & { signal?: string }).signal ?? null });
      }
    });
  });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  const ok =
    outcome.signal === "SIGKILL" &&
    lines.length === 100 &&
    lines.every((l) => (JSON.parse(l) as { i: number }).i !== undefined);
  return {
    probe: "fsync",
    ok,
    detail: ok
      ? "100 fsynced lines survived writer SIGKILL, none torn"
      : `signal=${String(outcome.signal)}, ${lines.length}/100 lines readable after kill`,
    ms: Date.now() - startedAt,
  };
}

/** 跑探针子进程（execFile：node + 固定脚本 + 参数数组；退出码非 0 → reject）。 */
function runProbeChild(script: string, dir: string, args: string[]): Promise<string> {
  assertInside(dir, args[1]); // 参数白名单：仅 argv[1] 是路径（其余为固定常量 role/who/count）
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(`probe child failed: ${err.message}; stderr=${stderr}`));
      else resolve(stdout);
    });
  });
}

/** daemon 启动自检入口：失败 → 返回可读告警（日志层消费；回退模式不实现，仅告警）。 */
export async function startupFsCheck(dataRoot: string): Promise<string | null> {
  try {
    const report = await runProbes(fs.existsSync(dataRoot) ? dataRoot : os.tmpdir());
    if (report.ok) return null;
    return (
      `agent-team fs self-check FAILED on ${report.root}: ` +
      report.results.filter((r) => !r.ok).map((r) => `${r.probe}(${r.detail})`).join("; ") +
      " — durability/coordination guarantees at risk; see stage-2 plan section 3 (exFAT risk)"
    );
  } catch (err) {
    return `agent-team fs self-check errored: ${err instanceof Error ? err.message : String(err)}`;
  }
}
