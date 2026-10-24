// 空闲 host 回收（Round-2 Phase 1.6）：超过阈值且无在途调用 → 关闭并从缓存移除；
// 在途调用保护；阈值 0 = 关闭回收。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import type { ResolvedIdentity } from "../../src/mcp/identity.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-idle-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const LIMITS = { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65_536, disposalTimeoutMs: 5_000 };

function identity(teamId: string): ResolvedIdentity {
  return {
    agentId: teamId,
    teamId,
    sessionId: teamId,
    role: "lead",
    name: "lead",
    source: "meta",
    hookRegistered: true,
  };
}

describe("TeamToolBackend 空闲回收", () => {
  it("空闲超过阈值 → 回收；再次调用自动重开", async () => {
    let now = 1_000_000;
    const backend = new TeamToolBackend({
      dataRoot: root,
      limits: LIMITS,
      idleReclaimMs: 1_000,
      now: () => now,
      warn: () => undefined,
    });
    try {
      const teamId = "sess_idle_team";
      await backend.listAgents(identity(teamId));
      expect(backend.modeOf(teamId)).toBe("coordinator");
      now += 2_000;
      expect(await backend.sweepIdleHosts()).toBe(1);
      expect(backend.modeOf(teamId)).toBe("unopened");
      // 重开：durable 日志仍在，工具继续可用
      const rows = await backend.listAgents(identity(teamId));
      expect(rows.map((r) => r.target)).toEqual(["lead"]);
      expect(backend.modeOf(teamId)).toBe("coordinator");
    } finally {
      await backend.close();
    }
  });

  it("在途调用期间不回收（wait_agent 挂起时）", async () => {
    let now = 5_000_000;
    const backend = new TeamToolBackend({
      dataRoot: root,
      limits: LIMITS,
      idleReclaimMs: 1_000,
      now: () => now,
      warn: () => undefined,
    });
    const abort = new AbortController();
    try {
      const teamId = "sess_idle_inflight";
      const id = identity(teamId);
      await backend.spawnTeammate(id, { name: "worker", description: "d", prompt: "p" });
      const waiting = backend.waitAgent(id, { timeout_ms: 10_000 }, undefined, abort.signal);
      await new Promise((r) => setTimeout(r, 50)); // 让 wait 进入在途
      now += 10_000;
      expect(await backend.sweepIdleHosts()).toBe(0);
      expect(backend.modeOf(teamId)).toBe("coordinator");
      abort.abort("test abort");
      await expect(waiting).rejects.toMatchObject({ code: "TEAM_WAIT_ABORTED" });
      // 结束在途后再回收
      now += 10_000;
      expect(await backend.sweepIdleHosts()).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("idleReclaimMs=0 → 回收关闭", async () => {
    let now = 9_000_000;
    const backend = new TeamToolBackend({
      dataRoot: root,
      limits: LIMITS,
      idleReclaimMs: 0,
      now: () => now,
      warn: () => undefined,
    });
    try {
      const teamId = "sess_idle_off";
      await backend.listAgents(identity(teamId));
      now += 999_999;
      expect(await backend.sweepIdleHosts()).toBe(0);
      expect(backend.modeOf(teamId)).toBe("coordinator");
    } finally {
      await backend.close();
    }
  });
});
