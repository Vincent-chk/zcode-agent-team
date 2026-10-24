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
