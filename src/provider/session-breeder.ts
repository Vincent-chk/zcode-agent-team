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
import type { MemberModelSelection } from "./model-selection.js";

export type IsolationMode = "child" | "legacy";

/** 会话库默认路径（与 TranscriptReader 同源；只读使用）。 */
export function defaultSessionDbPath(): string {
  return process.env.TEAM_DB_PATH ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export interface BreedInput {
  teamId: string;
  /** 回退工作区（当会话库查不到 Lead 目录时使用）。 */
  workspacePath: string;
  /**
   * 子会话模型（0.4.0：唯一来源 = 继承 Lead 的最新已确认选择；缺省 = 不调 setModel）。
   * 应用失败**不再容忍继续**——dispose 已培育会话并抛错（绝不静默回退宿主缺省冒充继承成功）。
   */
  modelSelection?: MemberModelSelection;
  timeoutMs?: number;
  /** 由完整 origin 预写的固定身份；恢复沿用同一命令/预分配 anchor。 */
  anchorCommandId?: string;
  childCommandId?: string;
  anchorSessionId?: string;
  /** 只有已获得宿主 anchor/child 证据才进入重启查询路径。 */
  recoveryEvidence?: boolean;
  signal?: AbortSignal;
  /** 只在取得宿主新证据时回调，供 origin 原子更新。 */
  onProgress?: (progress: { anchorSessionId?: string; childSessionId?: string; stage: string }) => boolean | void;
}

export interface BreedResult {
  anchorSessionId: string;
  childSessionId: string;
  elapsedMs: number;
  /** 实际解析出的 workspace（Lead 会话目录优先；轮次 cwd 必须与之一致）。 */
  workspacePath: string;
  /** 实际生效的模型选择（setModel 成功即等于入参；失败路径直接抛错，不会出现缺省）。 */
  appliedModel?: MemberModelSelection;
}

export type BreedFailure =
  | "unsupported"
  | "spawn-failed"
  | "startup-timeout"
  | "create-rejected"
  | "command-rejected"
  | "model-rejected"
  | "outcome-unknown";

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
    const anchorCommandId =
      input.anchorCommandId ?? `team-anchor-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const childCommandId =
      input.childCommandId ?? `team-child-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const commandTimeoutMs = input.timeoutMs ?? 30_000;
    const queryTimeoutMs = Math.min(input.timeoutMs ?? 5_000, 5_000);
    // 预分配 id 不是宿主已创建的证据；只有 accepted/duplicate 才允许失败清理。
    let anchorSessionId: string | null = input.anchorSessionId ?? null;
    let childSessionId: string | null = null;
    let anchorEvidence = false;
    try {
      // timeoutMs 限制单个命令/恢复查询；进程启动始终使用 readyTimeoutMs。
      const readyTimeoutMs = this.readyTimeoutMs;
      const ready = await client.waitReady(readyTimeoutMs);
      if (!ready) {
        throw new BreedError(
          "startup-timeout",
          `app-server did not become ready within ${readyTimeoutMs}ms`,
        );
      }
      if (input.signal?.aborted) {
        throw new BreedError("outcome-unknown", abortDescription(input.signal, "session breeding aborted"));
      }

      let priorChild: CommandAck | "unknown" | undefined;
      const hasRecoveryIdentity =
        input.anchorCommandId !== undefined &&
        input.childCommandId !== undefined &&
        input.anchorSessionId !== undefined && input.recoveryEvidence === true;
      if (hasRecoveryIdentity) {
        // origin 已经固定了身份：每次调用先查，而不是先重发。恢复时因此可以零条 v4/command。
        const priorAnchor = await this.#queryCommand(client, {
          commandId: anchorCommandId,
          sessionId: null,
          type: "createSession",
          signal: input.signal,
          timeoutMs: queryTimeoutMs,
        });
        if (priorAnchor !== "unknown") {
          anchorSessionId = createdSessionId(priorAnchor, {
            type: "createSession",
            expectedSessionId: input.anchorSessionId,
            failure: "create-rejected",
            mismatchFailure: "outcome-unknown",
          });
          anchorEvidence = true;
        } else {
          anchorSessionId = await this.#findPreallocatedAnchor(client, {
            anchorSessionId: input.anchorSessionId!,
            workspacePath,
            signal: input.signal,
            timeoutMs: queryTimeoutMs,
          });
          anchorEvidence = anchorSessionId !== null;
        }
        if (anchorEvidence && anchorSessionId !== null) {
          this.reportProgress(input,{ anchorSessionId, stage: "anchor-recovered" });
          priorChild = await this.#queryCommand(client, {
            commandId: childCommandId,
            sessionId: anchorSessionId,
            type: "createSelectionSideSession",
            signal: input.signal,
            timeoutMs: queryTimeoutMs,
          });
        }
      }
      if (!anchorEvidence) {
        const anchorCall = await this.#runCommand(client, {
          commandId: anchorCommandId,
          sessionId: null,
          issuedAt: startedAt,
          type: "createSession",
          payload: {
            ...(input.anchorSessionId !== undefined ? { sessionId: input.anchorSessionId } : {}),
            workspaceId: workspacePath,
            permissionScope: "session",
          },
          signal: input.signal,
          commandTimeoutMs,
          queryTimeoutMs,
        });
        const createdAnchorId = createdSessionId(anchorCall.ack, {
          type: "createSession",
          expectedSessionId: input.anchorSessionId,
          failure: "create-rejected",
          mismatchFailure: anchorCall.recovered ? "outcome-unknown" : "create-rejected",
        });
        anchorSessionId = createdAnchorId;
        anchorEvidence = true;
        this.reportProgress(input,{ anchorSessionId: createdAnchorId, stage: "anchor-created" });
      }

      if (anchorSessionId === null) {
        throw new BreedError("outcome-unknown", "anchor has no confirmed session id; not creating a replacement");
      }
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

      const commandArgs = {
        commandId: childCommandId,
        sessionId: anchorSessionId,
        issuedAt: this.now(),
        type: "createSelectionSideSession",
        payload: {},
        signal: input.signal,
        commandTimeoutMs,
        queryTimeoutMs,
      } as const;
      let sideCall: CommandCallResult;
      let recoveredChildNeedsResume = false;
      if (priorChild !== undefined && priorChild !== "unknown") {
        recoveredChildNeedsResume = input.modelSelection !== undefined;
        sideCall = { ack: priorChild, recovered: true };
      } else {
        // 仅在本次调用尚未发过 child 命令且 query 确定无终态时，用原固定 id 首发。
        sideCall = await this.#runCommand(client, commandArgs);
      }
      const createdChildId = createdSessionId(sideCall.ack, {
        type: "createSelectionSideSession",
        failure: "command-rejected",
        mismatchFailure: sideCall.recovered ? "outcome-unknown" : "command-rejected",
      });
      childSessionId = createdChildId;
      this.reportProgress(input,{
        anchorSessionId,
        childSessionId: createdChildId,
        stage: "child-created",
      });
      if (recoveredChildNeedsResume) {
        await client.rpc(
          "session/resume",
          { sessionId: createdChildId },
          queryTimeoutMs,
          { signal: input.signal },
        );
      }

      // 同实例内 child 活跃（Round A PoC-1 已证）：setModel 落 runtime/model_selection 条目，
      // 后续 `--resume` 每轮生效。0.4.0「同步失败即阻止」：继承选择应用失败 = 直接抛错并回收
      // 已培育会话，绝不带着宿主缺省模型继续 spawn（那会把"没跟上 Lead"伪装成继承成功）。
      let appliedModel: MemberModelSelection | undefined;
      if (input.modelSelection !== undefined) {
        try {
          await this.#setModel(client, childSessionId, input.modelSelection, input.signal);
          appliedModel = input.modelSelection;
          this.log({
            event: "model-set",
            teamId: input.teamId,
            childSessionId,
            providerId: input.modelSelection.providerId,
            modelId: input.modelSelection.modelId,
            reasoningLevel: input.modelSelection.reasoningLevel ?? null,
          });
          this.reportProgress(input,{
            anchorSessionId,
            childSessionId,
            stage: "model-applied",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log({
            event: "model-set-failed",
            teamId: input.teamId,
            childSessionId,
            providerId: input.modelSelection.providerId,
            modelId: input.modelSelection.modelId,
            message,
          });
          if (input.signal?.aborted) {
            throw new BreedError("outcome-unknown", abortDescription(input.signal, message));
          }
          throw new BreedError(
            "model-rejected",
            `member could not use the inherited model ${input.modelSelection.providerId}/${input.modelSelection.modelId}: ${message}`,
          );
        }
      }

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
      return {
        anchorSessionId,
        childSessionId,
        elapsedMs,
        workspacePath,
        ...(appliedModel !== undefined ? { appliedModel } : {}),
      };
    } catch (err) {
      const stderr = client.getStderr().slice(-800);
      // outcome-unknown/abort 可能有迟到的宿主编排副作用；不得把它当成确定失败回收。
      const mayDispose =
        anchorEvidence && !(err instanceof BreedError && err.code === "outcome-unknown") && !input.signal?.aborted;
      if (err instanceof BreedError) {
        this.log({
          event: "session-breed-failed",
          teamId: input.teamId,
          code: err.code,
          message: err.message,
          stderr,
          anchorSessionId,
          childSessionId,
        });
        if (mayDispose && anchorSessionId !== null) {
          this.disposeBredSessions({ anchorSessionId, workspacePath });
        }
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code: BreedFailure = input.signal?.aborted
        ? "outcome-unknown"
        : /timeout/i.test(message)
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
      if (mayDispose && anchorSessionId !== null) {
        this.disposeBredSessions({ anchorSessionId, workspacePath });
      }
      throw new BreedError(code, `${message}${stderr.length > 0 ? ` | stderr: ${stderr}` : ""}`);
    } finally {
      await client.close();
    }
  }

  /** 每轮执行前同步（0.4.0）：同 createChild 会话活跃前提下 setModel；失败返回原因（调用方阻止本轮）。 */
  async applyModelSelection(input: {
    sessionId: string;
    workspacePath: string;
    selection: MemberModelSelection;
    /** 复用 createChild 的 ready 上限（测试可收紧）。 */
    timeoutMs?: number;
  }): Promise<{ applied: boolean; reason?: string }> {
    const readyTimeoutMs = input.timeoutMs ?? this.readyTimeoutMs;
    let client: AppServerClient;
    try {
      client = this.#spawnClient(input.workspacePath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log({ event: "model-apply-failed", sessionId: input.sessionId, reason });
      return { applied: false, reason };
    }
    try {
      const ready = await client.waitReady(readyTimeoutMs);
      if (!ready) {
        const reason = `app-server did not become ready within ${readyTimeoutMs}ms`;
        this.log({ event: "model-apply-failed", sessionId: input.sessionId, reason });
        return { applied: false, reason };
      }
      await client.rpc("session/resume", { sessionId: input.sessionId }, 20_000);
      await this.#setModel(client, input.sessionId, input.selection);
      this.log({
        event: "model-applied",
        sessionId: input.sessionId,
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        reasoningLevel: input.selection.reasoningLevel ?? null,
      });
      return { applied: true };
    } catch (err) {
      // 错误文本可能含协议 message；不含任何 result 体（见上）。
      const reason = err instanceof Error ? err.message : String(err);
      this.log({ event: "model-apply-failed", sessionId: input.sessionId, reason });
      return { applied: false, reason };
    } finally {
      await client.close();
    }
  }

  /**
   * 应用一次模型选择（createChild 首轮 / launchTurn 每轮同步共用）。
   * result 是巨型消息快照（PoC 事实 1）：只记目标三元组与错误文本，绝不整包落日志。
   */
  /** setModel 请求体（createChild / applyModelSelection 共用；persistAsWorkspaceLastUsed 恒 false）。 */
  async #setModel(
    client: AppServerClient,
    sessionId: string,
    selection: MemberModelSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    await client.rpc(
      "session/setModel",
      {
        sessionId,
        model: {
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(selection.reasoningLevel !== undefined
            ? { options: { reasoningLevel: selection.reasoningLevel } }
            : {}),
        },
        persistAsWorkspaceLastUsed: false,
      },
      20_000,
      { signal },
    );
  }

  private reportProgress(input: BreedInput, progress: { anchorSessionId?: string; childSessionId?: string; stage: string }): void {
    if (input.onProgress?.(progress) === false) {
      throw new BreedError("outcome-unknown", "coordinator generation revoked; host evidence is retained for recovery");
    }
  }

  async #runCommand(
    client: AppServerClient,
    input: CommandRequest & { commandTimeoutMs: number; queryTimeoutMs: number },
  ): Promise<CommandCallResult> {
    try {
      const ack = await client.rpc<CommandAck>("v4/command", commandEnvelope(input), input.commandTimeoutMs, {
        signal: input.signal,
      });
      return { ack, recovered: false };
    } catch (err) {
      if (input.signal?.aborted) {
        throw new BreedError("outcome-unknown", abortDescription(input.signal, errorDescription(err)));
      }
      const message = errorDescription(err);
      // 协议/传输异常也不能证明命令未落库；在 client 仍存活时有且仅有一次查询机会。
      // 明确缺参/协议版本拒绝没有未知副作用，保留旧的 unsupported 分类。
      if (/invalid params|method not found|invalid request/i.test(message)) throw err;
      const ack = await this.#queryCommand(client, {
        commandId: input.commandId,
        sessionId: input.sessionId,
        type: input.type,
        signal: input.signal,
        timeoutMs: input.queryTimeoutMs,
      });
      if (ack === "unknown") {
        throw new BreedError("outcome-unknown", `${input.type} outcome is unknown; original command was not replayed`);
      }
      return { ack, recovered: true };
    }
  }

  async #queryCommand(
    client: AppServerClient,
    input: CommandQuery,
  ): Promise<CommandAck | "unknown"> {
    let queried: CommandsQueryResult;
    try {
      queried = await client.rpc<CommandsQueryResult>(
        "v4/commands/query",
        { commands: [{ sessionId: input.sessionId, commandId: input.commandId }] },
        input.timeoutMs,
        { signal: input.signal },
      );
    } catch (err) {
      const message = errorDescription(err);
      throw new BreedError(
        "outcome-unknown",
        `${input.type} outcome is unknown; command query could not establish a final result: ${message}`,
      );
    }
    const matches = (queried?.results ?? []).filter(
      (entry) => entry?.key?.commandId === input.commandId && entry.key.sessionId === input.sessionId,
    );
    const result = matches.length === 1 ? matches[0]!.result : "unknown";
    if (result === "unknown") return "unknown";
    if (typeof result !== "object" || result === null) {
      throw new BreedError(
        "outcome-unknown",
        `${input.type} outcome is unknown; malformed command result for "${input.commandId}"`,
      );
    }
    if (result.status === "accepted" || result.status === "duplicate") {
      return result;
    }
    if (isExplicitRejection(result)) {
      throw new BreedError(
        input.type === "createSession" ? "create-rejected" : "command-rejected",
        describeAck(input.type, result),
      );
    }
    throw new BreedError(
      "outcome-unknown",
      `${input.type} outcome is unknown; command "${input.commandId}" has non-final status "${result.status ?? "missing"}"`,
    );
  }

  /** 仅对预分配 anchor 使用：必须同时证明 id、workspace 和非子会话类型，绝不认领近似对象。 */
  async #findPreallocatedAnchor(
    client: AppServerClient,
    input: {
      anchorSessionId: string;
      workspacePath: string;
      signal?: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<string | null> {
    let listed: SessionListResult;
    try {
      listed = await client.rpc<SessionListResult>(
        "session/list",
        { sessionIds: [input.anchorSessionId] },
        input.timeoutMs,
        { signal: input.signal },
      );
    } catch (err) {
      throw new BreedError(
        "outcome-unknown",
        `createSession outcome is unknown; anchor lookup failed: ${errorDescription(err)}`,
      );
    }
    const matches = (listed?.sessions ?? []).filter((session) => session?.sessionId === input.anchorSessionId);
    if (matches.length === 0) return null;
    const session = matches[0]!;
    const sessionWorkspace = session.workspace?.workspacePath;
    if (
      matches.length !== 1 ||
      typeof sessionWorkspace !== "string" ||
      path.resolve(sessionWorkspace) !== path.resolve(input.workspacePath) ||
      session.sessionKind !== "interactive"
    ) {
      throw new BreedError(
        "outcome-unknown",
        `createSession outcome is unknown; preallocated anchor "${input.anchorSessionId}" failed workspace/type verification`,
      );
    }
    return input.anchorSessionId;
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
  commandId?: string;
  status?: string;
  reasonCode?: string;
  message?: string;
  result?: { type?: string; sessionId?: string };
}

type BreedCommandType = "createSession" | "createSelectionSideSession";

interface CommandRequest {
  commandId: string;
  sessionId: string | null;
  issuedAt: number;
  type: BreedCommandType;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}

interface CommandQuery {
  commandId: string;
  sessionId: string | null;
  type: BreedCommandType;
  signal?: AbortSignal;
  timeoutMs: number;
}

interface CommandCallResult {
  ack: CommandAck;
  recovered: boolean;
}

interface CommandsQueryResult {
  results?: Array<{
    key?: { sessionId?: string | null; commandId?: string };
    result?: CommandAck | "unknown";
  }>;
}

interface SessionListResult {
  sessions?: Array<{
    sessionId?: string;
    sessionKind?: string;
    workspace?: { workspacePath?: string };
  }>;
}

function commandEnvelope(input: CommandRequest): Record<string, unknown> {
  return {
    commandId: input.commandId,
    clientId: "agent-team",
    sessionId: input.sessionId,
    issuedAt: input.issuedAt,
    type: input.type,
    payload: input.payload,
  };
}

function createdSessionId(
  ack: CommandAck,
  input: {
    type: BreedCommandType;
    expectedSessionId?: string;
    failure: "create-rejected" | "command-rejected";
    mismatchFailure: BreedFailure;
  },
): string {
  if (ack.status === "accepted" || ack.status === "duplicate") {
    const id = ack.result?.sessionId;
    if (
      ack.result?.type === input.type &&
      typeof id === "string" &&
      id.length > 0 &&
      (input.expectedSessionId === undefined || id === input.expectedSessionId)
    ) {
      return id;
    }
    // 查询结果必须精确匹配命令类型及（预分配的）session id；绝不认领另一条命令的会话。
    throw new BreedError(
      input.mismatchFailure,
      `${input.type} returned mismatched result: ${describeAck(input.type, ack)}`,
    );
  }
  if (isExplicitRejection(ack)) throw new BreedError(input.failure, describeAck(input.type, ack));
  // accepted 之外的状态绝不能被当成创建成功；stale/noop 等无法证明副作用已落定。
  throw new BreedError("outcome-unknown", describeAck(input.type, ack));
}

function isExplicitRejection(ack: CommandAck): boolean {
  return ack.status === "rejected" || ack.status === "failed" || ack.status === undefined;
}

function abortDescription(signal: AbortSignal, fallback: string): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
}

function errorDescription(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeAck(type: string, ack: CommandAck | undefined): string {
  const status = ack?.reasonCode ?? ack?.status ?? "no session id";
  return `${type} rejected: ${status}${ack?.message !== undefined ? ` (${ack.message})` : ""}`;
}

export function isolationModeFromEnv(env: NodeJS.ProcessEnv = process.env): IsolationMode {
  return env.TEAM_SESSION_ISOLATION === "legacy" ? "legacy" : "child";
}
