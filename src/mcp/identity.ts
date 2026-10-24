// 身份解析（stage-3 T3.1；接口草案 §6 / ADR-2 修订版）。
// 主通道：每次 callTool 读 params._meta.session_id（进程无状态化——同一 daemon 被多会话
// 共享也不串身份，F12）；首调持久化到 session-map.json。
// 兜底：_meta 缺失 → hook env overlay 映射（SessionStart hook 用 ZCODE_SESSION_ID 注册的
// session-map 条目；daemon 启动时间窗内恰一个候选才采用——多候选/零候选一律 fail-closed）。
// 仍缺 → TEAM_NOT_MEMBER（fail closed）。
//
// 团队解析（DSH 02 §5.2 等价路径）：
//  - session-map 已注册 teammate（role:"teammate"+teamId+name；写入方 = provider，stage-4 接线）
//    → 该团队的 teammate；
//  - _meta.runtime_scope === "subagent" 且无 teammate 映射 → 非成员（一次性子代理，DSH
//    「descriptor 折叠 → undefined」的宿主字段等价物）→ TEAM_NOT_MEMBER；
//  - 其余（含父不存活孤儿）→ 隐式 Lead：teamId = 自身 session_id（02 §2「每个根会话都是
//    一个 Team 的隐式 Lead」；持久状态从第一条记录开始）。
// 投影 failure 终态的 C5 退化（全员 TEAM_NOT_MEMBER）由 coord/host 层承担（stage-2 G1/G2
// 终态口径）——本层不重复判定。
//
// fail-loud（D10）：条目 hookRegistered !== true（本会话 SessionStart hook 未触发——插件被
// 禁用/宿主漂移）→ 工具结果尾部附警告行（handlers 层拼接）。

import fs from "node:fs";
import path from "node:path";
import { TeamError } from "../domain/errors.js";
import { ts } from "../shared.js";

/** session-map.json 条目（hooks.ts 与 daemon 共写；字段全部可选合并）。 */
export interface SessionMapEntry {
  session_id?: string;
  firstSeen?: string;
  lastSeen?: string;
  event?: string;
  cwd?: string;
  /** SessionStart hook 注册过本会话（fail-loud 判定依据，D10）。 */
  hookRegistered?: boolean;
  /** teammate 映射（provider 写入，stage-4；契约测试直接注入）。 */
  teamId?: string;
  role?: "lead" | "teammate";
  name?: string;
  /** 域侧成员 id（= roster childId；teammate 会话 id ↔ 成员 id 的映射由 provider 落盘）。 */
  memberId?: string;
}

export type SessionRegistry = Record<string, SessionMapEntry>;

export interface ResolvedIdentity {
  sessionId: string;
  teamId: string;
  role: "lead" | "teammate";
  /** teammate 时的成员名；lead 恒 "lead"。 */
  name: string;
  /**
   * 域服务调用方 id（callerId）：lead = 自身 session_id（= teamId）；teammate = 域侧成员 id
   * （session-map.memberId，provider 落盘映射——stage-4 接线）；无映射时退 sessionId（域侧
   * 成员表查不到 → requireMembership → TEAM_NOT_MEMBER，fail-closed 方向正确）。
   */
  agentId: string;
  /** 身份来源（诊断/测试断言）。 */
  source: "meta" | "hook-map";
  /** SessionStart hook 是否注册过（false → fail-loud 警告行）。 */
  hookRegistered: boolean;
}

export function sessionMapPath(dataRoot: string): string {
  return path.join(dataRoot, "session-map.json");
}

export function safeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

function registryLockPath(dataRoot: string): string {
  return `${sessionMapPath(dataRoot)}.lock`;
}

/** 跨进程单写者锁（hook/daemon/provider 都会写同一文件）；超时后仍走原子替换，避免丢整表。 */
function withRegistryLock(dataRoot: string, fn: () => void): void {
  const lock = registryLockPath(dataRoot);
  const started = Date.now();
  let fd: number | null = null;
  while (Date.now() - started < 2_000) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch {
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 5_000) fs.unlinkSync(lock);
      } catch {
        /* 锁刚释放 → 重试 */
      }
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* 短自旋，hook 进程预算内 */
      }
    }
  }
  try {
    fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      } catch {
        /* best-effort */
      }
    }
  }
}

export function readSessionRegistry(dataRoot: string): SessionRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMapPath(dataRoot), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SessionRegistry;
  } catch {
    return {};
  }
}

/**
 * 合并写回（读-改-写；键 = safeSessionKey）。
 * 原子替换 + 跨进程锁；解析失败先把旧文件 quarantine，绝不以空表覆盖。
 */
export function upsertSessionEntry(dataRoot: string, sessionId: string, patch: SessionMapEntry): void {
  const file = sessionMapPath(dataRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withRegistryLock(dataRoot, () => {
      let registry: SessionRegistry = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          registry = parsed as SessionRegistry;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          try {
            fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
          } catch {
            /* quarantine 失败 → 仍以空表继续，至少不阻塞身份主通道 */
          }
        }
      }
      const key = safeSessionKey(sessionId);
      const prior = registry[key] ?? {};
      registry[key] = { ...prior, ...patch, session_id: sessionId };
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(registry, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    });
  } catch {
    /* 映射持久化失败不致命（下一次调用重试；身份主通道 = _meta） */
  }
}

export interface CallMeta {
  session_id?: unknown;
  runtime_scope?: unknown;
  progressToken?: unknown;
  [k: string]: unknown;
}

export interface ResolveIdentityOptions {
  dataRoot: string;
  /** callTool params._meta（可能缺失）。 */
  meta: CallMeta | undefined;
  /** daemon 进程启动时刻（ms；hook 映射兜底的时间窗锚点）。 */
  bootTimeMs: number;
  /** 兜底候选窗口（默认 ±300s：SessionStart hook 与 daemon 拉起同窗）。 */
  fallbackWindowMs?: number;
  /** 当前时刻注入（测试）。 */
  now?: () => number;
}

/**
 * 身份解析三分支（F12）：
 *  ① _meta.session_id 非空字符串 → 主通道（首调持久化 session-map）；
 *  ② 缺失 → hook env overlay 映射兜底（启动窗内恰一个 hook 注册候选）；
 *  ③ 都缺 → fail-closed TEAM_NOT_MEMBER。
 */
export function resolveIdentity(opts: ResolveIdentityOptions): ResolvedIdentity {
  const metaSession = opts.meta?.session_id;
  let sessionId: string | undefined;
  let source: ResolvedIdentity["source"] = "meta";
  if (typeof metaSession === "string" && metaSession.length > 0) {
    sessionId = metaSession;
  } else {
    // 兜底：hook 映射（env overlay ZCODE_SESSION_ID 由 SessionStart hook 落盘）
    const windowMs = opts.fallbackWindowMs ?? 300_000;
    const candidates: SessionMapEntry[] = [];
    for (const entry of Object.values(readSessionRegistry(opts.dataRoot))) {
      if (typeof entry?.session_id !== "string") continue;
      const firstSeen = entry.firstSeen !== undefined ? Date.parse(entry.firstSeen) : NaN;
      if (Number.isNaN(firstSeen)) continue;
      if (Math.abs(firstSeen - opts.bootTimeMs) <= windowMs) candidates.push(entry);
    }
    if (candidates.length === 1) {
      sessionId = candidates[0].session_id;
      source = "hook-map";
    }
  }
  if (sessionId === undefined) {
    // ③ fail-closed（消息 = 02 §5.2 模板；无身份时 <id> 占位为 <unknown>——stage-3 登记口径）
    throw notMemberError("<unknown>");
  }

  const registry = readSessionRegistry(opts.dataRoot);
  const entry = registry[safeSessionKey(sessionId)] ?? {};
  const runtimeScope = opts.meta?.runtime_scope;
  const hookRegistered = entry.hookRegistered === true;

  // teammate 映射（provider/stage-4 写入；契约测试注入）
  if (entry.role === "teammate" && typeof entry.teamId === "string" && entry.teamId.length > 0) {
    touch(opts, sessionId, entry, source);
    // 域侧 callerId = 成员 id（session-map.memberId；provider 落盘的「真实会话 id ↔ childId」映射）。
    // 无 memberId 映射时退 sessionId → 域侧成员表查不到 → requireMembership → TEAM_NOT_MEMBER
    // （fail-closed 方向正确；stage-4 provider 接线后必有映射）。
    const memberId = typeof entry.memberId === "string" && entry.memberId.length > 0 ? entry.memberId : sessionId;
    return {
      sessionId,
      teamId: entry.teamId,
      role: "teammate",
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : sessionId,
      agentId: memberId,
      source,
      hookRegistered,
    };
  }

  // 一次性子代理（runtime_scope=subagent 且无 teammate 映射）→ 非成员（安装宽松、执行严格）
  if (runtimeScope === "subagent") {
    throw notMemberError(sessionId);
  }

  // 隐式 Lead：teamId = 自身 session_id（02 §2）；callerId = sessionId = teamId
  touch(opts, sessionId, entry, source);
  return {
    sessionId,
    teamId: sessionId,
    role: "lead",
    name: "lead",
    agentId: sessionId,
    source,
    hookRegistered,
  };
}

/** TEAM_NOT_MEMBER 统一构造（消息 = 02 §5.2 模板，逐字）。 */
function notMemberError(agentId: string): TeamError {
  return new TeamError(
    "TEAM_NOT_MEMBER",
    `agent "${agentId}" is not a member of an active Agent Team`,
  );
}

/** 首调持久化（T3.1）：不覆盖 hook 注册标记与 teammate 映射。 */
function touch(
  opts: ResolveIdentityOptions,
  sessionId: string,
  entry: SessionMapEntry,
  source: ResolvedIdentity["source"],
): void {
  const patch: SessionMapEntry = {
    lastSeen: ts(),
    ...(entry.firstSeen === undefined ? { firstSeen: ts() } : {}),
    ...(entry.hookRegistered === true ? { hookRegistered: true } : {}),
  };
  if (entry.session_id === undefined || source === "hook-map") patch.session_id = sessionId;
  upsertSessionEntry(opts.dataRoot, sessionId, patch);
}
