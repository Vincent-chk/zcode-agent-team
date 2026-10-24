// 演练夹具孵化工具：esbuild 打包 fixture daemon 到 tmpdir + execFile 孵化 + NDJSON 事件流解析。
// 孵化形态 = execFile(node, [bundle, args], callback)（无 shell、参数数组）；外部杀进程用
// process.kill(pid, 信号)（数值 pid + 固定信号常量）。
import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

export interface DaemonEvent {
  type: string;
  pid?: number;
  [key: string]: unknown;
}

export interface DaemonHandle {
  child: ChildProcess;
  pid: number;
  /** 等待指定类型事件（含超时）；返回事件对象。 */
  waitFor(type: string, timeoutMs?: number): Promise<DaemonEvent>;
  /** 已收到的事件流（追加式）。 */
  events: DaemonEvent[];
  exited: Promise<{ code: number | null; signal: string | null }>;
}

let bundlePromise: Promise<string> | undefined;

/** 打包 fixture daemon（进程内单次缓存）到 tmpdir；返回 bundle 路径。 */
export function fixtureDaemonBundle(): Promise<string> {
  bundlePromise ??= (async () => {
    const out = path.join(fs.realpathSync(os.tmpdir()), `at-fixture-daemon-${process.pid}.mjs`);
    await build({
      entryPoints: [path.resolve(import.meta.dirname, "fixture-daemon.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: out,
      logLevel: "silent",
    });
    return out;
  })();
  return bundlePromise;
}

export interface SpawnDaemonArgs {
  root: string;
  team: string;
  ops?: unknown[];
  opDelayMs?: number;
  crashAt?: string;
  crashOnSeq?: number;
  holdMs?: number;
}

/** 孵化 fixture daemon；返回句柄（waitFor / events / exited）。 */
export async function spawnDaemon(args: SpawnDaemonArgs): Promise<DaemonHandle> {
  const bundle = await fixtureDaemonBundle();
  const argv: string[] = [bundle, "--root", args.root, "--team", args.team];
  if (args.ops !== undefined) {
    const opsFile = path.join(args.root, `ops-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.mkdirSync(args.root, { recursive: true });
    fs.writeFileSync(opsFile, JSON.stringify(args.ops));
    argv.push("--ops", opsFile);
  }
  if (args.opDelayMs !== undefined) argv.push("--op-delay-ms", String(args.opDelayMs));
  if (args.crashAt !== undefined) argv.push("--crash-at", args.crashAt);
  if (args.crashOnSeq !== undefined) argv.push("--crash-on-seq", String(args.crashOnSeq));
  if (args.holdMs !== undefined) argv.push("--hold-ms", String(args.holdMs));

  const handle = {} as DaemonHandle;
  const waiters: Array<{ type: string; resolve: (e: DaemonEvent) => void; timer: NodeJS.Timeout }> = [];
  const events: DaemonEvent[] = [];
  let buffer = "";
  let stdoutStream: NodeJS.ReadableStream | null = null;

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    const child = execFile(
      process.execPath,
      argv,
      { maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err && !err.killed && err.code !== 0 && (err as unknown as { signal?: string }).signal === undefined) {
          if (stderr.length > 0) events.push({ type: "child-error", message: stderr.slice(-2000) });
        }
      },
    );
    handle.child = child;
    handle.pid = child.pid as number;
    stdoutStream = child.stdout;
    const out = child.stdout;
    if (out !== null) out.setEncoding("utf8");
    if (out !== null) out.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line) as DaemonEvent;
          events.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].type === ev.type) {
              clearTimeout(waiters[i].timer);
              waiters[i].resolve(ev);
              waiters.splice(i, 1);
            }
          }
        } catch {
          events.push({ type: "unparsed", raw: line.slice(0, 200) });
        }
      }
    });
    child.once("exit", (code, signal) => {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve({ type: "__gone__", wanted: w.type });
      }
      waiters.length = 0;
      resolveExit({ code, signal: signal ?? null });
    });
  });
  void stdoutStream;

  handle.events = events;
  handle.exited = exited;
  handle.waitFor = (type: string, timeoutMs = 20_000) =>
    new Promise<DaemonEvent>((resolve, reject) => {
      const already = events.find((e) => e.type === type);
      if (already !== undefined) return resolve(already);
      const timer = setTimeout(() => reject(new Error(`timeout waiting daemon event: ${type}`)), timeoutMs);
      waiters.push({
        type,
        timer,
        resolve: (e) => (e.type === "__gone__" ? reject(new Error(`daemon gone before event: ${type}`)) : resolve(e)),
      });
    });
  return handle;
}

/** 杀子进程（外部 kill：数值 pid + 固定信号）。 */
export function killDaemon(handle: DaemonHandle, signal: NodeJS.Signals = "SIGKILL"): void {
  process.kill(handle.pid, signal);
}

/** 通用脚本孵化（第四轮：real-host-daemon 等非 fixture-daemon 入口共用同一 NDJSON 解析）。 */
const genericBundles = new Map<string, Promise<string>>();

export function bundleEntry(entry: string): Promise<string> {
  let cached = genericBundles.get(entry);
  if (cached === undefined) {
    cached = (async () => {
      const out = path.join(
        fs.realpathSync(os.tmpdir()),
        `at-${path.basename(entry, ".ts")}-${process.pid}.mjs`,
      );
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: out,
        logLevel: "silent",
      });
      return out;
    })();
    genericBundles.set(entry, cached);
  }
  return cached;
}

/** 孵化任意打包入口（execFile 数组参数 + 回调；ops 文件写盘传路径）。 */
export async function spawnBundled(
  entry: string,
  argvFactory: (bundle: string) => string[],
  files: Record<string, unknown> = {},
): Promise<DaemonHandle> {
  const bundle = await bundleEntry(entry);
  const argv = argvFactory(bundle);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(name, JSON.stringify(content));
  }
  return spawnRaw(argv);
}

/** execFile 孵化 + NDJSON 事件流解析（spawnDaemon/spawnBundled 共用内核）。 */
export function spawnRaw(argv: string[]): DaemonHandle {
  const handle = {} as DaemonHandle;
  const waiters: Array<{ type: string; resolve: (e: DaemonEvent) => void; timer: NodeJS.Timeout }> = [];
  const events: DaemonEvent[] = [];
  let buffer = "";

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    const child = execFile(
      process.execPath,
      argv,
      { maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err && !err.killed && err.code !== 0 && (err as unknown as { signal?: string }).signal === undefined) {
          if (stderr.length > 0) events.push({ type: "child-error", message: stderr.slice(-2000) });
        }
      },
    );
    handle.child = child;
    handle.pid = child.pid as number;
    const out = child.stdout;
    if (out !== null) out.setEncoding("utf8");
    if (out !== null) out.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line) as DaemonEvent;
          events.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].type === ev.type) {
              clearTimeout(waiters[i].timer);
              waiters[i].resolve(ev);
              waiters.splice(i, 1);
            }
          }
        } catch {
          events.push({ type: "unparsed", raw: line.slice(0, 200) });
        }
      }
    });
    child.once("exit", (code, signal) => {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve({ type: "__gone__", wanted: w.type });
      }
      waiters.length = 0;
      resolveExit({ code: code ?? null, signal: signal ?? null });
    });
  });

  handle.events = events;
  handle.exited = exited;
  handle.waitFor = (type: string, timeoutMs = 20_000) =>
    new Promise<DaemonEvent>((resolve, reject) => {
      const already = events.find((e) => e.type === type);
      if (already !== undefined) return resolve(already);
      const timer = setTimeout(() => reject(new Error(`timeout waiting daemon event: ${type}`)), timeoutMs);
      waiters.push({
        type,
        timer,
        resolve: (e) => (e.type === "__gone__" ? reject(new Error(`daemon gone before event: ${type}`)) : resolve(e)),
      });
    });
  return handle;
}

/** 标准演练事件序列生成（合法混合事件，供 ops / 剧本使用）。 */
export function standardOps(teamId: string, count: number): unknown[] {
  const ops: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const member = `m${i}`;
    ops.push({ type: "team/member", version: 2, teamId, member: { id: member, name: `w${i}`, description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } });
    ops.push({ type: "team/message/queued", version: 2, teamId, message: { id: `msg-${i}`, senderId: teamId, senderName: "lead", targetId: member, content: [{ type: "text", text: "hi" }] } });
  }
  return ops;
}
