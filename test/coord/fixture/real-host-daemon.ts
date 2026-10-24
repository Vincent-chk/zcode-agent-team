// 真实装配演练 daemon（stage-2 第四轮 A3/B）：TeamCoordinatorHost 直接装配（MockProvider）。
// 用法：
//   node real-host-daemon.mjs --root <dir> --team <id> --mode coordinator|proxy
//        [--hold-ms <n>] [--proxy-calls <file>] [--post-promotion-calls <file>]
// stdout = NDJSON 事件流（父进程解析）：
//   {type:"started"} / {type:"ready", mode, socketPath?, seq, fromCheckpoint?}
//   {type:"promoted", socketPath, seq} / {type:"dispatch-ok", method, phase, result}
//   {type:"dispatch-error", method, phase, message} / {type:"exiting", reason}
// --proxy-calls：ready 后立即经 TeamClient 执行（代理模式 → socket 转发；协调者模式 → 直执行）。
// --post-promotion-calls：晋升为协调者后执行（进程内直执行）。
import fs from "node:fs";
import path from "node:path";
import { TeamCoordinatorHost } from "../../../src/coord/host.js";
import { TeamClient } from "../../../src/coord/client.js";
import { bootId } from "../../../src/coord/identity.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function emit(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...msg }) + "\n");
}

interface ScriptedCall {
  method: string;
  params?: unknown;
}

function readCalls(file: string | undefined): ScriptedCall[] {
  if (file === undefined) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as ScriptedCall[];
}

async function runCalls(
  client: TeamClient,
  calls: ScriptedCall[],
  phase: string,
): Promise<void> {
  for (const call of calls) {
    try {
      const result = await client.dispatch(call.method, call.params);
      emit({ type: "dispatch-ok", method: call.method, phase, result });
    } catch (err) {
      emit({
        type: "dispatch-error",
        method: call.method,
        phase,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const root = arg("root") as string;
const team = arg("team") as string;
const mode = arg("mode", "coordinator") as "coordinator" | "proxy";
const opsDir = path.join(root, "ops");
fs.mkdirSync(opsDir, { recursive: true });

emit({ type: "started", bootId: bootId(), wantMode: mode });

let host: TeamCoordinatorHost | null = null;
let exiting = false;

function gracefulExit(reason: string): void {
  if (exiting) return;
  exiting = true;
  emit({ type: "exiting", reason });
  const closing = host?.close();
  if (closing !== undefined) {
    closing.catch(() => undefined);
    // close 内 dispose/落 checkpoint 均为快速本地 IO；给 500ms 预算后退出
    setTimeout(() => process.exit(0), 500);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulExit("sigint"));
process.on("SIGTERM", () => gracefulExit("sigterm"));

async function main(): Promise<void> {
  host = await TeamCoordinatorHost.open({
    dataRoot: root,
    teamId: team,
    lockWaitMs: mode === "coordinator" ? 15_000 : 0,
    autoTakeover: mode === "proxy",
    takeoverPollMs: 50, // 收紧观察轮询：锁过期（4500ms）后 ≤50ms 内出手
    warn: (message) => emit({ type: "warn", message }),
    onPromoted: (info) => {
      emit({
        type: "promoted",
        socketPath: info.socketPath,
        seq: info.seq,
        fromCheckpoint: info.fromCheckpoint,
        ...(info.failure !== undefined ? { failure: info.failure } : {}),
      });
    },
  });
  const client = new TeamClient({ dataRoot: root, teamId: team, host: () => host });
  const info = await host.readyInfo();
  emit({
    type: "ready",
    mode: host.currentMode,
    socketPath: info.socketPath,
    seq: info.seq,
    fromCheckpoint: info.fromCheckpoint,
    ...(info.failure !== undefined ? { failure: info.failure } : {}),
  });

  await runCalls(client, readCalls(arg("proxy-calls")), "proxy-phase");
  if (mode === "proxy") {
    // 等待晋升（watcher 周期 100ms；接任 ≤5s 由锁调参保证）——晋升后跑 post-promotion 脚本
    const deadline = Date.now() + 30_000;
    while (host.currentMode === "proxy" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await runCalls(client, readCalls(arg("post-promotion-calls")), "post-promotion");
  }

  const holdMs = arg("hold-ms");
  if (holdMs !== undefined) {
    setTimeout(() => gracefulExit("hold-elapsed"), Number(holdMs));
  }
  setInterval(() => undefined, 60_000); // 常驻
}

void main().catch((err) => {
  emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
