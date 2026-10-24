// 轮次进程纪律（T4.1）：独立进程组（setsid）——daemon 被宿主回收（SIGINT→SIGKILL）不连带杀轮次；
// stdout 落 run/ 文件（daemon 回收后仍可取证）；终止以进程组为对象（-pgid）。
// 孵化形态：execFile(node, ["--", detach-helper.mjs, spec])（回调形态 + 参数数组 + 选项终止符，
// 无 shell 参与——与 fscheck/daemon-kit 同纪律）；helper 起出轮次进程后立即退出，daemon 不持有
// 轮次任何管道。探活 kill(pid,0)：ESRCH = 死；EPERM = 活（他人进程）。pid 复用风险：轮次记录带
// startedAt，探活结果只影响 run/ 状态文件定案（exit/interrupted），不改事件日志——误判上限=一次多余等待。

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./member-files.js";

const HELPER_DEFAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), "detach-helper.mjs");

/** 孵化预算：helper 拉起 + resultFile 出现（正常 ~100ms；超时 = 明确失败）。 */
export const SPAWN_HELPER_TIMEOUT_MS = 10_000;

export interface DetachSpawnSpec {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdoutFile: string;
  /** spec/result 文件（调用方管理生命周期；缺省 = stdoutFile 同目录派生）。 */
  specFile?: string;
  resultFile?: string;
  /**
   * 是否把 env 写进 spec。默认 false：env 经 helper 进程环境传递，不落盘（spec 只落命令/参数）。
   * true 仅用于测试/诊断，且调用方必须先自行脱敏。
   */
  persistEnv?: boolean;
}

export interface DetachSpawnResult {
  pid: number | null;
  pgid: number | null;
  stdoutFile: string;
  specFile: string;
  resultFile: string;
}

/** 经 helper 脱离孵化轮次进程；失败抛可读错误（F03 供给失败注入点：坏二进制/env 缺失）。 */
export async function spawnDetached(spec: DetachSpawnSpec): Promise<DetachSpawnResult> {
  const dir = path.dirname(spec.stdoutFile);
  const specFile = spec.specFile ?? path.join(dir, `${path.basename(spec.stdoutFile, ".out")}.spec.json`);
  const resultFile = spec.resultFile ?? path.join(dir, `${path.basename(spec.stdoutFile, ".out")}.spawn.json`);
  const specDoc: Record<string, unknown> = {
    command: spec.command,
    argv: spec.argv,
    cwd: spec.cwd,
    stdoutFile: spec.stdoutFile,
    resultFile,
  };
  // env 默认不落盘：helper 继承本次 execFile 的 env（真实密钥只在进程内存/内核环境块中）。
  if (spec.persistEnv === true) specDoc.env = spec.env;
  writeJsonAtomic(specFile, specDoc);
  const helper = process.env.TEAM_DETACH_HELPER ?? HELPER_DEFAULT;
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--", helper, specFile],
      { timeout: SPAWN_HELPER_TIMEOUT_MS, cwd: spec.cwd, env: spec.env },
      (err) => {
        if (err) reject(new Error(`detach helper failed: ${err.message}`));
        else resolve();
      },
    );
  });
  let result: { pid?: number; error?: string };
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { pid?: number; error?: string };
  } catch (err) {
    throw new Error(`detach helper produced no result file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof result.error === "string") {
    throw new Error(`turn process launch failed: ${result.error}`);
  }
  return { pid: result.pid ?? null, pgid: result.pid ?? null, stdoutFile: spec.stdoutFile, specFile, resultFile };
}

/** 进程是否存活（ESRCH→false；EPERM→true——他属进程仍占 pid）。 */
export function pidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 进程组是否仍有成员存活（kill(-pgid,0)；leader 退出但后代存活也算活）。 */
export function pgidAlive(pgid: number | null): boolean {
  if (pgid === null || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 终止进程组：SIGTERM → 宽限 graceMs → SIGKILL；返回是否全部退出。 */
export async function killProcessGroup(pgid: number | null, graceMs: number): Promise<boolean> {
  if (pgid === null || pgid <= 0) return true;
  signalGroup(pgid, "SIGTERM");
  for (let waited = 0; waited < graceMs; waited += 50) {
    await sleep(50);
    if (!pgidAlive(pgid) && !pidAlive(pgid)) return true;
  }
  if (pgidAlive(pgid) || pidAlive(pgid)) {
    signalGroup(pgid, "SIGKILL");
    for (let waited = 0; waited < 2_000; waited += 50) {
      await sleep(50);
      if (!pgidAlive(pgid) && !pidAlive(pgid)) return true;
    }
  }
  return !pgidAlive(pgid) && !pidAlive(pgid);
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      // ESRCH = 组已消失（目标达成）；其余（EPERM 等）显式抛出
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
