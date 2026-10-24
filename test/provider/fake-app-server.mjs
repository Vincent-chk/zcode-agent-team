// 假 app-server（测试夹具）：实现 breeder 需要的最小 v4/command 协议。
// 用法：node fake-app-server.mjs app-server
//   → 推 startup/storageState ready 通知；回应 v4/command：
//       createSession → { status:"accepted", result:{ type:"createSession", sessionId:"sess_fake_anchor" } }
//       createSelectionSideSession → result.sessionId = FAKE_APP_SERVER_CHILD（缺省 sess_fake_child）
// 环境变量：
//   FAKE_APP_SERVER_CHILD      子会话 id
//   FAKE_APP_SERVER_ANCHOR     anchor 会话 id
//   FAKE_APP_SERVER_FAIL       非空 = 指定失败的步骤（create / side / ready）
//   FAKE_APP_SERVER_RECORD     非空 = 把收到的请求追加写入该 JSONL（断言用）
import fs from "node:fs";

const FAIL = process.env.FAKE_APP_SERVER_FAIL ?? "";
const ANCHOR = process.env.FAKE_APP_SERVER_ANCHOR ?? "sess_fake_anchor";
const CHILD = process.env.FAKE_APP_SERVER_CHILD ?? "sess_fake_child";
const RECORD = process.env.FAKE_APP_SERVER_RECORD;

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
      if (type === "createSession") {
        if (FAIL === "create") {
          respond({ result: { status: "failed", reasonCode: "fault.command.executionFailed", message: "fake create failure" } });
        } else {
          respond({ result: { status: "accepted", result: { type: "createSession", sessionId: ANCHOR } } });
        }
        continue;
      }
      if (type === "createSelectionSideSession") {
        if (FAIL === "side") {
          respond({
            result: { status: "rejected", reasonCode: "fault.command.executionFailed", message: "fake side failure" },
          });
        } else {
          respond({
            result: { status: "accepted", result: { type: "createSelectionSideSession", sessionId: CHILD } },
          });
        }
        continue;
      }
      respond({ result: { status: "failed", reasonCode: "proto.invalidPayload", message: `unknown type ${type}` } });
      continue;
    }
    respond({ error: { code: -32601, message: `method not found: ${String(request.method)}` } });
  }
});

process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 60_000).unref();
