// 0.5.4 前置验证：真实 app-server 的固定 commandId 查询与恢复边界。
// 仅在 --root 指定的全新隔离目录操作；不读取/修改用户会话库，不启动成员轮次。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../../src/provider/app-server-client.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = path.resolve(option("root") ?? fs.mkdtempSync(path.join(os.tmpdir(), "at-v4-contract-")));
if (option("root") === undefined || root === path.parse(root).root || root === os.homedir()) {
  throw new Error("an explicit, isolated --root is required");
}
const workspace = path.join(root, "workspace");
const home = path.join(root, "home");
const out = option("out") ?? path.join(root, "result.json");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const zcode = option("zcode") ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const env = {
  ...process.env,
  HOME: home,
  ZCODE_HOME: path.join(home, ".zcode"),
  TEAM_DB_PATH: path.join(root, "db.sqlite"),
  TEAM_TASKS_INDEX_PATH: path.join(root, "tasks-index.sqlite"),
};
const commandId = `team-contract-${process.pid}`;
const anchorSessionId = `sess_team_contract_${process.pid}`;
const childCommandId = `${commandId}-child`;
const envelope = {
  commandId,
  clientId: "agent-team-contract-probe",
  sessionId: null,
  issuedAt: Date.now(),
  type: "createSession",
  payload: { sessionId: anchorSessionId, workspaceId: workspace, permissionScope: "session" },
};
const evidence = [];
const record = (name, result) => {
  evidence.push({ name, result });
  fs.writeFileSync(out, JSON.stringify({ evidence }, null, 2));
};
const spawn = () => AppServerClient.spawn({
  executable: process.execPath,
  argvPrefix: [zcode],
  cwd: workspace,
  env,
});
try {
  const client = spawn();
  try {
    if (!await client.waitReady(20_000)) throw new Error("isolated app-server did not become ready");
    const created = await client.rpc("v4/command", envelope);
    record("preallocated-create", created);
    const queried = await client.rpc("v4/commands/query", {
      commands: [{ sessionId: null, commandId }],
    });
    record("same-process-query", queried);
    const retried = await client.rpc("v4/command", envelope);
    record("same-process-same-key-retry", retried);
    const listed = await client.rpc("session/list", { sessionIds: [anchorSessionId] });
    record("preallocated-session-list", listed);
    const child = await client.rpc("v4/command", {
      commandId: childCommandId,
      clientId: envelope.clientId,
      sessionId: anchorSessionId,
      issuedAt: Date.now(),
      type: "createSelectionSideSession",
      payload: {},
    });
    record("child-create", child);
    record("child-same-process-query", await client.rpc("v4/commands/query", {
      commands: [{ sessionId: anchorSessionId, commandId: childCommandId }],
    }));
  } finally {
    await client.close();
  }
  const restarted = spawn();
  try {
    if (!await restarted.waitReady(20_000)) throw new Error("restarted app-server did not become ready");
    record("after-restart-anchor-query", await restarted.rpc("v4/commands/query", {
      commands: [{ sessionId: null, commandId }],
    }));
    record("after-restart-anchor-list", await restarted.rpc("session/list", { sessionIds: [anchorSessionId] }));
    record("after-restart-child-query", await restarted.rpc("v4/commands/query", {
      commands: [{ sessionId: anchorSessionId, commandId: childCommandId }],
    }));
  } finally {
    await restarted.close();
  }
} catch (error) {
  record("probe-error", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
console.log(JSON.stringify({ out, evidence }, null, 2));
