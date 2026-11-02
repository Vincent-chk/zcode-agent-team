// 空闲 Lead 唤醒灰度：默认关闭、状态闸、冷却、单飞锁、launch 参数。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  leadStatePath,
  maybeWakeLead,
  readLeadState,
  recordLeadTurnEvent,
  markSoloNotified,
  markSoloRetracted,
} from "../../src/provider/lead-wake.js";

let dir: string;
const prevFlag = process.env.TEAM_WAKE_LEAD;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-lead-wake-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.TEAM_WAKE_LEAD;
  else process.env.TEAM_WAKE_LEAD = prevFlag;
});

function baseArgs(now: number) {
  return {
    teamDir: dir,
    leadSessionId: "sess_lead",
    cwd: dir,
    zcode: { command: process.execPath, argvPrefix: [] as string[], source: "env" as const },
    minIdleMs: 30_000,
    now,
  };
}

describe("lead-wake", () => {
  it("默认关闭", async () => {
    delete process.env.TEAM_WAKE_LEAD;
    recordLeadTurnEvent(dir, "stop", Date.now() - 60_000);
    expect(await maybeWakeLead(baseArgs(Date.now()))).toEqual({ woke: false, reason: "disabled" });
  });

  it("无状态 / active / 最近活动 / 冷却 / 锁 均不唤醒", async () => {
    process.env.TEAM_WAKE_LEAD = "1";
    expect((await maybeWakeLead(baseArgs(Date.now()))).reason).toBe("no-lead-state");

    const now = Date.now();
    recordLeadTurnEvent(dir, "start", now - 60_000);
    expect((await maybeWakeLead(baseArgs(now))).reason).toBe("lead-active");

    recordLeadTurnEvent(dir, "stop", now - 1_000);
    expect((await maybeWakeLead(baseArgs(now))).reason).toBe("recent-activity");

    recordLeadTurnEvent(dir, "stop", now - 60_000);
    fs.mkdirSync(path.dirname(leadStatePath(dir)), { recursive: true });
    fs.writeFileSync(
      leadStatePath(dir),
      JSON.stringify({ active: false, updatedAt: new Date(now - 60_000).toISOString(), lastWakeAt: new Date(now - 1_000).toISOString() }),
    );
    expect((await maybeWakeLead(baseArgs(now))).reason).toBe("cooldown");

    fs.writeFileSync(
      leadStatePath(dir),
      JSON.stringify({ active: false, updatedAt: new Date(now - 60_000).toISOString() }),
    );
    fs.writeFileSync(path.join(path.dirname(leadStatePath(dir)), "wake.lock"), "{}");
    expect((await maybeWakeLead(baseArgs(now))).reason).toBe("wake-locked");
  });

  it("满足条件 → 调 launch（参数列表、--resume lead），并记 lastWakeAt", async () => {
    process.env.TEAM_WAKE_LEAD = "1";
    const now = Date.now();
    recordLeadTurnEvent(dir, "stop", now - 60_000);
    let captured: { command: string; argv: string[]; cwd: string; stdoutFile: string } | undefined;
    const result = await maybeWakeLead({
      ...baseArgs(now),
      launch: async (input) => {
        captured = input;
      },
    });
    expect(result).toEqual({ woke: true, reason: "launched" });
    expect(captured?.argv).toContain("--resume");
    expect(captured?.argv[captured.argv.indexOf("--resume") + 1]).toBe("sess_lead");
    expect(captured?.argv).toContain("-p");
    expect(readLeadState(dir)?.lastWakeAt).toBe(new Date(now).toISOString());
    expect(fs.existsSync(path.join(path.dirname(leadStatePath(dir)), "wake.lock"))).toBe(false);
  });

  it("launch 失败 → woke=false 且不写 lastWakeAt", async () => {
    process.env.TEAM_WAKE_LEAD = "1";
    const now = Date.now();
    recordLeadTurnEvent(dir, "stop", now - 60_000);
    const result = await maybeWakeLead({
      ...baseArgs(now),
      launch: async () => {
        throw new Error("boom");
      },
    });
    expect(result.woke).toBe(false);
    expect(result.reason).toContain("spawn-failed");
    expect(readLeadState(dir)?.lastWakeAt).toBeUndefined();
  });
});

// 〔D29/D30〕solo 锚字段：写入函数之间互相保留（回合覆写丢锚是 0.5.1 实际踩过的坑）。
describe("lead-wake · solo 锚", () => {
  it("markSoloNotified 无先验状态 → active=false + soloNotifiedAt + via 默认 db", () => {
    markSoloNotified(dir, 1_000);
    const s = readLeadState(dir);
    expect(s?.active).toBe(false);
    expect(s?.soloNotifiedAt).toBe(new Date(1_000).toISOString());
    expect(s?.soloNotifiedVia).toBe("db");
    expect(s?.soloRetractedAt).toBeUndefined();
  });

  it("via=hint 记录 + recordLeadTurnEvent start/stop 均保留三个锚与 lastWakeAt", () => {
    recordLeadTurnEvent(dir, "stop", 500);
    // 先造 lastWakeAt（直接写文件，模拟 maybeWakeLead 落盘）
    const prior = readLeadState(dir)!;
    fs.writeFileSync(leadStatePath(dir), JSON.stringify({ ...prior, lastWakeAt: new Date(600).toISOString() }));
    markSoloNotified(dir, 1_000, "hint");
    markSoloRetracted(dir, 2_000);
    recordLeadTurnEvent(dir, "start", 3_000);
    recordLeadTurnEvent(dir, "stop", 4_000);
    const s = readLeadState(dir);
    expect(s?.lastWakeAt).toBe(new Date(600).toISOString());
    expect(s?.soloNotifiedAt).toBe(new Date(1_000).toISOString());
    expect(s?.soloNotifiedVia).toBe("hint");
    expect(s?.soloRetractedAt).toBe(new Date(2_000).toISOString());
    expect(s?.active).toBe(false);
    expect(s?.updatedAt).toBe(new Date(4_000).toISOString());
  });

  it("markSoloRetracted 保留通知锚/via/active，不重置 soloNotifiedAt；重复调用覆盖撤回时间", () => {
    recordLeadTurnEvent(dir, "start", 100);
    markSoloNotified(dir, 1_000, "hint");
    markSoloRetracted(dir, 2_000);
    markSoloRetracted(dir, 2_500);
    const s = readLeadState(dir);
    expect(s?.active).toBe(true);
    expect(s?.soloNotifiedAt).toBe(new Date(1_000).toISOString());
    expect(s?.soloNotifiedVia).toBe("hint");
    expect(s?.soloRetractedAt).toBe(new Date(2_500).toISOString());
  });

  it("markSoloNotified 再次调用（已有锚）→ 覆盖时间与 via，撤回锚保留", () => {
    markSoloNotified(dir, 1_000, "hint");
    markSoloRetracted(dir, 1_500);
    markSoloNotified(dir, 2_000);
    const s = readLeadState(dir);
    expect(s?.soloNotifiedAt).toBe(new Date(2_000).toISOString());
    expect(s?.soloNotifiedVia).toBe("db");
    expect(s?.soloRetractedAt).toBe(new Date(1_500).toISOString());
  });

  it("状态目录不可写（路径被文件占位）→ 两个标记函数都静默不抛", () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a dir");
    expect(() => markSoloNotified(blocked, 1_000, "hint")).not.toThrow();
    expect(() => markSoloRetracted(blocked, 2_000)).not.toThrow();
    expect(readLeadState(blocked)).toBeUndefined();
  });
});
