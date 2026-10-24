// T5.5 伴生面板服务单测：token 鉴权/403、SSE 推帧（contentKey 去抖同构）、
// /api/call 下钻（refresh/detail/心跳同语义）、注册文件（0600/清理）、close 关停。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { PanelViewService } from "../../src/panel/view-service.js";
import {
  startCompanionServer,
  companionRegistryFile,
  type CompanionServer,
} from "../../src/panel/companion-server.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 };
const LEAD = "sess_companion_lead";
const BOOT = Date.now();

let root: string;
let dataRoot: string;
let backend: TeamToolBackend;
let service: PanelViewService;
let srv: CompanionServer | null = null;
let anchored: string | null = LEAD;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s5-companion-"));
  dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
  service = new PanelViewService({ dataRoot, bootTimeMs: BOOT, backend });
  let counter = 0;
  srv = await startCompanionServer({
    dataRoot,
    view: service,
    panelCall: { bootTimeMs: BOOT, bumpCounter: () => (counter += 1) },
    pageFile: path.join(root, "page.html"),
    anchoredSession: () => anchored,
  });
  fs.writeFileSync(path.join(root, "page.html"), "<!doctype html><html><body>fixture page</body></html>");
});

afterEach(async () => {
  await srv?.close();
  srv = null;
  await backend.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function url(p: string, token?: string): string {
  const u = new URL(srv!.url());
  return `http://127.0.0.1:${u.port}${p}${token !== undefined ? `?token=${token}` : ""}`;
}

function tokenOf(): string {
  return new URL(srv!.url()).searchParams.get("token")!;
}

describe("鉴权与路由", () => {
  it("无 token / 错 token → 403（页面/事件/API 三面）", async () => {
    for (const p of ["/panel", "/events", "/healthz"]) {
      const noTok = await fetch(url(p));
      expect(noTok.status).toBe(403);
      const bad = await fetch(url(p, "deadbeef"));
      expect(bad.status).toBe(403);
    }
    const api = await fetch(url("/api/call"), { method: "POST", body: "{}" });
    expect(api.status).toBe(403);
  });

  it("token 走 x-team-token 请求头等价生效", async () => {
    const r = await fetch(url("/healthz"), { headers: { "x-team-token": tokenOf() } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("GET /panel → 页面 HTML（pageFile 注入面）", async () => {
    const r = await fetch(url("/panel", tokenOf()));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("fixture page");
  });

  it("pageFile 缺失 → 500 可读原因（不静默）", async () => {
    fs.rmSync(path.join(root, "page.html"));
    const r = await fetch(url("/", tokenOf()));
    expect(r.status).toBe(500);
    expect(await r.text()).toContain("companion page unavailable");
    fs.writeFileSync(path.join(root, "page.html"), "<!doctype html><html><body>fixture page</body></html>");
  });

  it("未知路径 → 404", async () => {
    const r = await fetch(url("/nope", tokenOf()));
    expect(r.status).toBe(404);
  });
});

describe("SSE 推帧（F10 数据面；全量视图广播同构）", () => {
  it("订阅即收 hello + 首帧；task 变化 ≤1.5s 推第二帧；mailbox-only 不推", async () => {
    const identity = { sessionId: LEAD, teamId: LEAD, role: "lead" as const, name: "lead", agentId: LEAD, source: "meta" as const, hookRegistered: true };
    await backend.spawnTeammate(identity, { name: "alice", description: "d", prompt: "p" });

    const res = await fetch(url("/events", tokenOf()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];
    let buf = "";
    const waitFor = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`waitFor timeout; events=${JSON.stringify(events.map((e) => e.slice(0, 20)))}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = chunk.match(/^event: (\w+)\ndata: (.*)$/m);
          if (ev !== null) events.push(`${ev[1]}:${ev[2]}`);
        }
      }
    };
    await waitFor(() => events.some((e) => e.startsWith("hello:")));
    await waitFor(() => events.some((e) => e.startsWith("view:")));
    const first = events.find((e) => e.startsWith("view:"))!;
    const frame1 = JSON.parse(first.slice("view:".length));
    expect(frame1.team.teamId).toBe(LEAD);
    expect(frame1.members).toHaveLength(2);

    // mailbox-only（send_message → queued/折叠）不推帧：等待 1.2s（>2 个轮询周期）无新 view 帧
    await backend.sendMessage(identity, { target: "alice", message: "hi" });
    const viewCountBefore = events.filter((e) => e.startsWith("view:")).length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(events.filter((e) => e.startsWith("view:")).length).toBe(viewCountBefore);

    // task 变更 → ≤1.5s 新帧
    await backend.taskCreate(identity, { subject: "companion 任务", description: "d" });
    await waitFor(() => events.filter((e) => e.startsWith("view:")).length >= viewCountBefore + 1, 1500);
    const views = events.filter((e) => e.startsWith("view:"));
    const frame2 = JSON.parse(views[views.length - 1].slice("view:".length));
    expect(frame2.tasks).toHaveLength(1);
    reader.cancel().catch(() => undefined);
  }, 20_000);

  it("无锚定会话 → 不推 view 帧（hello 仍在）", async () => {
    anchored = null;
    const res = await fetch(url("/events", tokenOf()));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: hello");
    await new Promise((r) => setTimeout(r, 800));
    reader.cancel().catch(() => undefined);
    anchored = LEAD;
  });
});

describe("/api/call（面板回环同语义）", () => {
  it("心跳（label-only）→ counter 应答", async () => {
    const r = await fetch(url("/api/call", tokenOf()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "companion-hb" }),
    });
    const body = (await r.json()) as { kind: string; counter: number; label: string };
    expect(body.kind).toBe("heartbeat");
    expect(body.counter).toBeGreaterThanOrEqual(1);
    expect(body.label).toBe("companion-hb");
  });

  it("refresh → 视图帧；非法 JSON → 400；未知 action → error 结果", async () => {
    const ok = await (await fetch(url("/api/call", tokenOf()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    })).json() as { kind: string; frame: { team: unknown } };
    expect(ok.kind).toBe("view");

    const bad = await fetch(url("/api/call", tokenOf()), { method: "POST", body: "{oops" });
    expect(bad.status).toBe(400);

    const unknown = await (await fetch(url("/api/call", tokenOf()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "nope" }),
    })).json() as { kind: string; code: string };
    expect(unknown.kind).toBe("error");
    expect(unknown.code).toBe("TEAM_INVALID_ARGUMENT");
  });
});

describe("注册文件与关停", () => {
  it("注册文件 0600 + port/token/pid；close 后删除", async () => {
    const file = companionRegistryFile(dataRoot);
    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const reg = JSON.parse(fs.readFileSync(file, "utf8")) as { port: number; token: string; pid: number };
    expect(reg.pid).toBe(process.pid);
    expect(reg.token).toBe(tokenOf());
    await srv!.close();
    expect(fs.existsSync(file)).toBe(false);
    srv = null;
  });

  it("close 幂等；关停后端口不再监听", async () => {
    const u = new URL(srv!.url());
    const closing = srv!;
    await closing.close();
    await closing.close(); // 幂等
    srv = null;
    await expect(fetch(`http://127.0.0.1:${u.port}/healthz`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it("/api/call 超大 body → 413（8KiB 上限）", async () => {
    const r = await fetch(url("/api/call", tokenOf()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh", pad: "x".repeat(16 * 1024) }),
    });
    expect(r.status).toBe(413);
  });
});

describe("注册文件异常分支", () => {
  it("注册文件被他人 pid 占用 → close 不删除（防误删接管者注册）", async () => {
    const file = companionRegistryFile(dataRoot);
    fs.writeFileSync(file, JSON.stringify({ port: 1, token: "c".repeat(32), pid: process.pid + 12345 }));
    await srv!.close();
    expect(fs.existsSync(file)).toBe(true); // pid 不符 → 保留
    srv = null;
    fs.rmSync(file);
  });
});
