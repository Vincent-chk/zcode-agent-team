// 会话培育器（stage-6 会话隔离）：为每个 teammate 造一个宿主原生隐藏子会话。
//
// 背景（2026-10-18 实测）：`zcode -p` 直接建的会话是顶层 `interactive`，桌面 sessions-index
// 基线补齐会把它补登进 tasks-index，于是与 Lead 平级出现在左侧任务栏。
//
// 方案（PoC 已验证 P1/P2/P3/P6）：
//   1) `v4/command createSession`（permissionScope=session）在项目 workspace 内建一个
//      **已持久化的空 anchor**（title="Untitled session"，无消息）；
//   2) 在 anchor 下 `createSelectionSideSession` → child 为 `task_type=selection_side_chat`、
//      `parent_id=anchor`；该类型被 sessions-index/task-index 白名单排除（宿主保证隐藏）；
//   3) 给 anchor 写 tasks-index tombstone（deleted=1），保证重启后基线补登也不会露出。
//
// 只用宿主公开的 app-server 协议方法；不改 db.sqlite（只读），tasks-index 只写 anchor 自己一行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppServerClient } from "./app-server-client.mjs";
import { tombstoneAnchor, defaultTasksIndexPath } from "../sidebar/tasks-index.js";
import { resolveZcodeBin, type ZcodeBin } from "./zcode-bin.js";

export type IsolationMode = "child" | "legacy";

/** 会话库默认路径（与 TranscriptReader 同源；只读使用）。 */
export function defaultSessionDbPath(): string {
  return process.env.TEAM_DB_PATH ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export interface BreedInput {
  teamId: string;
  /** 回退工作区（当会话库查不到 Lead 目录时使用）。 */
  workspacePath: string;
  timeoutMs?: number;
}

export interface BreedResult {
  anchorSessionId: string;
  childSessionId: string;
  elapsedMs: number;
  /** 实际解析出的 workspace（Lead 会话目录优先；轮次 cwd 必须与之一致）。 */
  workspacePath: string;
}

export type BreedFailure =
  | "unsupported"
  | "spawn-failed"
  | "startup-timeout"
  | "create-rejected"
  | "command-rejected";

export class BreedError extends Error {
  constructor(
    readonly code: BreedFailure,
    message: string,
  ) {
    super(message);
    this.name = "BreedError";
  }
}

export interface SessionBreederOptions {
  /** 任务索引路径（缺省 ~/.zcode/v2/tasks-index.sqlite；测试注入）。 */
  tasksIndexPath?: string;
  /** 会话库路径（只读；用于解析 Lead 的真实工作目录；缺省 ~/.zcode/cli/db/db.sqlite）。 */
  dbPath?: string;
  /** zcode 二进制（缺省 resolveZcodeBin）。 */
  zcode?: ZcodeBin;
  log?: (record: Record<string, unknown>) => void;
  now?: () => number;
  /** app-server ready 等待上限（缺省 20s）。 */
  readyTimeoutMs?: number;
}

export class AppServerSessionBreeder {
  private readonly zcode: ZcodeBin;
  private readonly tasksIndexPath: string;
  private readonly dbPath: string;
  private readonly log: (record: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;

  constructor(opts: SessionBreederOptions = {}) {
    this.zcode = opts.zcode ?? resolveZcodeBin();
    this.tasksIndexPath = opts.tasksIndexPath ?? defaultTasksIndexPath();
    this.dbPath = opts.dbPath ?? defaultSessionDbPath();
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
  }

  /**
   * 解析 Leader 会话的真实工作目录（只读）。
   * daemon 由宿主跨工作区复用，`TEAM_PROJECT_DIR` 可能来自首个启动工作区——
   * anchor 必须建在 Lead 自己的目录，否则 teammate 工具 cwd 会错。
   */
  resolveWorkspace(leadSessionId: string, fallback: string): string {
    if (!fs.existsSync(this.dbPath)) return path.resolve(fallback);
    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        const row = db.prepare("select directory from session where id = ?").get(leadSessionId) as
          | { directory?: string }
          | undefined;
        if (typeof row?.directory === "string" && row.directory.length > 0) {
          return path.resolve(row.directory);
        }
      } finally {
        db.close();
      }
    } catch {
      /* 读失败 → 回退 */
    }
    return path.resolve(fallback);
  }

  /**
   * 培育失败清理：把已创建的 anchor 再写一次 tombstone（幂等），防止 child 未建成时
   * anchor 暴露到左侧任务栏。仅 anchor 行（D25 白名单），不触碰其他行。
   */
  disposeBredSessions(input: { anchorSessionId: string; workspacePath: string }): { applied: boolean; reason?: string } {
    try {
      const result = tombstoneAnchor({
        taskId: input.anchorSessionId,
        workspacePath: input.workspacePath,
        dbPath: this.tasksIndexPath,
        now: this.now(),
      });
      this.log({
        event: "session-breed-dispose",
        anchorSessionId: input.anchorSessionId,
        applied: result.applied,
        reason: result.reason ?? null,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log({ event: "session-breed-dispose-failed", anchorSessionId: input.anchorSessionId, message });
      return { applied: false, reason: message };
    }
  }

  /** 造一个隐藏子会话；失败抛 BreedError（不回退成可见会话——DSH 口径：失败即 failed 成员）。 */
  async createChild(input: BreedInput): Promise<BreedResult> {
    const startedAt = this.now();
    const workspacePath = this.resolveWorkspace(input.teamId, input.workspacePath);
    const client = this.#spawnClient(workspacePath);
    let anchorSessionId: string | null = null;
    let childSessionId: string | null = null;
    try {
      const ready = await client.waitReady(input.timeoutMs ?? this.readyTimeoutMs);
      if (!ready) {
        throw new BreedError(
          "startup-timeout",
          `app-server did not become ready within ${input.timeoutMs ?? this.readyTimeoutMs}ms`,
        );
      }

      const anchorAck = await client.rpc<CommandAck>("v4/command", {
        commandId: `team-anchor-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        clientId: "agent-team",
        sessionId: null,
        issuedAt: startedAt,
        type: "createSession",
        payload: { workspaceId: workspacePath, permissionScope: "session" },
      });
      const createdAnchorId = anchorAck?.result?.sessionId;
      if (typeof createdAnchorId !== "string" || createdAnchorId.length === 0) {
        throw new BreedError("create-rejected", describeAck("createSession", anchorAck));
      }
      anchorSessionId = createdAnchorId;

      // anchor 必须先永久隐藏，再创建 child：child 失败时 anchor 也不会在任务栏露出。
      // tombstone（行不存在则先插入，避免基线补登后露出）。
      const tombstone = tombstoneAnchor({
        taskId: anchorSessionId,
        workspacePath,
        dbPath: this.tasksIndexPath,
        now: this.now(),
      });
      // row-not-owned = 同名 task 行属于用户/其他 workspace：绝不能静默放过（否则 anchor 会露出）。
      // tasks-index 缺失（纯 CLI 场景）允许降级，但日志保留 tombstone 状态。
      if (!tombstone.applied && tombstone.reason === "row-not-owned") {
        throw new BreedError(
          "create-rejected",
          `anchor "${anchorSessionId}" task row is not owned by agent-team; refusing to continue`,
        );
      }

      const sideAck = await client.rpc<CommandAck>("v4/command", {
        commandId: `team-child-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
        clientId: "agent-team",
        sessionId: anchorSessionId,
        issuedAt: this.now(),
        type: "createSelectionSideSession",
        payload: {},
      });
      const createdChildId = sideAck?.result?.sessionId;
      if (typeof createdChildId !== "string" || createdChildId.length === 0) {
        throw new BreedError("command-rejected", describeAck("createSelectionSideSession", sideAck));
      }
      childSessionId = createdChildId;

      if (anchorSessionId === null || childSessionId === null) {
        throw new BreedError("unsupported", "session breeding produced no anchor/child id");
      }
      const elapsedMs = this.now() - startedAt;
      this.log({
        event: "session-bred",
        teamId: input.teamId,
        anchorSessionId,
        childSessionId,
        tombstone,
        elapsedMs,
      });
      return { anchorSessionId, childSessionId, elapsedMs, workspacePath };
    } catch (err) {
      const stderr = client.getStderr().slice(-800);
      if (err instanceof BreedError) {
        // BreedError 也要留痕（此前直接 throw → 关键失败没有 anchor/child id）。
        this.log({
          event: "session-breed-failed",
          teamId: input.teamId,
          code: err.code,
          message: err.message,
          stderr,
          anchorSessionId,
          childSessionId,
        });
        if (anchorSessionId !== null) {
          this.disposeBredSessions({ anchorSessionId, workspacePath });
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code: BreedFailure = /timeout/i.test(message)
        ? "startup-timeout"
        : /exited|ENOENT|EACCES|spawn/i.test(message)
          ? "spawn-failed"
          : "unsupported";
      this.log({
        event: "session-breed-failed",
        teamId: input.teamId,
        code,
        message,
        stderr,
        anchorSessionId,
        childSessionId,
      });
      if (anchorSessionId !== null) {
        this.disposeBredSessions({ anchorSessionId, workspacePath });
      }
      throw new BreedError(code, `${message}${stderr.length > 0 ? ` | stderr: ${stderr}` : ""}`);
    } finally {
      await client.close();
    }
  }

  #spawnClient(workspacePath: string): AppServerClient {
    try {
      return AppServerClient.spawn({
        executable: this.zcode.command,
        argvPrefix: this.zcode.argvPrefix,
        cwd: workspacePath,
        log: this.log,
      });
    } catch (err) {
      throw new BreedError(
        "spawn-failed",
        `app-server spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface CommandAck {
  status?: string;
  reasonCode?: string;
  message?: string;
  result?: { type?: string; sessionId?: string };
}

function describeAck(type: string, ack: CommandAck | undefined): string {
  const status = ack?.reasonCode ?? ack?.status ?? "no session id";
  return `${type} rejected: ${status}${ack?.message !== undefined ? ` (${ack.message})` : ""}`;
}

export function isolationModeFromEnv(env: NodeJS.ProcessEnv = process.env): IsolationMode {
  return env.TEAM_SESSION_ISOLATION === "legacy" ? "legacy" : "child";
}
