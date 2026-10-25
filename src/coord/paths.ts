// 协调层存储布局（IO 仅限 src/coord；domain 保持零 IO）。
//   <dataRoot>/teams/<safeTeamId>/
//     events.jsonl        事件日志（O_APPEND 单写、行级原子）
//     checkpoint.json     冷启动加速 checkpoint（外层包装含恢复游标）
//     coordinator.lock    瞬时协调者锁（pid+bootId+心跳）
//     coordinator.audit.jsonl  获取/释放/抢占审计（best-effort）
//     coordinator.sock    RPC socket（路径过长时回退 /tmp/at-<hash>.sock，
//                         真实路径写入 socket.path 供对端发现；macOS sun_path ≈104B）

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** macOS sun_path 上限约 104 字节（含 NUL）；留裕量取 96。 */
export const MAX_SOCKET_PATH = 96;

export interface TeamPaths {
  dataRoot: string;
  teamId: string;
  teamDir: string;
  eventsFile: string;
  checkpointFile: string;
  lockFile: string;
  auditFile: string;
  socketCandidate: string;
}

export function teamPaths(dataRoot: string, teamId: string): TeamPaths {
  const teamsRoot = path.join(dataRoot, "teams");
  const teamDir = path.join(teamsRoot, safeTeamId(teamId));
  return {
    dataRoot,
    teamId,
    teamDir,
    eventsFile: path.join(teamDir, "events.jsonl"),
    checkpointFile: path.join(teamDir, "checkpoint.json"),
    lockFile: path.join(teamDir, "coordinator.lock"),
    auditFile: path.join(teamDir, "coordinator.audit.jsonl"),
    socketCandidate: path.join(teamDir, "coordinator.sock"),
  };
}

export function ensureTeamDir(paths: TeamPaths): string {
  fs.mkdirSync(paths.teamDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(paths.teamDir, 0o700);
  } catch {
    /* best-effort */
  }
  return paths.teamDir;
}

/** teamId（会话 id）→ 文件名安全形式：非 [A-Za-z0-9._-] 字符转 `~xx` 十六进制转义；裸 "."/".." 段整体转义。 */
export function safeTeamId(teamId: string): string {
  const escaped = teamId.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0)!.toString(16));
  // path.join 会把裸 "."/".." 折叠出 teams 根的同级/上级目录——按既有十六进制方案整体转义
  // （正常会话 id 形如 sess_/session_ 前缀，不受影响；Mimosa L3 路径穿越口径，stage-2 政策）。
  if (escaped === ".") return "~2e";
  if (escaped === "..") return "~2e2e";
  return escaped;
}

/** 包含校验（Mimosa L3 口径，stage-2 政策 under()/assertInside 同源）：解析后必须仍在 base 之下。 */
export function assertPathInside(base: string, target: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`path escapes containment: ${target} (base: ${base})`);
  }
}

export interface SocketResolution {
  socketPath: string;
  /** 候选路径超长时为 true（已回退到 /tmp 短路径并写入 socket.path 发现文件）。 */
  fallback: boolean;
  registryFile: string;
}

/**
 * 解析 RPC socket 路径：候选路径 ≤96B 直接用；超长回退到**私有子目录**
 * <tmp>/agent-team-sockets（0700）/at-<hash>.sock，并把真实路径写入 <teamDir>/socket.path
 * （对端读该文件发现 socket）。私有子目录避免在共享 /tmp 下暴露 socket 名与 token 面。
 */
export function resolveSocketPath(teamDir: string): SocketResolution {
  const candidate = path.join(teamDir, "coordinator.sock");
  if (candidate.length <= MAX_SOCKET_PATH) {
    return { socketPath: candidate, fallback: false, registryFile: path.join(teamDir, "socket.path") };
  }
  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const fallbackDir = path.join(tmpRoot, "agent-team-sockets");
  fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(fallbackDir, 0o700);
  } catch {
    /* 非 POSIX：继续（socket 自身仍 0600） */
  }
  const fallbackPath = path.join(fallbackDir, `at-${hash}.sock`);
  return { socketPath: fallbackPath, fallback: true, registryFile: path.join(teamDir, "socket.path") };
}

/** 对端发现 socket：优先 registry 文件（处理回退场景），缺失时回退候选路径。 */
export function discoverSocketPath(teamDir: string): string {
  const registryFile = path.join(teamDir, "socket.path");
  try {
    const registered = fs.readFileSync(registryFile, "utf8").trim();
    if (registered.length > 0) return registered;
  } catch {
    /* 无 registry → 用候选路径 */
  }
  return resolveSocketPath(teamDir).socketPath;
}

/** 写 socket 发现文件（server 监听成功后调用）。 */
export function writeSocketRegistry(teamDir: string, socketPath: string): void {
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(teamDir, "socket.path"), socketPath + "\n", { mode: 0o600 });
}

export function removeSocketRegistry(teamDir: string): void {
  for (const file of [path.join(teamDir, "socket.path"), resolveSocketPath(teamDir).socketPath]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 只清理自己的 registry（避免旧协调者延迟 close 删掉新协调者的 socket.path）。
 * socket 文件本身由 RpcServer.close 按 inode 归属清理。
 */
export function removeSocketRegistryIf(teamDir: string, socketPath: string): void {
  const file = path.join(teamDir, "socket.path");
  try {
    const current = fs.readFileSync(file, "utf8").trim();
    if (current !== socketPath) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}
