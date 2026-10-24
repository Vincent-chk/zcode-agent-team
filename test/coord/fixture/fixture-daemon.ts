// F29/崩溃矩阵演练夹具 daemon（真实子进程；esbuild 打包后由测试孵化）。
// 用法：node fixture-daemon.mjs --root <dir> --team <id> [--ops <file>] [--op-delay-ms <n>]
//        [--crash-at <point>] [--crash-on-seq <n>] [--hold-ms <n>] [--standby-poll]
// stdout = NDJSON 事件流（父进程解析）：
//   {type:"started",pid} / {type:"standby-waiting",pid} / {type:"ready",pid,bootId,socketPath,seq}
//   {type:"appended",seq} / {type:"workload-done",seq} / {type:"crash",point,seq}
//   {type:"sigint",pid} / {type:"exiting",reason,pid}
// 信号（对齐 H10：SIGINT → 尽力释放 ≤200ms → exit；SIGTERM 同路径）。
import path from "node:path";
import fs from "node:fs";
import { CoordinatorLock } from "../../../src/coord/lock.js";
import { TeamJournal, type CrashPoint } from "../../../src/coord/journal.js";
import { RpcServer, registerExampleMethods } from "../../../src/coord/rpc.js";
import { resolveSocketPath, writeSocketRegistry, removeSocketRegistry, safeTeamId } from "../../../src/coord/paths.js";
import { bootId } from "../../../src/coord/identity.js";
import { load } from "../../../src/coord/replay.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = arg("root") as string;
const team = arg("team") as string;
const teamDir = path.join(root, "teams", safeTeamId(team));
fs.mkdirSync(teamDir, { recursive: true });
const lockFile = path.join(teamDir, "coordinator.lock");
const auditFile = path.join(teamDir, "coordinator.audit.jsonl");
const id = team;

function emit(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...msg }) + "\n");
}

let journal: TeamJournal | null = null;
let server: RpcServer | null = null;
let exited = false;
let lockRef: CoordinatorLock | null = null;

function gracefulExit(reason: string): void {
  if (exited) return;
  exited = true;
  emit({ type: "exiting", reason }); // 先宣告（父进程量退出预算）
  try {
    lockRef?.releaseSync(); // 关键路径：同步释放 ≤200ms 预算内
  } catch {
    /* best-effort */
  }
  try {
    removeSocketRegistry(teamDir);
    server?.close();
  } catch {
    /* best-effort */
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  emit({ type: "sigint" });
  gracefulExit("sigint");
});
process.on("SIGTERM", () => gracefulExit("sigterm"));

async function runCoordinator(coordinatorLock: CoordinatorLock): Promise<void> {
  lockRef = coordinatorLock;
  const crashAt = arg("crash-at") as CrashPoint | undefined;
  const crashOnSeq = arg("crash-on-seq") !== undefined ? Number(arg("crash-on-seq")) : undefined;
  const crashHook =
    crashAt !== undefined
      ? (point: CrashPoint, ctx: { seq: number }) => {
          if (point === crashAt && (crashOnSeq === undefined || ctx.seq === crashOnSeq)) {
            emit({ type: "crash", point, seq: ctx.seq });
            process.kill(process.pid, "SIGKILL");
          }
        }
      : undefined;

  journal = TeamJournal.open(teamDir, id, { crashHook });
  const loaded = await journal.openWriter();
  coordinatorLock.startHeartbeat();

  const socket = resolveSocketPath(teamDir);
  server = new RpcServer(socket.socketPath);
  registerExampleMethods(server, {
    coordinatorBootId: () => lockRef?.info?.bootId ?? bootId(),
    stateRevision: () => journal?.committedSeq ?? 0,
  });
  server.register("team.append", (params) => {
    const event = (params as { event: unknown }).event;
    return journal!.appendAndFlush(event).then((r) => ({ seq: r.seq }));
  });
  server.register("team.state", async () => {
    const l = await load(teamDir, id);
    return { seq: l.seq, state: l.state, view: l.view, writers: l.writers };
  });
  await server.listen();
  writeSocketRegistry(teamDir, socket.socketPath);
  emit({ type: "ready", bootId: coordinatorLock.info?.bootId, socketPath: socket.socketPath, seq: loaded.seq, fromCheckpoint: loaded.fromCheckpoint });

  const opsFile = arg("ops");
  if (opsFile !== undefined) {
    const ops = JSON.parse(fs.readFileSync(opsFile, "utf8")) as unknown[];
    const delayMs = Number(arg("op-delay-ms", "0"));
    for (const event of ops) {
      const r = await journal.appendAndFlush(event);
      emit({ type: "appended", seq: r.seq });
      if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    }
    emit({ type: "workload-done", seq: journal.committedSeq });
  }

  const holdMs = arg("hold-ms");
  if (holdMs !== undefined) {
    setTimeout(() => gracefulExit("hold-elapsed"), Number(holdMs));
  }
  // 常驻（宿主回收模拟由父进程发信号）
  setInterval(() => undefined, 60_000);
}

async function main(): Promise<void> {
  emit({ type: "started", bootId: bootId() });
  const lock = new CoordinatorLock(lockFile, auditFile);
  lock.installExitHandlers();
  for (;;) {
    try {
      await lock.acquire({ waitMs: 15_000 });
      await runCoordinator(lock);
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AcquireTimeout") {
        emit({ type: "standby-waiting" });
        continue;
      }
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  }
}

void main();
