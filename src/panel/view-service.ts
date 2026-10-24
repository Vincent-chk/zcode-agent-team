// 面板视图服务（stage-5 T5.2 数据面；Gate-4 移交项落地）：
// team://view = 真实团队投影视图帧（接口草案 §5 帧内容 + 增补字段，见 ui-core/view.ts）。
// 职责：
//  - buildFrame(meta)：身份解析 → 构帧（buildFrameForIdentity）；
//  - buildFrameForIdentity：MEMBER_VIEW 行（status/model 活性呈现，协调者全保真/代理保守）
//    ⊕ 重放视图（tasks/failure/seq）⊕ 成员会话 id（origin.json 回填）；无团队事件 →
//    team:null 空帧（不开 host、不建目录——面板呈现 §10.4 加载/不可用条）；
//  - contentKey(frame)：推帧判定键（去 meta.generatedAt/sessionId 易变字段——mailbox-only
//    变化不进帧 → 键不变 → 不推帧，F02 口径）；
//  - 重放缓存：events.jsonl/checkpoint 指纹（mtime+size）未变 → 复用上次重放（轮询不全量重放）；
//  - ui/view-snapshot.json（teams/<id>/ui/；05 §2 布局图）：帧内容变化即落盘——断线重连
//    基线 + daemon 回收后新实例的即时首帧来源。
// 只读纪律：本服务零写入团队状态（snapshot 为 UI 缓存文件，非事件日志）。

import fs from "node:fs";
import path from "node:path";
import { teamPaths } from "../coord/paths.js";
import { load, type LoadedTeam } from "../coord/replay.js";
import { memberPaths, readOrigin } from "../provider/member-files.js";
import { resolveIdentity, readSessionRegistry, type CallMeta, type ResolvedIdentity } from "../mcp/identity.js";
import type { TeamToolBackend } from "../mcp/backend.js";
import type { MemberRow } from "../domain/roster.js";
import type { TeamState } from "../domain/projection.js";
import { emptyViewFrame, VIEW_STATE_VERSION, type ViewFrame, type ViewFrameMember } from "../ui-core/view.js";
import { ts } from "../shared.js";

export interface ViewServiceDeps {
  backend: TeamToolBackend;
  dataRoot: string;
  bootTimeMs: number;
  now?: () => number;
  warn?: (message: string) => void;
}

interface ReplayCacheEntry {
  fingerprint: string;
  loaded: LoadedTeam;
}

export function snapshotFile(teamDir: string): string {
  return path.join(teamDir, "ui", "view-snapshot.json");
}

/**
 * 成员会话 id 解析（detail 下钻/复制会话 id 的数据源）：
 * ① origin.json sessionId（provider 落盘权威）→ ② session-map 反查（memberId 匹配的
 * 注册条目；teammate SessionStart hook 经 TEAM_SPAWN_IDENTITY 写入的第二来源）。
 */
export function resolveMemberSession(
  teamDir: string,
  dataRoot: string,
  memberId: string,
): string | undefined {
  const origin = readOrigin(memberPaths(teamDir, memberId))?.sessionId;
  if (origin !== null && origin !== undefined) return origin;
  for (const entry of Object.values(readSessionRegistry(dataRoot))) {
    if (entry.memberId === memberId && typeof entry.session_id === "string") return entry.session_id;
  }
  return undefined;
}

/** events.jsonl + checkpoint 指纹（重放缓存键；文件缺失 → "missing"）。 */
function replayFingerprint(teamDir: string): string {
  const parts: string[] = [];
  for (const f of [path.join(teamDir, "events.jsonl"), path.join(teamDir, "checkpoint.json")]) {
    try {
      const st = fs.statSync(f);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("|");
}

/**
 * 静态帧（无活性探测的保守派生；team-ctl widget / 快照页 / listAgents 失败兜底共用）。
 * 成员状态 = phase 映射（active→inactive 保守，D16a 同口径；lead 恒 inactive——静态载体
 * 无「当前运行」信息）。
 */
export function buildStaticFrame(
  loaded: Pick<LoadedTeam, "state" | "seq" | "view">,
  teamId: string,
  generatedAt: string,
  sessionId?: string,
  teamDir?: string,
  dataRoot?: string,
): ViewFrame {
  const state = loaded.state;
  const members: ViewFrameMember[] = [
    { target: "lead", role: "lead", status: "inactive", diagnostics: [], id: teamId, sessionId: teamId },
  ];
  for (const m of state.members) {
    const memberSessionId = teamDir !== undefined && dataRoot !== undefined
      ? resolveMemberSession(teamDir, dataRoot, m.id)
      : undefined;
    members.push({
      target: m.name,
      role: "teammate",
      status: m.phase === "failed" ? "failed" : m.phase === "provisioning" ? "provisioning" : "inactive",
      description: m.description,
      provider: m.provider,
      context: m.context,
      diagnostics: m.error !== undefined ? [m.error] : [],
      id: m.id,
      ...(memberSessionId !== undefined ? { sessionId: memberSessionId } : {}),
    });
  }
  return {
    type: "view",
    stateVersion: VIEW_STATE_VERSION,
    team: {
      teamId,
      status: state.failure !== undefined ? "failure" : "active",
      ...(state.failure !== undefined ? { failure: state.failure } : {}),
      seq: loaded.seq,
    },
    members,
    tasks: loaded.view.tasks,
    meta: {
      generatedAt,
      revision: loaded.seq,
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  };
}

/** 重放缓存上限（LRU）：长驻 daemon 访问过很多团队时不无限占用内存。 */
const REPLAY_CACHE_MAX = 16;

export class PanelViewService {
  private readonly replayCache = new Map<string, ReplayCacheEntry>();

  constructor(private readonly deps: ViewServiceDeps) {}

  /**
   * 推帧判定键：仅覆盖面板**渲染面**（team.status/failure + members + tasks）。
   * 不含 seq/revision——mailbox-only 变化会推进 seq（team/message[/delivered] 事件），
   * 但 members/tasks/failure 不变 → 键不变 → 不推帧（F02「mailbox-only 不发帧」口径）。
   */
  contentKey(frame: ViewFrame): string {
    return JSON.stringify({
      // teamId 必须入键：切团队/会话后即便 members/tasks 形状巧合相同，也不得复用上一团队的键。
      teamId: frame.team?.teamId ?? null,
      status: frame.team?.status ?? null,
      failure: frame.team?.failure ?? null,
      members: frame.members,
      tasks: frame.tasks,
    });
  }

  /**
   * 构建指定会话的团队视图帧。
   * 身份不可解析（无 _meta 且无 hook 映射）→ team:null 空帧（面板呈现加载/不可用，
   * 不向订阅者抛错）；团队无事件（隐式 Lead 未建团）→ team:null 空帧（不开 host）。
   */
  async buildFrame(meta: CallMeta | undefined, sessionIdHint?: string): Promise<ViewFrame> {
    const nowIso = ts();
    let identity: ResolvedIdentity;
    try {
      identity = resolveIdentity({
        dataRoot: this.deps.dataRoot,
        meta,
        bootTimeMs: this.deps.bootTimeMs,
      });
    } catch (err) {
      this.deps.warn?.(`panel view: identity unresolved (${err instanceof Error ? err.message : String(err)})`);
      return emptyViewFrame(nowIso, sessionIdHint);
    }
    return this.buildFrameForIdentity(identity, nowIso);
  }

  /** 身份已解析的构帧（team_panel_call refresh 与订阅轮询共用）。 */
  async buildFrameForIdentity(identity: ResolvedIdentity, nowIso = ts()): Promise<ViewFrame> {
    const teamId = identity.teamId;
    const paths = teamPaths(this.deps.dataRoot, teamId);
    // 无团队事件 → team:null 空帧（不触发 host open/建目录/抢锁——面板纯只读呈现）
    if (!fs.existsSync(paths.eventsFile)) {
      const snap = this.readSnapshot(teamId);
      if (snap === undefined) {
        return { ...emptyViewFrame(nowIso, identity.sessionId), team: null };
      }
      // 快照在场但事件日志被清（异常）：快照即基线（F03 断线口径）
      return { ...snap, meta: { ...snap.meta, generatedAt: nowIso, sessionId: identity.sessionId } };
    }
    const loaded = await this.replay(paths.teamDir, teamId);
    const state = loaded.state;

    // 成员行 = MEMBER_VIEW（活性/模型呈现）⊕ { id, sessionId }
    let rows: MemberRow[] = [];
    try {
      rows = await this.deps.backend.listAgents(identity);
    } catch (err) {
      // C5 fail-closed（failure 终态 → 全员非成员）等：视图仍要给面板 → 静态保守派生
      this.deps.warn?.(`panel view: listAgents failed (${err instanceof Error ? err.message : String(err)})`);
    }

    if (rows.length === 0) {
      return buildStaticFrame(loaded, teamId, nowIso, identity.sessionId, paths.teamDir, this.deps.dataRoot);
    }

    const members: ViewFrameMember[] = rows.map((row) => {
      const snap = row.role === "lead"
        ? undefined
        : state.members.find((m) => m.name === row.target);
      const id = row.role === "lead" ? teamId : (snap?.id ?? row.target);
      const sessionId = row.role === "lead"
        ? teamId
        : resolveMemberSession(paths.teamDir, this.deps.dataRoot, id);
      return { ...row, id, ...(sessionId !== undefined ? { sessionId } : {}) };
    });

    return {
      type: "view",
      stateVersion: VIEW_STATE_VERSION,
      team: {
        teamId,
        status: state.failure !== undefined ? "failure" : "active",
        ...(state.failure !== undefined ? { failure: state.failure } : {}),
        seq: loaded.seq,
      },
      members,
      tasks: loaded.view.tasks,
      meta: {
        generatedAt: nowIso,
        revision: loaded.seq,
        sessionId: identity.sessionId,
      },
    };
  }

  /** 重放（带指纹缓存；LRU：命中移到队尾，超限淘汰最久未用）。 */
  private async replay(teamDir: string, teamId: string): Promise<LoadedTeam> {
    const fingerprint = replayFingerprint(teamDir);
    const cached = this.replayCache.get(teamId);
    if (cached !== undefined && cached.fingerprint === fingerprint) {
      this.replayCache.delete(teamId);
      this.replayCache.set(teamId, cached);
      return cached.loaded;
    }
    const loaded = await load(teamDir, teamId);
    this.replayCache.delete(teamId);
    this.replayCache.set(teamId, { fingerprint, loaded });
    while (this.replayCache.size > REPLAY_CACHE_MAX) {
      const oldest = this.replayCache.keys().next().value;
      if (oldest === undefined) break;
      this.replayCache.delete(oldest);
    }
    return loaded;
  }

  /** 帧落盘（teams/<id>/ui/view-snapshot.json；tmp+rename 原子替换；失败仅告警）。 */
  writeSnapshot(teamId: string, frame: ViewFrame): void {
    const file = snapshotFile(teamPaths(this.deps.dataRoot, teamId).teamDir);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(frame), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      this.deps.warn?.(`panel view: snapshot write failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** 读快照（断线重连基线/daemon 冷启动首帧；无/损坏 → undefined）。 */
  readSnapshot(teamId: string): ViewFrame | undefined {
    const file = snapshotFile(teamPaths(this.deps.dataRoot, teamId).teamDir);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ViewFrame;
      return parsed.type === "view" && parsed.stateVersion === VIEW_STATE_VERSION ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** 重放态直读（detail 合成/team-ctl 共用；无缓存需求场景）。 */
  async loadState(teamId: string): Promise<TeamState> {
    const { teamDir } = teamPaths(this.deps.dataRoot, teamId);
    const loaded = await this.replay(teamDir, teamId);
    return loaded.state;
  }
}
