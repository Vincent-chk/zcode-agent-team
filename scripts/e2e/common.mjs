// stage-6 e2e 公共层（S1–S6 共用）：参数化路径、真 daemon 的 MCP stdio 客户端、
// 只读 db 探针、事件读取、等待/断言、统一 result.json（含 attempts/evidence）。
// 纪律：
//  - db.sqlite 一律 readOnly 打开；不写宿主会话库（写只发生在测试专用会话库）。
//  - 失败必须非零退出（run.mjs 汇总）；单场景 result.json 记录每步 pass/fail。
//  - 不打印任何凭据；env 只透传，不落盘。
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
export const FAKE_ZCODE = path.join(PROJ, "test", "provider", "fake-zcode.mjs");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nowIso = () => new Date().toISOString();

export function parseArgv(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * 参数化配置（全部可用 env 覆盖，便于 CI/用户机两种形态）：
 *   ZCODE_BIN（缺省桌面 zcode.cjs）、TEAM_DATA_ROOT、TEAM_DB_PATH、E2E_OUT、E2E_WS、
 *   E2E_MODEL、E2E_TEAM_PREFIX。
 */
export function loadConfig(args = parseArgv()) {
  const dataRoot =
    args.data ?? process.env.TEAM_DATA_ROOT ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-e2e-data-"));
  const ws = args.ws ?? process.env.E2E_WS ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-e2e-ws-"));
  const out = args.out ?? process.env.E2E_OUT ?? path.join(PROJ, "..", "zcode-agent-team-plan", "stage-6-e2e-acceptance", "evidence");
  const dbPath = args.db ?? process.env.TEAM_DB_PATH ?? path.join(fs.realpathSync(os.tmpdir()), `at-e2e-db-${process.pid}.sqlite`);
  const zcode = args.zcode ?? process.env.ZCODE_BIN ?? process.env.TEAM_ZCODE_BIN ?? DEFAULT_ZCODE;
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return {
    zcode,
    dataRoot,
    dbPath,
    out,
    ws,
    model: args.model ?? process.env.E2E_MODEL ?? "deepseek-flash",
    teamPrefix: args.prefix ?? process.env.E2E_TEAM_PREFIX ?? "sess_e2e",
    daemon: args.daemon ?? path.join(PROJ, "dist", "team-daemon.mjs"),
    fakeZcode: FAKE_ZCODE,
  };
}

export function teamDirFor(cfg, teamId) {
  const safe = String(teamId).replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0).toString(16));
  return path.join(cfg.dataRoot, "teams", safe);
}

// ---------------------------------------------------------------- 真 zcode -p 会话

export function runZcode(cfg, { prompt, extraArgs = [], cwd = cfg.ws, timeoutMs = 300_000, env = {} }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        cfg.zcode,
        "-p",
        prompt,
        ...extraArgs,
        "--json",
        "--mode",
        "yolo",
        "--surface",
        "terminal",
        "--cwd",
        cwd,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          /* 非 JSON 输出：保留原文 */
        }
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          ms: Date.now() - startedAt,
          parsed,
          stdout: String(stdout).slice(0, 4000),
          stderr: String(stderr).slice(0, 2000),
        });
      },
    );
  });
}

// ---------------------------------------------------------------- daemon（MCP stdio）

/**
 * 启动 dist/team-daemon.mjs（生产形态：stdio NDJSON）。
 * 返回 { ready, callTool, notifications, events, kill, waitExit, stderr, pid }。
 */
export function startDaemon(cfg, { dataRoot = cfg.dataRoot, projectDir = cfg.ws, env = {}, dbPath = cfg.dbPath, label = "daemon" } = {}) {
  const child = spawn(process.execPath, [cfg.daemon], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TEAM_PLUGIN_DATA: dataRoot,
      TEAM_PROJECT_DIR: projectDir,
      ...(dbPath !== null ? { TEAM_DB_PATH: dbPath } : {}),
      ...env,
    },
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const notifications = [];
  const lifecycle = [];
  const stderrChunks = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      } else if (message.method !== undefined) {
        notifications.push(message);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrChunks.push(text);
    if (stderrChunks.join("").length > 200_000) stderrChunks.shift();
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`${label} exited (code=${code}, signal=${signal})`));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  function rpc(method, params, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc timeout ${method}#${id} after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  }

  const handle = {
    pid: child.pid,
    notifications,
    lifecycle,
    stderr: () => stderrChunks.join(""),
    async ready(timeoutMs = 20_000) {
      const init = await rpc(
        "initialize",
        { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "team-e2e", version: "1" } },
        timeoutMs,
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return init;
    },
    callTool(name, args = {}, meta, timeoutMs = 240_000) {
      return rpc("tools/call", { name, arguments: args, ...(meta !== undefined ? { _meta: meta } : {}) }, timeoutMs);
    },
    /** 工具调用并解析 JSON body；isError → 抛出（带工具文本）。 */
    async callJson(name, args, meta, timeoutMs) {
      const res = await handle.callTool(name, args, meta, timeoutMs);
      return toolJson(res);
    },
    async kill(signal = "SIGINT") {
      try {
        child.kill(signal);
      } catch {
        /* 已退出 */
      }
      return exited;
    },
    waitExit: () => exited,
  };
  return handle;
}

export function toolJson(res) {
  const result = res?.result ?? res;
  if (result?.isError) {
    const message = result.content?.[0]?.text ?? "unknown tool error";
    const err = new Error(message);
    err.toolError = true;
    throw err;
  }
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result has no text content");
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 会话库（只读探针 + 测试库）

export function createTestSessionDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
      CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
      CREATE INDEX IF NOT EXISTS message_session_sequence_idx ON message (session_id, sequence, time_created, id);
      CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id);
      CREATE INDEX IF NOT EXISTS part_message_sequence_idx ON part (message_id, sequence, time_created, id);
    `);
  } finally {
    db.close();
  }
}

/** 只读查询（参数绑定；禁止拼接 SQL）。 */
export function queryDb(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function assistantTexts(dbPath, sessionId) {
  return queryDb(
    dbPath,
    `SELECT json_extract(p.data,'$.text') AS t FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  )
    .map((row) => row.t)
    .filter((t) => typeof t === "string");
}

export function firstRealUserText(dbPath, sessionId) {
  return (
    queryDb(
      dbPath,
      `SELECT json_extract(p.data,'$.text') AS t FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? AND json_extract(m.data,'$.role')='user'
         AND json_extract(m.data,'$.semantics.origin')='real_user' AND json_extract(p.data,'$.type')='text'
       ORDER BY m.sequence LIMIT 1`,
      [sessionId],
    )[0]?.t ?? null
  );
}

export function sessionRow(dbPath, sessionId) {
  return queryDb(dbPath, "SELECT id, directory, task_type, title FROM session WHERE id = ?", [sessionId])[0];
}

// ---------------------------------------------------------------- 团队目录探针

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function readEvents(teamDir) {
  return readJsonl(path.join(teamDir, "events.jsonl"));
}

export function listMemberOrigins(teamDir) {
  const membersDir = path.join(teamDir, "members");
  let names;
  try {
    names = fs.readdirSync(membersDir);
  } catch {
    return [];
  }
  const origins = [];
  for (const name of names) {
    try {
      origins.push(JSON.parse(fs.readFileSync(path.join(membersDir, name, "origin.json"), "utf8")));
    } catch {
      /* 未落定 */
    }
  }
  return origins;
}

export function originByName(teamDir, name) {
  return listMemberOrigins(teamDir).find((origin) => origin.name === name);
}

export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 200, label = "condition" } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return { ms: Date.now() - startedAt, value };
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timeout after ${timeoutMs}ms: ${label}`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- 断言/证据

export class Checks {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.startedAt = nowIso();
  }

  check(id, ok, detail) {
    this.items.push({ id, pass: Boolean(ok), ...(detail !== undefined ? { detail } : {}), ts: nowIso() });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${this.name}/${id}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}\n`);
    return Boolean(ok);
  }

  get pass() {
    return this.items.length > 0 && this.items.every((item) => item.pass);
  }

  toJSON(extra = {}) {
    return {
      scenario: this.name,
      pass: this.pass,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      checks: this.items,
      ...extra,
    };
  }
}

export function writeResult(outDir, name, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const file = path.join(outDir, `${name}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

/** 唯一前缀（成员名/暗号用；避免同名冲突）。 */
export function uniq(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString("hex")}`;
}

/** 真实会话库路径（真模型剧本用；生产同源）。 */
export function realDbPath() {
  return process.env.TEAM_DB_PATH ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}
