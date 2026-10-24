// 空闲 Lead 唤醒（灰度；TEAM_WAKE_LEAD=1 才启用）。
//
// 背景：ZCode 没有 steer 原语，Lead 只能由用户输入 / 既有回合触发 hook。teammate 给空闲
// Lead 发消息时，消息会持久 pending，但不会主动送达。本模块用受保护的 `zcode -p --resume`
// 拉起一个“只处理收件箱”的最小回合；正文仍由 SessionStart(resume) hook 注入。
//
// 安全闸：
//  - 默认关闭（TEAM_WAKE_LEAD=1 才启用）；
//  - Lead 回合状态文件不存在 / active / 最近活动 < minIdle → 不唤醒；
//  - O_EXCL 单飞锁 + 30s 冷却，避免一条消息一个进程；
//  - 任何失败只返回原因，不抛穿到 mailbox（发送方仍得到 pending）。
import fs from "node:fs";
import path from "node:path";
import { ts } from "../shared.js";
import { spawnDetached } from "./procgroup.js";
import type { ZcodeBin } from "./zcode-bin.js";

export interface LeadState {
  active: boolean;
  updatedAt: string;
  lastWakeAt?: string;
}

export interface LeadWakeResult {
  woke: boolean;
  reason: string;
}

const WAKE_COOLDOWN_MS = 30_000;
const WAKE_LOCK_STALE_MS = 120_000;
const WAKE_PROMPT =
  "[agent-team] 你有待收团队消息。请只处理收件箱（读取并回复摘要），不要执行其他任务。";

function leadDir(teamDir: string): string {
  return path.join(teamDir, "lead");
}

export function leadStatePath(teamDir: string): string {
  return path.join(leadDir(teamDir), "state.json");
}

function wakeLockPath(teamDir: string): string {
  return path.join(leadDir(teamDir), "wake.lock");
}

export function readLeadState(teamDir: string): LeadState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(leadStatePath(teamDir), "utf8")) as Partial<LeadState>;
    if (typeof parsed.active !== "boolean" || typeof parsed.updatedAt !== "string") return undefined;
    return parsed as LeadState;
  } catch {
    return undefined;
  }
}

function writeLeadState(teamDir: string, state: LeadState): void {
  const dir = leadDir(teamDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = leadStatePath(teamDir);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** hook 侧：Lead 回合开始/结束。teammate 不写本文件。 */
export function recordLeadTurnEvent(
  teamDir: string,
  event: "start" | "stop",
  now: number = Date.now(),
): void {
  try {
    const prior = readLeadState(teamDir);
    writeLeadState(teamDir, {
      ...(prior?.lastWakeAt !== undefined ? { lastWakeAt: prior.lastWakeAt } : {}),
      active: event === "start",
      updatedAt: new Date(now).toISOString(),
    });
  } catch {
    /* 状态文件失败不阻断 hook；下一次事件重试 */
  }
}

function acquireLock(teamDir: string, now: number): boolean {
  const dir = leadDir(teamDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = wakeLockPath(teamDir);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > WAKE_LOCK_STALE_MS) {
        fs.unlinkSync(file);
        const fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
        fs.closeSync(fd);
        return true;
      }
    } catch {
      /* 锁在观察后被释放 → 本次放弃，下一次再试 */
    }
    return false;
  }
}

function releaseLock(teamDir: string): void {
  try {
    fs.unlinkSync(wakeLockPath(teamDir));
  } catch {
    /* best-effort */
  }
}

/**
 * 尝试唤醒空闲 Lead。只在显式开启时拉起 `zcode -p --resume <lead>`；
 * 返回 woke=false 时调用方应保持 pending，不得标记 delivered。
 */
export async function maybeWakeLead(args: {
  teamDir: string;
  leadSessionId: string;
  cwd: string;
  zcode: ZcodeBin;
  minIdleMs: number;
  now?: number;
  /** 测试注入：默认 spawnDetached；测试可记录参数而不真正起进程。 */
  launch?: (input: { command: string; argv: string[]; cwd: string; stdoutFile: string }) => Promise<void>;
}): Promise<LeadWakeResult> {
  if (process.env.TEAM_WAKE_LEAD !== "1") return Promise.resolve({ woke: false, reason: "disabled" });
  const now = args.now ?? Date.now();
  const state = readLeadState(args.teamDir);
  if (state === undefined) return Promise.resolve({ woke: false, reason: "no-lead-state" });
  if (state.active) return Promise.resolve({ woke: false, reason: "lead-active" });
  const updated = Date.parse(state.updatedAt);
  if (Number.isNaN(updated) || now - updated < args.minIdleMs) {
    return Promise.resolve({ woke: false, reason: "recent-activity" });
  }
  if (state.lastWakeAt !== undefined) {
    const last = Date.parse(state.lastWakeAt);
    if (!Number.isNaN(last) && now - last < WAKE_COOLDOWN_MS) {
      return Promise.resolve({ woke: false, reason: "cooldown" });
    }
  }
  if (!acquireLock(args.teamDir, now)) return Promise.resolve({ woke: false, reason: "wake-locked" });
  const runDir = path.join(leadDir(args.teamDir), "run");
  fs.mkdirSync(runDir, { recursive: true });
  const stdoutFile = path.join(runDir, `wake-${now}.out`);
  try {
    const argv = [
      ...args.zcode.argvPrefix,
      "-p",
      WAKE_PROMPT,
      "--json",
      "--mode",
      "yolo",
      "--surface",
      "terminal",
      "--cwd",
      args.cwd,
      "--resume",
      args.leadSessionId,
    ];
    if (args.launch !== undefined) {
      await args.launch({ command: args.zcode.command, argv, cwd: args.cwd, stdoutFile });
    } else {
      await spawnDetached({
        command: args.zcode.command,
        argv,
        env: process.env,
        cwd: args.cwd,
        stdoutFile,
      });
    }
    writeLeadState(args.teamDir, { ...state, lastWakeAt: new Date(now).toISOString() });
    return { woke: true, reason: "launched" };
  } catch (err) {
    return { woke: false, reason: `spawn-failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    releaseLock(args.teamDir);
  }
}

/** 启动日志用（不涉及文件内容）。 */
export function leadWakeEnabled(): boolean {
  return process.env.TEAM_WAKE_LEAD === "1";
}

export function leadWakeMarker(): string {
  return `lead-wake ${leadWakeEnabled() ? "on" : "off"} at ${ts()}`;
}
