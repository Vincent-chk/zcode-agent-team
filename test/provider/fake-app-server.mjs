// 假 app-server（测试夹具）：实现 breeder 需要的最小 v4/command 协议。
// 用法：node fake-app-server.mjs app-server
//   → 推 startup/storageState ready 通知；回应 v4/command：
//       createSession → { status:"accepted", result:{ type:"createSession", sessionId:"sess_fake_anchor" } }
//       createSelectionSideSession → result.sessionId = FAKE_APP_SERVER_CHILD（缺省 sess_fake_child）
//       v4/commands/query → {results:[{key,result:ack|"unknown"}]}
//       session/list → 已确认 anchor 的最小 workspace/sessionKind 记录
//       session/setModel → 小 ack（真实宿主返回巨型消息快照；夹具只回 {ok:true}）
//       session/resume → 最小 {session:{id}}（mid-life 应用链：resume→setModel）
// 环境变量：
//   FAKE_APP_SERVER_CHILD      子会话 id
//   FAKE_APP_SERVER_ANCHOR     anchor 会话 id（未在 createSession.payload.sessionId 预分配时）
//   FAKE_APP_SERVER_ANCHOR_KIND session/list 的 anchor sessionKind（缺省 interactive）
//   FAKE_APP_SERVER_FAIL       非空 = 指定失败的步骤（create / side / ready / setModel / setModel-once / resume）
//                              setModel-once = 仅第一次 setModel 失败（测兜底成功路径）
//   FAKE_APP_SERVER_DROP       create / side / query = 副作用/查询结果产生后不回应（测 RPC 超时恢复）
//                              create-exit / side-exit = 副作用后立即退出（测新 client 恢复）
//   FAKE_APP_SERVER_QUERY      unknown / rejected = 强制查询结果（测保守 outcome-unknown / 明确拒绝）
//   FAKE_APP_SERVER_COMMAND_TIMEOUT side = 仅让 child 命令超时（可独立令 commands/query 超时）
//   FAKE_APP_SERVER_STATE      非空 = 跨进程持久化命令结果（测 app-server 重启恢复）
//   FAKE_APP_SERVER_SESSIONS   非空 = 独立的持久 session/list 夹具（用于 command receipt 丢失场景）
//   FAKE_APP_SERVER_RECORD     非空 = 把收到的请求追加写入该 JSONL（断言用）
import fs from "node:fs";

const FAIL = process.env.FAKE_APP_SERVER_FAIL ?? "";
const DROP = process.env.FAKE_APP_SERVER_DROP ?? "";
const QUERY = process.env.FAKE_APP_SERVER_QUERY ?? "";
const COMMAND_TIMEOUT = process.env.FAKE_APP_SERVER_COMMAND_TIMEOUT ?? "";
const ANCHOR = process.env.FAKE_APP_SERVER_ANCHOR ?? "sess_fake_anchor";
const ANCHOR_KIND = process.env.FAKE_APP_SERVER_ANCHOR_KIND ?? "interactive";
const CHILD = process.env.FAKE_APP_SERVER_CHILD ?? "sess_fake_child";
const RECORD = process.env.FAKE_APP_SERVER_RECORD;
const STATE = process.env.FAKE_APP_SERVER_STATE;
const SESSIONS = process.env.FAKE_APP_SERVER_SESSIONS;
let setModelCalls = 0;

function readState() {
  if (STATE === undefined || !fs.existsSync(STATE)) return { commands: [] };
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
const state = readState();
function saveState() {
  if (STATE !== undefined) fs.writeFileSync(STATE, JSON.stringify(state));
}
function commandKey(sessionId, commandId) {
  return JSON.stringify([sessionId, commandId]);
}
function storedCommand(sessionId, commandId) {
  return state.commands.find((entry) => entry.key === commandKey(sessionId, commandId));
}
function storeCommand(request, ack) {
  const entry = {
    key: commandKey(request.params?.sessionId ?? null, request.params?.commandId),
    sessionId: request.params?.sessionId ?? null,
    commandId: request.params?.commandId,
    type: request.params?.type,
    ack,
  };
  state.commands.push(entry);
  saveState();
  return entry;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function record(message) {
  if (RECORD !== undefined && RECORD.length > 0) {
    fs.appendFileSync(RECORD, `${JSON.stringify(message)}\n`);
  }
}

// 启动通知（客户端等 phase=ready）
if (FAIL !== "ready") {
  write({ method: "startup/storageState", params: { phase: "ready" } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    record(request);
    const respond = (body) => write({ id: request.id, ...body });
    if (request.method === "v4/command") {
      const type = request.params?.type;
      if (FAIL === "error") {
        respond({ error: { code: -32601, message: "fake protocol error" } });
        continue;
      }
      if (type === "createSession" || type === "createSelectionSideSession") {
        const dropThis =
          (type === "createSession" && (DROP === "create" || DROP === "create-exit")) ||
          (type === "createSelectionSideSession" &&
            (DROP === "side" || DROP === "side-exit" || COMMAND_TIMEOUT === "side"));
        const previous = storedCommand(request.params?.sessionId ?? null, request.params?.commandId);
        if (previous !== undefined) {
          // 固定 key 重发是 duplicate；结果仍是第一次命令的同一类型/会话 id。
          respond({ result: { ...previous.ack, status: "duplicate" } });
          continue;
        }
        const rejected = (type === "createSession" && FAIL === "create") || (type === "createSelectionSideSession" && FAIL === "side");
        const ack = rejected
          ? {
              status: type === "createSession" ? "failed" : "rejected",
              reasonCode: "fault.command.executionFailed",
              message: type === "createSession" ? "fake create failure" : "fake side failure",
            }
          : {
              status: "accepted",
              result: {
                type,
                sessionId: type === "createSession" ? request.params?.payload?.sessionId ?? ANCHOR : CHILD,
              },
            };
        storeCommand(request, ack);
        if (!rejected && dropThis) {
          // 迟到响应丢失/进程退出：副作用和 durable ack 已经发生。
          if (DROP === "create-exit" || DROP === "side-exit") {
            setTimeout(() => process.exit(0), 50);
          }
          continue;
        }
        respond({ result: ack });
        continue;
      }
      respond({ result: { status: "failed", reasonCode: "proto.invalidPayload", message: `unknown type ${type}` } });
      continue;
    }
    if (request.method === "v4/commands/query") {
      const results = (request.params?.commands ?? []).map((key) => {
        const stored = storedCommand(key.sessionId ?? null, key.commandId);
        let result = stored?.ack ?? "unknown";
        if (QUERY === "unknown") result = "unknown";
        if (QUERY === "rejected") {
          result = { status: "rejected", reasonCode: "fault.command.executionFailed", message: "fake durable rejection" };
        }
        return { key, result };
      });
      if (DROP !== "query") respond({ result: { results } });
      continue;
    }
    if (request.method === "session/list") {
      const ids = request.params?.sessionIds ?? [];
      const sessions = SESSIONS !== undefined && fs.existsSync(SESSIONS)
        ? JSON.parse(fs.readFileSync(SESSIONS, "utf8")).filter((session) => ids.includes(session.sessionId))
        : state.commands
            .filter((entry) => entry.type === "createSession" && (entry.ack.status === "accepted" || entry.ack.status === "duplicate"))
            .filter((entry) => ids.includes(entry.ack.result?.sessionId))
            .map((entry) => ({
              sessionId: entry.ack.result.sessionId,
              sessionKind: ANCHOR_KIND,
              workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
            }));
      respond({ result: { sessions } });
      continue;
    }
    if (request.method === "session/setModel") {
      setModelCalls += 1;
      const failThis = FAIL === "setModel" || (FAIL === "setModel-once" && setModelCalls === 1);
      if (failThis) {
        respond({ error: { code: -32004, message: "fake setModel failure" } });
      } else {
        respond({ result: { ok: true } });
      }
      continue;
    }
    if (request.method === "session/resume") {
      if (FAIL === "resume") {
        respond({ error: { code: -32004, message: "fake resume failure" } });
      } else {
        // 真实宿主返回 messages/projection/... 巨型快照；夹具只回最小形状（生产代码不落日志）。
        respond({ result: { session: { id: request.params?.sessionId } } });
      }
      continue;
    }
    respond({ error: { code: -32601, message: `method not found: ${String(request.method)}` } });
  }
});

process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 60_000).unref();
