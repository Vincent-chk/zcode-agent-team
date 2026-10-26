// 真 provider 测试夹具（stage-4）：ResumePerTurnProvider + fake-zcode 替身 + 独立测试 db。
// 计时全部收紧（探针 150ms 轮询、确认秒级）；FAKE_ZCODE_* 故障注入经 process.env（fileParallelism=false）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResumePerTurnProvider } from "../../src/provider/resume-provider.js";
import type { SessionBreederLike } from "../../src/provider/resume-provider.js";
import type { ZcodeBin } from "../../src/provider/zcode-bin.js";
import type { ModelCatalog } from "../../src/provider/model-catalog.js";
import type { TeamLimits } from "../../src/domain/config.js";
import type { ContentBlock } from "../../src/domain/events.js";

export const FAKE_ZCODE = path.resolve(import.meta.dirname, "fake-zcode.mjs");

export function fakeZcodeBin(): ZcodeBin {
  return { command: process.execPath, argvPrefix: [FAKE_ZCODE], source: "env" };
}

export function badZcodeBin(): ZcodeBin {
  // 不存在的解释器：launch 本身失败（F03 错误二进制）；坏脚本路径属「进程起即死」→ F04 口径
  return { command: "/nonexistent/at-fail-node", argvPrefix: [], source: "env" };
}

export interface ProviderKit {
  root: string;
  dataRoot: string;
  teamId: string;
  dbPath: string;
  cwd: string;
  provider: ResumePerTurnProvider;
  limits: TeamLimits;
  logs: Array<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

export function createTestDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT,
      directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER,
      task_type TEXT, title_source TEXT, title_message_id TEXT, time_title_updated INTEGER, trace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER,
      data TEXT, sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER,
      data TEXT, sequence INTEGER
    );
    CREATE INDEX message_session_sequence_idx ON message (session_id, sequence, time_created, id);
    CREATE INDEX part_session_idx ON part (session_id);
    CREATE INDEX part_message_sequence_idx ON part (message_id, sequence, time_created, id);
    CREATE TABLE session_entry (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL, variant TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      query_source TEXT
    );
  `);
  db.close();
}

/** 直插模型选择条目（setModel 落库形态；id 缺省按宿主 canonical 规则 `<sessionId>:runtime-model-selection`）。
 *  OR REPLACE = 宿主 UPSERT 单行语义（重复 setModel 刷新同一行；0.4.1 起测试桩需要多次写）。 */
export function insertSessionEntry(
  dbPath: string,
  args: { sessionId: string; data: unknown; type?: string; id?: string; timeCreated?: number },
): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    const type = args.type ?? "runtime/model_selection";
    const ts = args.timeCreated ?? Date.now();
    db.prepare(
      "INSERT OR REPLACE INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run(
      args.id ?? `${args.sessionId}:${type.replaceAll("/", "-")}`,
      args.sessionId,
      type,
      ts,
      ts,
      JSON.stringify(args.data),
    );
  } finally {
    db.close();
  }
}

/** 直插一次模型调用记录（继承兜底探针用；started_at 越大越新；query_source 缺省 main_turn）。 */
export function insertModelUsage(
  dbPath: string,
  args: {
    sessionId: string;
    providerId: string;
    modelId: string;
    variant?: string | null;
    startedAt?: number;
    querySource?: string;
  },
): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    const startedAt = args.startedAt ?? Date.now();
    db.prepare(
      "INSERT INTO model_usage (id, session_id, provider_id, model_id, variant, status, started_at, query_source) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      `usage-${args.sessionId}-${startedAt}`,
      args.sessionId,
      args.providerId,
      args.modelId,
      args.variant ?? null,
      "completed",
      startedAt,
      args.querySource ?? "main_turn",
    );
  } finally {
    db.close();
  }
}

/** 直插一条「真实用户提交」消息（0.4.0 三源判定的提交快照源；宿主保存时写入 modelSelection）。 */
export function insertSubmissionMessage(
  dbPath: string,
  args: {
    sessionId: string;
    providerId: string;
    modelId: string;
    reasoningLevel?: string;
    timeCreated: number;
    sequence?: number;
  },
): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 2000");
  try {
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)",
    ).run(
      `msg-submission-${args.sessionId}-${args.timeCreated}`,
      args.sessionId,
      args.timeCreated,
      args.timeCreated,
      JSON.stringify({
        role: "user",
        semantics: { origin: "real_user" },
        modelSelection: {
          providerId: args.providerId,
          modelId: args.modelId,
          ...(args.reasoningLevel !== undefined
            ? { options: { reasoningLevel: args.reasoningLevel } }
            : {}),
        },
      }),
      args.sequence ?? args.timeCreated,
    );
  } finally {
    db.close();
  }
}

export function buildProviderKit(opts: {
  teamId?: string;
  zcode?: ZcodeBin;
  drainPolicy?: "keep" | "kill";
  sessionIsolation?: "child" | "legacy";
  breeder?: SessionBreederLike;
  /** 模型目录注入（档位缺省链；缺省 = 读宿主真实目录——测试里 providerId 不在宿主目录 → 缺省 max）。 */
  modelCatalog?: () => ModelCatalog;
  /** 模型同步临时故障退避序列注入（0.4.1；缺省 5s/15s/30s，测试收紧）。 */
  modelRetryBackoffMs?: number[];
} = {}): ProviderKit {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-"));
  const dataRoot = path.join(root, "data");
  const cwd = path.join(root, "ws");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const dbPath = path.join(root, "db.sqlite");
  createTestDb(dbPath);
  const teamId = opts.teamId ?? "sess_s4_lead";
  const logs: Array<Record<string, unknown>> = [];
  const provider = new ResumePerTurnProvider({
    dataRoot,
    teamId,
    cwd,
    dbPath,
    zcode: opts.zcode ?? fakeZcodeBin(),
    // 既有夹具走 fake-zcode（不支持 app-server）→ 默认 legacy；隔离路径由专门用例注入 breeder。
    sessionIsolation: opts.sessionIsolation ?? "legacy",
    ...(opts.breeder !== undefined ? { breeder: opts.breeder } : {}),
    ...(opts.modelCatalog !== undefined ? { modelCatalog: opts.modelCatalog } : {}),
    ...(opts.modelRetryBackoffMs !== undefined ? { modelRetryBackoffMs: opts.modelRetryBackoffMs } : {}),
    ...(opts.drainPolicy !== undefined ? { drainPolicy: opts.drainPolicy } : {}),
    firstTurnTimeoutMs: 8_000,
    deliverConfirmMs: 4_000,
    watcherIntervalMs: 200,
    relaunchBackoffMs: 150,
    termGraceMs: 800,
    log: (record) => logs.push(record),
  });
  return {
    root,
    dataRoot,
    teamId,
    dbPath,
    cwd,
    provider,
    limits: { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 2000 },
    logs,
    async cleanup() {
      provider.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** fake-zcode 环境变量注入（用后恢复；vitest 文件内串行）。 */
export function withFakeEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(vars)) {
    saved.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export function framedText(senderName: string, content: string): { messageId: string; framedJson: string } {
  const messageId = `team-message-${crypto.randomUUID()}`;
  const framed: ContentBlock[] = [
    { type: "text", text: `Team message from ${senderName}:` },
    { type: "text", text: content },
  ];
  return { messageId, framedJson: JSON.stringify(framed) };
}

import { randomUUID as cryptoRandomUUID } from "node:crypto";
const crypto = { randomUUID: cryptoRandomUUID };

import { TeamCoordinatorHost } from "../../src/coord/host.js";

/** 协调者级装配（真实 journal/lock/runtime + 真 provider + 边界接线——host.serve 内完成 bind/adopt）。 */
export async function openHost(kit: ProviderKit): Promise<TeamCoordinatorHost> {
  return TeamCoordinatorHost.open({
    dataRoot: kit.dataRoot,
    teamId: kit.teamId,
    limits: kit.limits,
    provider: kit.provider,
    warn: () => undefined,
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
