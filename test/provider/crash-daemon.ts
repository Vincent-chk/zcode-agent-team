// 崩溃矩阵演练 daemon（stage-4 T4.6）：TeamCoordinatorHost + ResumePerTurnProvider（真 provider，
// zcode 二进制可指到 fake-zcode）。stdin 行命令协议（NDJSON 应答，stdout 事件流）：
//   {"op":"dispatch","method":"...","params":{...}} → {type:"dispatch-ok"|"dispatch-error",...}
//   {"op":"board"}   → {type:"board", revision, failure?, members:[{name,phase}], pending, delivered}
//   {"op":"close"}   → 优雅退出（host.close → checkpoint）
// 启动参数：--root <dir> --team <id> [--lock-wait <ms>=15000] [--takeover-poll <ms>=50]
// 事件：{type:"started"} {type:"ready",mode,...} {type:"warn",...} {type:"exiting",reason}
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { TeamCoordinatorHost } from "../../src/coord/host.js";
import { ResumePerTurnProvider } from "../../src/provider/resume-provider.js";
import { fakeZcodeBin } from "./kit.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function emit(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...msg }) + "\n");
}

const root = arg("root") as string;
const team = arg("team") as string;
const dataRoot = path.join(root, "data");
const ws = path.join(root, "ws");
fs.mkdirSync(ws, { recursive: true });

const provider = new ResumePerTurnProvider({
  dataRoot,
  teamId: team,
  cwd: ws,
  dbPath: path.join(root, "db.sqlite"),
  zcode: fakeZcodeBin(),
  sessionIsolation: "legacy",
  firstTurnTimeoutMs: 8_000,
  deliverConfirmMs: 4_000,
  watcherIntervalMs: 150,
  relaunchBackoffMs: 120,
  termGraceMs: 500,
  log: (record) => emit({ type: "provider", record }),
});

emit({ type: "started" });

let host: TeamCoordinatorHost | null = null;
let exiting = false;

function gracefulExit(reason: string): void {
  if (exiting) return;
  exiting = true;
  emit({ type: "exiting", reason });
  const closing = host?.close();
  if (closing !== undefined) {
    closing.catch(() => undefined);
    setTimeout(() => process.exit(0), 800);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulExit("sigint"));
process.on("SIGTERM", () => gracefulExit("sigterm"));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim().length === 0 || exiting) return;
  let cmd: { op?: string; method?: string; params?: unknown };
  try {
    cmd = JSON.parse(line) as { op?: string; method?: string; params?: unknown };
  } catch {
    emit({ type: "protocol-error", line: line.slice(0, 120) });
    return;
  }
  if (cmd.op === "close") {
    gracefulExit("cmd-close");
    return;
  }
  if (cmd.op === "board") {
    void (async () => {
      try {
        const loaded = await host!.readBoard();
        emit({
          type: "board",
          revision: loaded.seq,
          ...(loaded.state.failure !== undefined ? { failure: loaded.state.failure } : {}),
          members: loaded.state.members.map((m) => ({ name: m.name, phase: m.phase })),
          messages: loaded.state.messages.map((m) => m.id),
          delivered: loaded.state.delivered,
        });
      } catch (err) {
        emit({ type: "board-error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }
  if (cmd.op === "dispatch") {
    void (async () => {
      try {
        const result = await host!.dispatch(cmd.method!, cmd.params);
        emit({ type: "dispatch-ok", method: cmd.method, result });
      } catch (err) {
        emit({
          type: "dispatch-error",
          method: cmd.method,
          code: (err as { code?: string }).code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return;
  }
  emit({ type: "protocol-error", op: cmd.op ?? null });
});

const theHost = await TeamCoordinatorHost.open({
  dataRoot,
  teamId: team,
  provider,
  lockWaitMs: Number(arg("lock-wait", "15000")),
  autoTakeover: true,
  takeoverPollMs: Number(arg("takeover-poll", "50")),
  warn: (message) => emit({ type: "warn", message }),
  onPromoted: (info) => emit({ type: "promoted", seq: info.seq }),
});
host = theHost;
const info = await theHost.readyInfo();
emit({ type: "ready", mode: theHost.currentMode, seq: info.seq, socketPath: info.socketPath });
setInterval(() => undefined, 60_000); // 常驻（等 stdin 命令）
