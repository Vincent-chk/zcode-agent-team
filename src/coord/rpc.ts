// 协调者 RPC 传输层（stage-2 T2.2；接口草案 §2 的 carrier）。
// unix socket NDJSON，一请求一响应：
//   请求  { "id": <number>, "method": "<name>", "params": <unknown> }
//   响应  { "id", "ok": true, "result": … } | { "id", "ok": false,
//          "error": { "message", "code"?: <27 码子集，仅 TeamError>, "serialized"?: <cause 链> } }
// TeamError 的 code 逐字透传（不吞不改）；非 TeamError 仅透传 name/message（不贴假 code）。
//
// 协调者缺位窗口（复刻特有，原版无此窗口 → 适配项，挂 D8，见交付说明）：
// socket 不可连（ECONNREFUSED/ENOENT）时，客户端给出**明确的临时错误**（code 复用
// TEAM_DISPOSED「暂不可服务」语义 + 区分性消息），不静默丢、不假装成功：
//   `Agent Teams coordinator is unavailable (between coordinators); retry the request shortly`
//
// macOS sun_path ≈104B：显式传入超长路径 → 可读错误；正常路径经 resolveSocketPath 自动回退
// /tmp/at-<hash>.sock（见 paths.ts）。

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TeamError, serializeTeamError, isTeamError } from "../domain/errors.js";
import type { TeamErrorCode } from "../domain/errors.js";
import { discoverSocketPath } from "./paths.js";

export const COORDINATOR_UNAVAILABLE_MESSAGE =
  "Agent Teams coordinator is unavailable (between coordinators); retry the request shortly";

/** macOS sun_path 上限（含 NUL 取 104）。 */
export const SUN_PATH_LIMIT = 104;

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
  /** 可选共享凭证（server 配置了 token 时必填；防同用户其他进程误连）。 */
  token?: string;
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; name?: string; code?: TeamErrorCode; serialized?: unknown };
}

export type RpcHandler = (
  params: unknown,
  ctx: { socketPath: string; signal?: AbortSignal },
) => unknown | Promise<unknown>;

/** 单帧上限（防无换行巨帧耗尽内存）。 */
export const MAX_RPC_BUFFER_BYTES = 1 << 20;

/** 由消息限额派生帧上限（4 倍余量容纳 JSON 转义/框架字段；下限 1MiB）。 */
export function frameBudgetFor(maxMessageBytes: number): number {
  return Math.max(MAX_RPC_BUFFER_BYTES, maxMessageBytes * 4);
}

export interface ServeOptions {
  /** 单方法执行超时（默认 10s；可被 register 的按方法覆盖——wait.agent 等长等待方法需要）。 */
  callTimeoutMs?: number;
}

export interface RpcServerOptions {
  /** 单帧上限（缺省 1MiB；host 按 limits.maxMessageBytes 派生）。 */
  maxFrameBytes?: number;
  /** 可选共享凭证（缺省不校验；host 生产装配写入 teamDir/rpc.token）。 */
  token?: string;
}

/** 按方法超时注册项（第四轮新增：wait.agent 上限 3600s 不得先于服务端默认超时触发）。 */
export interface RpcMethodRegistration {
  handler: RpcHandler;
  timeoutMs?: number;
}

export class RpcServer {
  readonly socketPath: string;
  private server: net.Server | null = null;
  private socketIno: number | null = null;
  /** 活连接（close 时主动断开，防幽灵客户端阻塞关停）。 */
  private readonly clients = new Set<net.Socket>();
  private readonly handlers = new Map<string, RpcMethodRegistration>();
  private readonly maxFrameBytes: number;
  private readonly token: string | undefined;
  private nextId = 0;

  constructor(socketPath: string, opts: RpcServerOptions = {}) {
    if (socketPath.length > SUN_PATH_LIMIT) {
      throw new Error(
        `unix socket path too long for macOS (sun_path ≈${SUN_PATH_LIMIT}B, got ${socketPath.length}B): ${socketPath} — use resolveSocketPath() to fall back to a short /tmp path`,
      );
    }
    this.socketPath = socketPath;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_RPC_BUFFER_BYTES;
    this.token = opts.token;
  }

  register(method: string, handler: RpcHandler, opts: { timeoutMs?: number } = {}): this {
    this.handlers.set(method, { handler, timeoutMs: opts.timeoutMs });
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async listen(opts: ServeOptions = {}): Promise<void> {
    const callTimeoutMs = opts.callTimeoutMs ?? 10_000;
    // 活动 socket 探测：能连上 = 另一协调者仍在服务 → 拒绝抢占（不 unlink 活 socket）。
    if (fs.existsSync(this.socketPath)) {
      const active = await probeActiveSocket(this.socketPath);
      if (active) {
        throw new Error(
          `rpc socket already in use by an active coordinator: ${this.socketPath} (refusing to replace it)`,
        );
      }
      try {
        fs.unlinkSync(this.socketPath); // 残留死 socket
      } catch {
        /* 他者先清理 */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.clients.add(socket);
        // 每连接一个 close 监听器统一取消在途方法（不为每个请求叠加 once("close")）。
        const inflight = new Set<AbortController>();
        socket.once("close", () => {
          this.clients.delete(socket);
          for (const controller of inflight) controller.abort();
          inflight.clear();
        });
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > this.maxFrameBytes) {
            socket.destroy();
            return;
          }
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length === 0) continue;
            let parsed: RpcRequest;
            try {
              parsed = JSON.parse(line) as RpcRequest;
            } catch {
              socket.write(JSON.stringify({ id: -1, ok: false, error: { message: "invalid rpc frame" } }) + "\n");
              continue;
            }
            if (!this.authorized(parsed)) {
              const id = typeof parsed?.id === "number" ? parsed.id : -1;
              socket.write(JSON.stringify({ id, ok: false, error: { message: "unauthorized rpc frame" } }) + "\n");
              continue;
            }
            void this.dispatch(parsed, socket, callTimeoutMs, inflight);
          }
        });
        socket.on("error", () => socket.destroy());
      });
      server.on("error", (err) => reject(err));
      server.listen(this.socketPath, () => {
        this.server = server;
        try {
          // SF12：socket 仅本用户可连；inode 用于 close 时只清理自己创建的 socket。
          fs.chmodSync(this.socketPath, 0o600);
          this.socketIno = fs.statSync(this.socketPath).ino;
        } catch (err) {
          // fail-closed：无法收紧权限 / 无法记录 inode → 关闭并拒绝服务（不静默降级）。
          this.server = null;
          try {
            server.close();
          } catch {
            /* best-effort */
          }
          reject(
            new Error(
              `rpc socket hardening failed for ${this.socketPath}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    const ino = this.socketIno;
    this.socketIno = null;
    // Node 在 server.close() 时按**路径** unlink socket（libuv 行为，不受我们控制）。
    // 若路径已被接任者替换（inode 不符），先把替换文件挪到 quarantine，close 后原样归还：
    // 旧协调者延迟 close 不得删掉接任者的活动 socket。挪动只影响新连接窗口（<1 tick），
    // 已建立的连接绑定 inode，不受影响。
    // 先断开所有客户端：server.close() 会等待活连接自行结束，幽灵/挂起客户端不得阻塞关停。
    for (const client of this.clients) {
      try {
        client.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.clients.clear();
    let preserve: { quarantine: string } | null = null;
    if (ino !== null) {
      try {
        if (fs.statSync(this.socketPath).ino !== ino) {
          const quarantine = `${this.socketPath}.preserve-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
          fs.renameSync(this.socketPath, quarantine);
          preserve = { quarantine };
        }
      } catch {
        /* 路径不存在/无法检查 → 交给 close（ENOENT 由 Node 内部忽略） */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (preserve !== null) {
      try {
        fs.renameSync(preserve.quarantine, this.socketPath);
      } catch (err) {
        // 还原失败 = 接任者 socket 路径丢失：显式告警（不静默）。
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            scope: "rpc",
            msg: "failed to restore preserved socket path",
            socketPath: this.socketPath,
            quarantine: preserve.quarantine,
            error: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
      }
    }
  }

  private authorized(req: RpcRequest): boolean {
    if (this.token === undefined) return true;
    const provided = typeof req?.token === "string" ? req.token : "";
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async dispatch(
    req: RpcRequest,
    socket: net.Socket,
    callTimeoutMs: number,
    inflight: Set<AbortController>,
  ): Promise<void> {
    const respond = (res: RpcResponse) => {
      if (!socket.destroyed) socket.write(JSON.stringify(res) + "\n");
    };
    const id = typeof req?.id === "number" ? req.id : -1;
    const registered = this.handlers.get(req?.method);
    if (registered === undefined) {
      respond({ id, ok: false, error: { message: `unknown rpc method: ${String(req?.method)}` } });
      return;
    }
    const timeoutMs = registered.timeoutMs ?? callTimeoutMs;
    const abort = new AbortController();
    inflight.add(abort);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      respond({ id, ok: false, error: { message: `rpc method ${req.method} timed out after ${timeoutMs}ms` } });
      abort.abort();
    }, timeoutMs);
    try {
      const result = await registered.handler(req.params, {
        socketPath: this.socketPath,
        signal: abort.signal,
      });
      if (!settled) {
        settled = true;
        respond({ id, ok: true, result });
      }
    } catch (err) {
      if (settled) return;
      if (isTeamError(err)) {
        respond({
          id,
          ok: false,
          error: { message: err.message, code: err.code, serialized: serializeTeamError(err) },
        });
      } else {
        respond({
          id,
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
        });
      }
    } finally {
      clearTimeout(timer);
      inflight.delete(abort);
    }
  }
}

/** 示例方法桩（journal 级演练用 example-only：team.append 与 team.state 直通 journal，绕过服务层）。
 *  真方法表（member、message.send、task、board.read、wait.agent、admin.reconcile 各方法）见
 *  methods.ts 的 registerTeamMethods——由 host.ts 装配；fixture daemon 仅为崩溃点注入保留示例通道。 */
export function registerExampleMethods(
  server: RpcServer,
  deps: { coordinatorBootId: () => string; stateRevision: () => number },
): RpcServer {
  server.register("coordinator.hello", () => ({
    coordinatorBootId: deps.coordinatorBootId(),
    stateRevision: deps.stateRevision(),
  }));
  server.register("admin.reconcile", () => ({
    example: true,
    note: "example-only surface; the real admin.reconcile is registered by registerTeamMethods (src/coord/methods.ts) on the coordinator host",
  }));
  return server;
}

// ---------------------------------------------------------------- 客户端

export interface ConnectOptions {
  timeoutMs?: number;
  /** 可选共享凭证（server 配置了 token 时必填）。 */
  token?: string;
  /** 响应帧上限（缺省 1MiB）。 */
  maxFrameBytes?: number;
}

export class RpcClient {
  private readonly maxFrameBytes: number;
  private constructor(
    private readonly socket: net.Socket,
    private readonly token: string | undefined = undefined,
    private nextId = 1,
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>(),
    maxFrameBytes = MAX_RPC_BUFFER_BYTES,
  ) {
    this.maxFrameBytes = maxFrameBytes;
  }

  static async connect(socketPath: string, opts: ConnectOptions = {}): Promise<RpcClient> {
    const timeoutMs = opts.timeoutMs ?? 3_000;
    const socket: net.Socket = await new Promise((resolve, reject) => {
      const s = net.connect(socketPath, () => resolve(s));
      s.setEncoding("utf8");
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`rpc connect timeout after ${timeoutMs}ms: ${socketPath}`));
      }, timeoutMs);
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      resolveSocketOnConnect(s, () => clearTimeout(timer));
    });
    const client = new RpcClient(socket, opts.token, 1, new Map(), opts.maxFrameBytes);
    socket.on("data", (chunk: string) => client.onData(chunk));
    socket.on("close", () => client.failAll(new Error("rpc connection closed")));
    socket.on("error", (err) => client.failAll(err));
    return client;
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (opts.signal?.aborted) {
      return Promise.reject(
        new TeamError("TEAM_WAIT_ABORTED", `wait_agent aborted: ${abortReasonText(opts.signal.reason)}`),
      );
    }
    const payload =
      JSON.stringify({ id, method, params, ...(this.token !== undefined ? { token: this.token } : {}) }) + "\n";
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      const onAbort = (): void => {
        finish(() =>
          reject(new TeamError("TEAM_WAIT_ABORTED", `wait_agent aborted: ${abortReasonText(opts.signal?.reason)}`)),
        );
        this.socket.destroy();
      };
      timer = setTimeout(() => {
        finish(() => reject(new Error(`rpc call ${method} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => finish(() => resolve(v as T)),
        reject: (e) => finish(() => reject(e)),
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.socket.write(payload, (err) => {
        if (err) finish(() => reject(err));
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      // 超限帧：断开并让所有在途请求显式失败（不静默丢）。
      this.failAll(new Error(`rpc response frame exceeds ${this.maxFrameBytes} bytes`));
      this.socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      try {
        this.onResponse(JSON.parse(line) as RpcResponse);
      } catch {
        this.failAll(new Error("invalid rpc response frame"));
      }
    }
  }

  private buffer = "";

  private onResponse(res: RpcResponse): void {
    const entry = this.pending.get(res.id);
    if (entry === undefined) return;
    this.pending.delete(res.id);
    if (res.ok) {
      entry.resolve(res.result);
    } else if (res.error?.code !== undefined) {
      // TeamError 透传（code 不吞不改）
      entry.reject(new TeamError(res.error.code, res.error.message));
    } else {
      const err = new Error(res.error?.message ?? "rpc error");
      if (res.error?.name) err.name = res.error.name;
      entry.reject(err);
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}

function resolveSocketOnConnect(socket: net.Socket, onConnected: () => void): void {
  socket.once("connect", onConnected);
}

/** 探测 socket 是否有活服务（连接成功 = 活；ECONNREFUSED/ENOENT/超时 = 死）。 */
function probeActiveSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** RPC 共享凭证文件（teamDir/rpc.token；0600）。读取失败 → undefined（未启用）。 */
export function rpcTokenPath(teamDir: string): string {
  return path.join(teamDir, "rpc.token");
}

export function readRpcToken(teamDir: string): string | undefined {
  try {
    const token = fs.readFileSync(rpcTokenPath(teamDir), "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function writeRpcToken(teamDir: string, token: string): void {
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(rpcTokenPath(teamDir), token + "\n", { mode: 0o600 });
}

export function newRpcToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

// ---------------------------------------------------------------- 协调者寻址与缺位窗口

/** 缺位窗口临时错误（TEAM_DISPOSED 复用 + 区分性消息；适配项挂 D8，登记见交付说明）。 */
export function coordinatorUnavailableError(detail?: string): TeamError {
  return new TeamError("TEAM_DISPOSED", COORDINATOR_UNAVAILABLE_MESSAGE, { cause: detail });
}

export interface CoordinatorCallOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}

function abortReasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (reason === undefined || reason === null) return "aborted";
  return String(reason);
}

/**
 * 面向协调者的调用：发现 socket → 连接 → 一请求一响应。
 * 连接失败（ECONNREFUSED/ENOENT 等）= 协调者缺位窗口 → coordinatorUnavailableError（可重试指引）。
 * 「成员 daemon 代理全部变更、只读本地重放」的形态：变更走本函数，只读走 replay.load。
 */
export async function callCoordinator<T = unknown>(
  teamDir: string,
  teamId: string,
  method: string,
  params?: unknown,
  opts: CoordinatorCallOptions = {},
): Promise<T> {
  void teamId; // socket 寻址按 teamDir；teamId 留给服务轮次的方法路由
  const socketPath = discoverSocketPath(teamDir);
  // 共享凭证（存在即携带；缺失 = 旧版协调者/测试环境，保持兼容）。
  const token = readRpcToken(teamDir);
  const client = await RpcClient.connect(socketPath, {
    timeoutMs: opts.connectTimeoutMs ?? 1_000,
    ...(token !== undefined ? { token } : {}),
  }).catch((err: NodeJS.ErrnoException) => {
    throw coordinatorUnavailableError(`socket ${socketPath}: ${err.code ?? err.message}`);
  });
  try {
    return await client.call<T>(method, params, {
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } finally {
    client.close();
  }
}

/** 指数退避重试（客户端重连/缺位窗口重试共用；deadline 到 → 抛最后一次错误）。 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs: number; baseMs?: number; maxMs?: number; onRetry?: (attempt: number, err: Error) => void },
): Promise<T> {
  const baseMs = opts.baseMs ?? 100;
  const maxMs = opts.maxMs ?? 1_000;
  const deadline = Date.now() + opts.deadlineMs;
  let attempt = 0;
  let lastError: Error | undefined;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (Date.now() >= deadline) throw lastError;
      opts.onRetry?.(attempt, lastError);
      const delay = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 8));
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(deadline - Date.now(), 1))));
    }
  }
}
