// agent-team Team Daemon
// 职责：① MCP 工具面（9 个团队工具 + 诊断 team_ping + 面板回环 team_panel_call）
//      ② ui:// 资源 + resources/subscribe 推帧（MCP Apps 面板数据源；single-flight + 会话代际）
//      ③ 冷启动自检（node 版本/配置校验/持久状态恢复）+ 信号日志
//      ④ 可选伴生面板（127.0.0.1 + token；SSE 推帧）
// 纪律：stdout 只走 MCP 协议，日志一律 stderr / 文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Server,
} from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import {
  dataDir,
  ensureDir,
  ensurePrivateDir,
  logsDir,
  appendJsonl,
  loadConfig,
  logErr,
  ts,
  PLUGIN_ID,
  writeRuntimeConfig,
  cleanupStaleSpecs,
  pruneMetaFiles,
  redactToolArguments,
  sanitizeToolName,
  metaFilePath,
} from "./shared.js";
import { validateLeadMode } from "./domain/config.js";
import { TeamToolBackend } from "./mcp/backend.js";
import { DEFAULT_HOST_LIMITS } from "./coord/host.js";
import { callTeamTool, isTeamTool, listTeamTools } from "./mcp/registry.js";
import { ResumePerTurnProvider } from "./provider/resume-provider.js";
import { isolationModeFromEnv } from "./provider/session-breeder.js";
import { PanelViewService } from "./panel/view-service.js";
import { handlePanelCall } from "./panel/panel-call.js";
import { startCompanionServer, type CompanionServer } from "./panel/companion-server.js";
import { TranscriptReader } from "./provider/transcript.js";
import { emptyViewFrame, type ViewFrame } from "./ui-core/view.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEW_URI = "team://view";
const PANEL_URI = "ui://agent-team/team-panel.html";
const NODE_MIN = 22;
/** 进程启动时刻（身份解析 hook 映射兜底的时间窗锚点；T3.1）。 */
const BOOT_TIME_MS = Date.now();


// —— F17 自检：node 版本
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeWarn =
  nodeMajor < NODE_MIN
    ? `agent-team daemon 需要 Node >= ${NODE_MIN}（当前 ${process.versions.node}），面板与工具可能不可用。请安装 Node 22+。`
    : null;

// —— 数据目录 + 启动日志（冷启动 = 常态；此处将来挂全量重放）
const DATA = dataDir();
ensurePrivateDir(DATA);
ensurePrivateDir(path.join(DATA, "logs"));
ensurePrivateDir(path.join(DATA, "meta"));
ensurePrivateDir(path.join(DATA, "session-map"));
// 清理崩溃窗口遗留的 spec（含真实 env）与过期 per-call meta；失败不阻断启动。
const staleSpecs = cleanupStaleSpecs(DATA);
const prunedMeta = pruneMetaFiles(DATA);
appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
  event: "startup",
  ts: ts(),
  pid: process.pid,
  node: process.versions.node,
  execPath: process.execPath,
  nodeWarn,
  staleSpecsRemoved: staleSpecs,
  metaFilesPruned: prunedMeta,
  cwd: process.cwd(),
  teamEnv: {
    TEAM_PLUGIN_DATA: process.env.TEAM_PLUGIN_DATA,
    TEAM_PROJECT_DIR: process.env.TEAM_PROJECT_DIR,
    TEAM_PLUGIN_ROOT: process.env.TEAM_PLUGIN_ROOT,
    ZCODE_SESSION_ID: process.env.ZCODE_SESSION_ID, // 预期 undefined：env 不注入会话 id（已定案）
    TEAM_MAX_MEMBERS: process.env.TEAM_MAX_MEMBERS,
  },
});
if (nodeWarn) logErr("daemon", nodeWarn);

const config = loadConfig();
if (!config.ok) {
  logErr("daemon", config.error!);
  appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
    event: "invalid-config",
    ts: ts(),
    error: config.error,
  });
}

// —— stage-3 工具面后端（冷启动即服务：不预热；首调按 teamId 惰性 open host）。
// 限额 = daemon env 校验值（config.values；非法配置时退回 host 缺省——工具调用本身
// 已被 config.ok=false 分支拦截，此处仅为类型完整性）。
// 〔对齐轮〕0.2.1 D3：interrupt 开关（env TEAM_INTERRUPT，默认 true；"false" → 8 工具）。
// —— stage-4：真 provider（ResumePerTurnProvider，ADR-4 主实现）按 teamId 构造；
// provider.jsonl 结构化日志（V03：teamId/memberId/messageId 关联字段肉眼可串联）。
// stage-6：teammate 会话隔离（child=宿主原生隐藏子会话，默认；legacy=旧顶层会话，回滚用）。
const interruptEnabled = (process.env.TEAM_INTERRUPT ?? "true") !== "false";
// 〔stage-6.5 D26〕leadMode（env TEAM_LEAD_MODE，默认 orchestrator）：宽松回落，非法值 warn 但不禁工具面。
const leadModeRaw = process.env.TEAM_LEAD_MODE;
const leadMode = validateLeadMode(leadModeRaw);
if (leadModeRaw !== undefined && leadModeRaw !== "orchestrator" && leadModeRaw !== "collaborator") {
  logErr("daemon", `invalid TEAM_LEAD_MODE ${JSON.stringify(leadModeRaw)} — falling back to "${leadMode}"`);
}
if (config.ok) {
  // hooks 读不到 userConfig：把有效开关落盘，SessionStart 注入按同一配置插值（D19/D26）。
  writeRuntimeConfig({ interrupt: interruptEnabled, leadMode, limits: config.values! });
}
const sessionIsolation = isolationModeFromEnv();
const providerLog = (record: Record<string, unknown>) =>
  appendJsonl(path.join(DATA, "logs", "provider.jsonl"), record);
const backend = new TeamToolBackend({
  dataRoot: DATA,
  limits: config.ok ? config.values! : DEFAULT_HOST_LIMITS,
  interrupt: interruptEnabled,
  providerFactory: (teamId) =>
    new ResumePerTurnProvider({
      dataRoot: DATA,
      teamId,
      cwd: process.env.TEAM_PROJECT_DIR,
      sessionIsolation,
      log: providerLog,
    }),
  warn: (m) => logErr("backend", m),
});
appendJsonl(path.join(DATA, "logs", "provider.jsonl"), {
  event: "session-isolation-mode",
  mode: sessionIsolation,
  ts: ts(),
  pid: process.pid,
});


// —— H10：信号时序日志。signal-test 控制文件存在时忽略 SIGINT/SIGTERM（观察宿主升级到 SIGKILL 的时序）；
//      默认（生产形态）SIGINT 即优雅退出。
//      stage-3 演进（披露）：退出前尽力限时（≤200ms）关闭工具面后端（journal checkpoint +
//      锁释放）；H10 实测 SIGINT→SIGTERM 仅 ~260ms，宽限不足由冷启动对账兜底（D9 口径）。
const signalTestMode = fs.existsSync(path.join(DATA, "signal-test"));
const signalLog = path.join(DATA, "logs", "signals.jsonl");
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    appendJsonl(signalLog, { sig, ts: ts(), pid: process.pid, mode: signalTestMode ? "observe" : "graceful" });
    logErr("daemon", `signal ${sig} received`);
    if (signalTestMode) return;
    // D9 触发点①：SIGINT→SIGTERM 仅 ~260ms（H10 实测）→ 处置裁剪为「轻量落盘 + drain 标记」
    // （drainPolicy=keep 默认）；余量交触发点②（下次冷启动恢复对账兜底）。结果记 lifecycle 日志（F14）。
    const deadline = setTimeout(() => {
      appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
        event: "dispose-timeout",
        ts: ts(),
        sig,
        pid: process.pid,
      });
      process.exit(0);
    }, 200);
    backend
      .close()
      .then(() => (companion !== null ? companion.close() : undefined))
      .then(() => {
        appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
          event: "dispose-ok",
          ts: ts(),
          sig,
          pid: process.pid,
        });
      })
      .catch((err: unknown) => {
        appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
          event: "dispose-failed",
          ts: ts(),
          sig,
          pid: process.pid,
          error: err instanceof AggregateError ? `${err.message}: ${err.errors.map((e) => String(e)).join("; ")}` : String(err),
        });
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  });
}
process.on("exit", (code) => {
  appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), { event: "exit", ts: ts(), code, pid: process.pid });
});

// —— stage-5 T5.2 数据面：team://view = 真实团队投影视图帧（PanelViewService）。
// 身份口径（登记于开发记录）：resources/read 不携带会话身份 → team://view 返回「最近活跃
// 会话」团队的帧（lastSessionId，由每次带 _meta.session_id 的 callTool 更新；桌面单用户
// 场景即 Lead 会话）；面板的权威全量重读 = team_panel_call {action:"refresh"}（带身份）。
// 推帧纪律（F02）：500ms 轮询构帧 → contentKey（去易变 meta）变化才推 notifications/
// resources/updated + 落 ui/view-snapshot.json；mailbox-only 变化不进帧 → 键不变 → 不推帧。
const panelView = new PanelViewService({
  dataRoot: DATA,
  bootTimeMs: BOOT_TIME_MS,
  backend,
  warn: (m) => logErr("panel-view", m),
});

const view = {
  counter: 0,
  /** resources/subscribe 是连接级布尔订阅（同一客户端重复 subscribe 不叠加计数）。 */
  subscribed: false,
  /** 会话锚点代际：切会话即 +1；跨代构帧结果丢弃，避免旧会话帧覆盖新会话。 */
  epoch: 0,
  lastFrameTs: null as string | null,
  /** 最近活跃会话 id（team://view 的团队解析键；callTool _meta 每调更新）。 */
  lastSessionId: null as string | null,
  lastFrame: null as ViewFrame | null,
  lastContentKey: "",
};
let frameTimer: ReturnType<typeof setInterval> | null = null;
/** single-flight：同一时刻最多一次构帧；期间的调用只置 dirty，由当前循环补跑。 */
let pollInFlight: Promise<void> | null = null;
let pollDirty = false;

function setViewSession(sessionId: string | null): void {
  if (view.lastSessionId === sessionId) return;
  view.lastSessionId = sessionId;
  view.epoch += 1;
  view.lastContentKey = ""; // 防跨会话键碰撞（contentKey 已含 teamId，双保险）
  pollDirty = true;
}

async function pollOnce(): Promise<void> {
  const sessionId = view.lastSessionId;
  const epoch = view.epoch;
  if (sessionId === null) return;
  const frame = await panelView.buildFrame({ session_id: sessionId });
  // 构帧期间切了会话 → 丢弃旧帧，交给下一轮按新锚点重跑。
  if (view.epoch !== epoch || view.lastSessionId !== sessionId) {
    pollDirty = true;
    return;
  }
  const key = panelView.contentKey(frame);
  if (key === view.lastContentKey) return; // mailbox-only/无变化 → 不推帧（F02）
  view.lastContentKey = key;
  view.lastFrame = frame;
  view.lastFrameTs = ts();
  if (frame.team !== null) panelView.writeSnapshot(frame.team.teamId, frame);
  if (view.subscribed) pushFrame(VIEW_URI);
}

async function pollView(): Promise<void> {
  if (pollInFlight !== null) {
    pollDirty = true;
    return pollInFlight;
  }
  pollInFlight = (async () => {
    try {
      do {
        pollDirty = false;
        await pollOnce();
      } while (pollDirty);
    } catch (err) {
      logErr("panel-view", `poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

// —— stage-5 T5.5 伴生面板（可选高保真；env TEAM_COMPANION=1 开启）：
// 127.0.0.1 随机端口 + 会话 token（logs/panel-http.json 注册，team-ctl open-panel 发现）；
// SSE 推视图帧（与 team://view 同源 PanelViewService/contentKey 去抖）；随处置关停。
const panelCallDeps = {
  bootTimeMs: BOOT_TIME_MS,
  reader: new TranscriptReader(),
  bumpCounter: () => (view.counter += 1),
  now: ts,
  warn: (m: string) => logErr("panel-call", m),
};
let companion: CompanionServer | null = null;
if ((process.env.TEAM_COMPANION ?? "") === "1") {
  void startCompanionServer({
    dataRoot: DATA,
    view: panelView,
    panelCall: panelCallDeps,
    pageFile: path.join(__dirname, "ui", "team-companion.html"),
    anchoredSession: () => view.lastSessionId,
    warn: (m) => logErr("companion", m),
  }).then(
    (srv) => {
      companion = srv;
      appendJsonl(path.join(DATA, "logs", "daemon-lifecycle.jsonl"), {
        event: "companion-started",
        ts: ts(),
        pid: process.pid,
        port: srv.port(),
      });
      logErr("companion", `companion panel listening: ${srv.url()}`);
    },
    (err: unknown) => logErr("companion", `start failed: ${err instanceof Error ? err.message : String(err)}`),
  );
}

// —— MCP server（低层 Server，保留 _meta 透传）
const server = new Server(
  {
    name: "team-daemon",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true, listChanged: false },
    },
  },
);

const TOOL_PING_DESC =
  "团队心跳探针（诊断用）。返回 daemon 存活状态、当前会话身份（来自调用上下文的 session_id）与配置摘要。";

const TOOLS = [
  {
    name: "team_ping",
    description: TOOL_PING_DESC,
    inputSchema: {
      type: "object" as const,
      properties: {
        echo: { type: "string", description: "可选回显文本" },
      },
    },
  },
  {
    name: "team_panel_call",
    description:
      "面板回环工具（app 专用）：面板经 callServerTool 调用。label-only = 心跳/计数（H12 保活载体）；action=refresh = 全量视图帧；action=detail + target = 成员会话查看视图（T5.7，cursor/limit 分页）。",
    visibility: ["app"],
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "调用来源标注（如 heartbeat / manual）" },
        action: {
          type: "string",
          enum: ["refresh", "detail"],
          description: "refresh = 全量视图帧；detail = 成员会话查看视图（需 target）",
        },
        target: { type: "string", description: "detail 目标成员 id（或成员名；lead 亦可）" },
        cursor: { type: "number", description: "detail seq 游标（返回 seq < cursor 的最近一页；缺省 = 末页/最近上下文）" },
        limit: { type: "number", description: "detail 页大小（默认 100，上限 200）" },
      },
    },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: "agent-team-panel", mimeType: "text/html", description: "智能体团队会话面板（团队视图 + 成员会话下钻）" },
  { uri: VIEW_URI, name: "agent-team-view", mimeType: "application/json", description: "团队视图帧（订阅推送源）" },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  appendJsonl(path.join(DATA, "logs", "requests.jsonl"), { ts: ts(), method: "tools/list" });
  // 模型面 = 9 个团队工具（interrupt=false → 8）。team_ping 仅诊断：默认不暴露，
  // TEAM_DEBUG_TOOLS=1 时才进入 tools/list；team_panel_call 保留给面板 app 通道。
  const debugTools = process.env.TEAM_DEBUG_TOOLS === "1";
  const supportTools = debugTools
    ? TOOLS
    : TOOLS.filter((t) => t.name !== "team_ping");
  return { tools: [...supportTools, ...listTeamTools({ interrupt: backend.interruptEnabled })] };
});


server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args, _meta } = req.params;
  // 落盘只记白名单工具名 + 脱敏参数（正文/提示词/敏感键不落明文）。
  const record = {
    ts: ts(),
    tool: sanitizeToolName(name),
    params_meta: _meta ?? null, // H1 证据：每次调用的 _meta 全量
    arguments: redactToolArguments(args ?? null),
    sessionIdEnv: process.env.ZCODE_SESSION_ID ?? null,
  };
  appendJsonl(path.join(DATA, "logs", "meta-log.jsonl"), record);
  // per-call 文件路径由 shared.metaFilePath 统一白名单化 + 根目录越界校验。
  const perCallFile = metaFilePath(DATA, name);
  if (perCallFile !== null) {
    try {
      fs.writeFileSync(perCallFile, JSON.stringify(record, null, 2), { mode: 0o600 });
    } catch (err) {
      logErr("daemon", "meta per-call write failed", err instanceof Error ? err.message : String(err));
    }
  }

  // stage-5：任何带身份的 callTool 更新 team://view 的团队解析键（最近活跃会话）
  const callSid = (_meta as Record<string, unknown> | undefined)?.session_id;
  if (typeof callSid === "string" && callSid.length > 0) setViewSession(callSid);

  if (!config.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: config.error! }],
    };
  }

  if (name === "team_ping") {
    view.counter += 1;
    const sid = (_meta as Record<string, unknown> | undefined)?.session_id;
    const body = {
      pong: true,
      probe: null,
      identity: {
        session_id: sid ?? null, // 预期 sess_ 前缀；与所在会话一致（F03 断言）
        turn_id: (_meta as Record<string, unknown> | undefined)?.turn_id ?? null,
        trace_id: (_meta as Record<string, unknown> | undefined)?.trace_id ?? null,
        workspace_path: (_meta as Record<string, unknown> | undefined)?.workspace_path ?? null,
        client_mode: (_meta as Record<string, unknown> | undefined)?.client_mode ?? null,
        delivery_kind: (_meta as Record<string, unknown> | undefined)?.delivery_kind ?? null,
        meta_keys: _meta ? Object.keys(_meta) : [],
      },
      runtime: { node: process.versions.node, pid: process.pid, nodeWarn },
      config: config.values,
      echo: (args as { echo?: string } | undefined)?.echo ?? null,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  }

  if (name === "team_panel_call") {
    // stage-5：面板唯一 server 通道（接口草案 §5）。心跳（无 action）保持 stage-1 计数语义；
    // refresh → 全量视图帧（带身份）；detail → T5.7 成员会话查看视图（契约同草案）。
    const sid = (_meta as Record<string, unknown> | undefined)?.session_id;
    if (typeof sid === "string" && sid.length > 0) view.lastSessionId = sid;
    const result = await handlePanelCall(
      {
        view: panelView,
        dataRoot: DATA,
        ...panelCallDeps,
      },
      (args ?? {}) as Record<string, unknown>,
      _meta as import("./mcp/identity.js").CallMeta | undefined,
    );
    view.lastFrameTs = ts();
    let body: unknown;
    switch (result.kind) {
      case "heartbeat":
        body = { ok: true, counter: result.counter, ts: result.ts, label: result.label };
        break;
      case "view":
        view.lastFrame = result.frame;
        view.lastContentKey = panelView.contentKey(result.frame);
        if (result.frame.team !== null) {
          panelView.writeSnapshot(result.frame.team.teamId, result.frame);
        }
        body = { ok: true, frame: result.frame };
        break;
      case "detail":
        body = { ok: true, detail: result.detail };
        break;
      case "error":
        body = {
          ok: false,
          error: {
            ...(result.code !== "" ? { code: result.code } : {}),
            message: result.message,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          },
        };
        break;
    }
    return {
      // 错误也走正常应答（isError 不置位）：面板经 body.error 呈现可读原因并可重试（F14①）；
      // 通道级失败（daemon 回收）由面板 callServerTool rejection 路径处理。
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
    };
  }

  // —— stage-3：9 个团队工具（身份=_meta.session_id 每调解析；紧凑 JSON；错误 code 透传）
  if (isTeamTool(name)) {
    const meta = _meta as import("./mcp/identity.js").CallMeta | undefined;
    return callTeamTool(
      {
        backend,
        dataRoot: DATA,
        bootTimeMs: BOOT_TIME_MS,
        name,
        args: (args ?? {}) as Record<string, unknown>,
        meta,
        signal: extra.signal,
      },
      // progress 保活：仅 wait_agent + 宿主 progressToken 在场时发（registry 内判定）；
      // 经 extra.sendNotification（SDK 关联 requestId 的标准路径）。
      // F11 实录：每次发射落 logs/progress.jsonl（报文级证据）。
      {
        sendNotification: (notification) => {
          appendJsonl(path.join(DATA, "logs", "progress.jsonl"), { ts: ts(), notification });
          return extra.sendNotification(
            notification as Parameters<typeof extra.sendNotification>[0],
          );
        },
      },
    );
  }

  throw new Error(`TEAM_UNKNOWN_TOOL: ${name}`);
});


server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  if (uri === PANEL_URI) {
    const html = fs.readFileSync(path.join(__dirname, "ui", "team-panel.html"), "utf8");
    return { contents: [{ uri, mimeType: "text/html", text: html }] };
  }
  if (uri === VIEW_URI) {
    // resources/read 无会话身份 → 按最近活跃会话构帧；无锚点/构帧失败 → 缓存帧或
    // 快照基线（断线重连口径），最后兜底 team:null 空帧（面板呈现加载/不可用条）。
    let frame: ViewFrame | null = null;
    if (view.lastSessionId !== null) {
      try {
        frame = await panelView.buildFrame({ session_id: view.lastSessionId });
      } catch (err) {
        logErr("panel-view", `view read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    frame ??= view.lastFrame ?? (view.lastSessionId !== null ? panelView.readSnapshot(view.lastSessionId) ?? null : null);
    frame ??= emptyViewFrame(ts(), view.lastSessionId ?? undefined);
    view.lastFrame = frame;
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(frame) },
      ],
    };
  }
  throw new Error(`TEAM_UNKNOWN_RESOURCE: ${uri}`);
});

function pushFrame(uri: string) {
  view.lastFrameTs = ts();
  server
    .notification({ method: "notifications/resources/updated", params: { uri } })
    .catch((e: unknown) => logErr("daemon", "pushFrame failed", String(e)));
}

server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  const { uri } = req.params;
  appendJsonl(path.join(DATA, "logs", "requests.jsonl"), { ts: ts(), method: "resources/subscribe", uri });
  if (uri === VIEW_URI) {
    view.subscribed = true;
    if (!frameTimer) {
      // F02 时效预算 ≤1s：500ms 轮询构帧（contentKey 去抖，mailbox-only 不推帧）；
      // unref：订阅者断开后计时器不得独力撑住 daemon 进程。
      frameTimer = setInterval(() => void pollView(), 500);
      frameTimer.unref?.();
    }
    await pollView(); // 订阅即同步一帧（内容变化才推；首帧经 readView 拉取）
  }
  return {} as Result;
});

server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  const { uri } = req.params;
  appendJsonl(path.join(DATA, "logs", "requests.jsonl"), { ts: ts(), method: "resources/unsubscribe", uri });
  if (uri === VIEW_URI) {
    view.subscribed = false;
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  }
  return {} as Result;
});

// —— 启动
const transport = new StdioServerTransport();
// 连接关闭：停掉订阅轮询（avoid 泄漏的 interval 与孤儿通知）。
transport.onclose = () => {
  view.subscribed = false;
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
};
await server.connect(transport);
logErr("daemon", `agent-team daemon ready (pid=${process.pid}, node=${process.versions.node}, data=${DATA}, config=${config.ok ? "ok" : "INVALID"})`);
