// paths / identity 单元（safeTeamId、布局、writerId 解析、bootId 稳定性）。
import { describe, expect, it } from "vitest";
import { teamPaths, safeTeamId, ensureTeamDir, MAX_SOCKET_PATH } from "../../src/coord/paths.js";
import { bootId, parseWriterId, writerId } from "../../src/coord/identity.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("paths", () => {
  it("safeTeamId：合法字符原样；非常规字符转 ~hex 转义（无路径分隔风险）", () => {
    expect(safeTeamId("sess_team-001.x")).toBe("sess_team-001.x");
    expect(safeTeamId("sess/evil")).toBe("sess~2fevil");
    expect(safeTeamId("a\\b")).toBe("a~5cb");
    expect(safeTeamId("../p")).toBe("..~2fp");
    expect(safeTeamId("../p")).not.toContain("/");
  });

  it("teamPaths 布局字段齐全；ensureTeamDir 建目录", () => {
    const p = teamPaths("/data", "sess_t1");
    expect(p.teamDir).toBe("/data/teams/sess_t1");
    expect(p.eventsFile.endsWith("events.jsonl")).toBe(true);
    expect(p.checkpointFile.endsWith("checkpoint.json")).toBe(true);
    expect(p.lockFile.endsWith("coordinator.lock")).toBe(true);
    expect(p.auditFile.endsWith("coordinator.audit.jsonl")).toBe(true);
    expect(p.socketCandidate.endsWith("coordinator.sock")).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "at-paths-"));
    try {
      const local = teamPaths(tmp, "sess_ensure");
      expect(fs.existsSync(ensureTeamDir(local))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("MAX_SOCKET_PATH 预算 ≤ macOS sun_path", () => {
    expect(MAX_SOCKET_PATH).toBeLessThanOrEqual(104);
  });
});

describe("identity", () => {
  it("bootId 进程内稳定；writerId = bootId:pid 可解析往返", () => {
    const a = bootId();
    expect(bootId()).toBe(a);
    const w = writerId();
    expect(w).toBe(`${a}:${process.pid}`);
    expect(parseWriterId(w)).toEqual({ bootId: a, pid: process.pid });
  });

  it("parseWriterId 容错：畸形输入 → undefined", () => {
    expect(parseWriterId("no-sep")).toBeUndefined();
    expect(parseWriterId(":123")).toBeUndefined();
    expect(parseWriterId("boot:not-a-pid")).toBeUndefined();
  });
});
