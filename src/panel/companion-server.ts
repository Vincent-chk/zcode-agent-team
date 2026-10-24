// T5.5 伴生面板 HTTP 服务（可选高保真载体；CLI 降级链的高保真路径）。
// 纪律（规划 T5.5 + Mimosa）：
//  - 仅本地回环 127.0.0.1，端口 0（随机分配）；会话 token = crypto.randomBytes（每 daemon
//    进程一枚；仅内存 + dataRoot 内注册文件 0600；无凭据字面量）；
//  - 无 token / token 不符 → 403（零信息泄漏）；
//  - 随处置关停（daemon SIGINT/exit → close()：SSE 断开 + 注册文件删除 + server.close）；
//  - 数据 = SSE 推视图帧（同源 PanelViewService；contentKey 去抖 = 全量视图广播口径）；
//    detail/refresh 下钻 = POST /api/call → handlePanelCall（面板同一回环语义，只读）。
// 路径纪律：页面/注册文件路径由调用方（daemon，__dirname/DATA 常量）注入；注册文件写入前
// 校验必须位于 dataRoot 内（拒绝穿越）。
// 入口：team-ctl open-panel（读 logs/panel-http.json → 打印/打开 URL）。

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PanelViewService } from "./view-service.js";
import { handlePanelCall, type PanelCallArgs, type PanelCallDeps } from "./panel-call.js";
import type { CallMeta } from "../mcp/identity.js";

export interface CompanionServerDeps {
  dataRoot: string;
  view: PanelViewService;
  /** handlePanelCall 依赖（reader/bumpCounter/now/warn；view/dataRoot/bootTimeMs 由本模块补全）。 */
  panelCall: Pick<PanelCallDeps, "bootTimeMs" | "reader" | "bumpCounter" | "now" | "warn">;
  /** 伴生页面 HTML 文件（构建产物 dist/ui/team-companion.html；daemon 以 __dirname 注入）。 */
  pageFile: string;
  /** 当前锚定会话（team://view 同口径：最近活跃 callTool 的 _meta.session_id）。 */
  anchoredSession: () => string | null;
  warn?: (message: string) => void;
}

export interface CompanionServer {
  url(): string;
  port(): number;
  close(): Promise<void>;
}

/** 注册文件相对 dataRoot 的固定位置（team-ctl open-panel 发现入口；常量，无动态片段）。 */
export const COMPANION_REGISTRY_RELPATH = "logs/panel-http.json";

/** SSE 轮询间隔（与 team://view 推帧同预算：变化到达 ≤1s）。 */
const SSE_POLL_MS = 500;

/** 注册文件路径（校验在 dataRoot 内，防 dataRoot 被注入穿越形态）。 */
export function companionRegistryFile(dataRoot: string): string {
  const root = path.resolve(dataRoot);
  const file = path.join(root, COMPANION_REGISTRY_RELPATH);
  if (file !== path.join(root, "logs", "panel-http.json")) {
    throw new Error("companion registry path escapes dataRoot");
  }
  return file;
}

export async function startCompanionServer(deps: CompanionServerDeps): Promise<CompanionServer> {
  const token = crypto.randomBytes(16).toString("hex");
  const registryFile = companionRegistryFile(deps.dataRoot);
  const sseClients = new Set<http.ServerResponse>();
  /** 写缓冲已满（write 返回 false）的客户端：跳过后续帧，drain 后恢复。 */
  const backpressured = new Set<http.ServerResponse>();
  let lastKey = "";
  let lastAnchor: string | null = null;
  /** single-flight：轮询/首帧并发时只允许一次构帧；期间标记 dirty 补跑。 */
  let pushInFlight: Promise<void> | null = null;
  let pushDirty = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const server = http.createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 仅回环（listen 已绑定 127.0.0.1；socket 地址复核 = 双保险）
    const remote = req.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reqToken = url.searchParams.get("token") ?? headerToken(req);
    // 定时比较（token 长度不泄漏）；缺 token → 403
    if (reqToken === null || !timingSafeEqualStr(reqToken, token)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if ((url.pathname === "/" || url.pathname === "/panel") && (req.method === "GET" || req.method === "HEAD")) {
      servePage(res);
      return;
    }
    if (url.pathname === "/events" && req.method === "GET") {
      serveSse(req, res);
      return;
    }
    if (url.pathname === "/api/call" && req.method === "POST") {
      await serveApiCall(req, res);
      return;
    }
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  function headerToken(req: http.IncomingMessage): string | null {
    const h = req.headers["x-team-token"];
    return typeof h === "string" ? h : null;
  }

  function servePage(res: http.ServerResponse): void {
    try {
      const html = fs.readFileSync(deps.pageFile, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`companion page unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function serveSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    res.on("drain", () => backpressured.delete(res));
    req.on("close", () => {
      sseClients.delete(res);
      backpressured.delete(res);
      if (sseClients.size === 0 && pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
    ensurePolling();
    void pushFrame(true); // 立即推一帧（首屏）
  }

  function ensurePolling(): void {
    if (pollTimer !== null || closed) return;
    pollTimer = setInterval(() => void pushFrame(false), SSE_POLL_MS);
    pollTimer.unref?.();
  }

  async function pushFrame(force: boolean): Promise<void> {
    if (closed) return;
    if (pushInFlight !== null) {
      pushDirty = true;
      return pushInFlight;
    }
    pushInFlight = (async () => {
      try {
        do {
          pushDirty = false;
          await pushOnce(force);
          force = false; // 只有本轮首个请求是强制首帧
        } while (pushDirty && !closed);
      } catch (err) {
        deps.warn?.(`companion sse push failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pushInFlight = null;
      }
    })();
    return pushInFlight;
  }

  async function pushOnce(force: boolean): Promise<void> {
    if (closed) return;
    const sessionId = deps.anchoredSession();
    if (sessionId === null) {
      lastAnchor = null;
      return;
    }
    if (sseClients.size === 0) return;
    const frame = await deps.view.buildFrame({ session_id: sessionId });
    // 构帧期间锚点已切走 → 丢弃旧会话帧（session 配对；不得串台广播）。
    if (deps.anchoredSession() !== sessionId) {
      pushDirty = true;
      return;
    }
    const key = deps.view.contentKey(frame);
    const anchorChanged = lastAnchor !== sessionId;
    if (!force && !anchorChanged && key === lastKey) return; // mailbox-only/无变化 → 不推帧（F02 同构）
    lastAnchor = sessionId;
    lastKey = key;
    const payload = `event: view\ndata: ${JSON.stringify(frame)}\n\n`;
    for (const client of [...sseClients]) {
      if (client.writableEnded || backpressured.has(client)) continue;
      if (!client.write(payload)) backpressured.add(client); // 背压：等 drain 再续
    }
  }

  async function serveApiCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > 8192) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { message: "request body too large" } }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let args: PanelCallArgs = {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null) args = parsed as PanelCallArgs;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "invalid json body" } }));
      return;
    }
    const sessionId = deps.anchoredSession();
    const meta: CallMeta | undefined = sessionId !== null ? { session_id: sessionId } : undefined;
    const result = await handlePanelCall(
      { ...deps.panelCall, view: deps.view, dataRoot: deps.dataRoot },
      args,
      meta,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/panel?token=${token}`;

  // 注册文件（0600，含 token → 仅本用户可读；open-panel 发现入口）
  try {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const tmp = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ port: addr.port, token, pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, registryFile);
  } catch (err) {
    deps.warn?.(`companion registry write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    url: () => url,
    port: () => addr.port,
    close: async () => {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      for (const client of sseClients) client.end();
      sseClients.clear();
      try {
        const current = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { pid?: number };
        if (current.pid === process.pid) fs.unlinkSync(registryFile);
      } catch {
        /* 注册文件已不在 → 无需清理 */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 定时安全比较（长度不等直接 false，不泄漏长度信息以外的内容）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
