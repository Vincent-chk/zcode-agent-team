// ZCode app-server 最小 NDJSON 客户端（stage-6 会话隔离生产资产；纯 Node 脚本）。
// 协议事实（stage-1 PoC 实测定版）：请求 {id, method, params}（无 jsonrpc 键）；
// 通知 {method, params}；响应 {id, result|error}；启动阶段 server 先推 startup/storageState。
// 孵化形态沿用工程纪律（procgroup.ts / detach-helper.mjs）：execFile 回调形态 + 参数数组 +
// `--` 终止符，无 shell 参与；可执行文件为已解析的绝对路径，app-server 由桥接器按 spec 拉起。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_DEFAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), "app-server-bridge.mjs");

export class AppServerClient {
  #child;
  #specFile;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #notifications = [];
  #stderr = "";
  #closed = false;
  #exited = false;
  #log;

  constructor(opts) {
    this.#log = opts.log;
    const specDir = fs.mkdtempSync(path.join(os.tmpdir(), "at-appserver-"));
    try {
      fs.chmodSync(specDir, 0o700);
    } catch {
      /* best-effort */
    }
    this.#specFile = path.join(specDir, "spec.json");
    // env 不写 spec：经 execFile 的进程环境传给 bridge，由 bridge 原样传给 app-server。
    fs.writeFileSync(
      this.#specFile,
      JSON.stringify({
        executable: opts.executable,
        argv: [...opts.argvPrefix, "app-server"],
        cwd: opts.cwd,
      }),
      { mode: 0o600 },
    );
    const bridge = process.env.TEAM_APP_SERVER_BRIDGE ?? BRIDGE_DEFAULT;
    this.#child = execFile(
      process.execPath,
      ["--", bridge, this.#specFile],
      { cwd: opts.cwd, timeout: 0, maxBuffer: 8 * 1024 * 1024, env: opts.env ?? process.env },
      (err) => {
        this.#exited = true;
        const error = err ?? new Error("app-server exited");
        for (const [, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.#pending.clear();
      },
    );
    this.#child.stdout?.on("data", (chunk) => this.#onStdout(String(chunk)));
    this.#child.stderr?.on("data", (chunk) => {
      this.#stderr += String(chunk);
      if (this.#stderr.length > 32_000) this.#stderr = this.#stderr.slice(-32_000);
    });
    this.#child.on("exit", () => {
      this.#exited = true;
    });
  }

  /** 校验可执行文件为绝对路径后启动（相对路径/空串一律拒绝）。 */
  static spawn(opts) {
    if (typeof opts.executable !== "string" || !path.isAbsolute(opts.executable)) {
      throw new Error("app-server executable must be an absolute path");
    }
    return new AppServerClient(opts);
  }

  #onStdout(text) {
    this.#buffer += text;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === "number" && this.#pending.has(message.id)) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) {
          const error = new Error(message.error.message ?? "app-server rpc error");
          error.rpc = message.error;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === "string") {
        this.#notifications.push({ method: message.method, params: message.params });
        // server→client 请求：必须应答，否则启动可能挂起。
        // server→client 请求：id 可能是 number 或 string，必须原样回同一个 id
        if (message.id !== undefined && message.id !== null) {
          const result =
            message.method === "session/requestRuntimePreferences"
              ? {
                  nativeSearchEnhancementsEnabled: true,
                  memoryEnabled: false,
                  askUserQuestionAutoResolutionEnabled: true,
                }
              : null;
          this.#write({ id: message.id, result });
        }
      }
    }
  }

  #write(message) {
    if (this.#closed || this.#child.stdin === null || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 等待 startup/storageState ready（超时返回 false，不抛错）。 */
  async waitReady(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        this.#notifications.some(
          (n) => n.method === "startup/storageState" && n.params?.phase === "ready",
        )
      ) {
        return true;
      }
      if (this.#exited) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  rpc(method, params, timeoutMs = 30_000) {
    if (this.#closed) return Promise.reject(new Error("app-server client is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`app-server rpc timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  getStderr() {
    return this.#stderr;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("app-server client closed"));
    }
    this.#pending.clear();
    try {
      this.#child.stdin?.end();
    } catch {
      /* ignore */
    }
    if (!this.#exited) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            this.#child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 1_500);
        timer.unref?.();
        this.#child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      fs.rmSync(path.dirname(this.#specFile), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.#log?.({ event: "app-server-closed", stderrTail: this.#stderr.slice(-800) });
  }
}
