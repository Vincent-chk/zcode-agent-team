// 会话隔离接线（stage-6）：child 模式下首轮以 `--resume <隐藏子会话>` 驱动，
// origin 记录隔离字段；培育失败 → 直接抛错（不静默回退为可见会话）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildProviderKit } from "./kit.js";
import { listTurns, memberPaths, readOrigin } from "../../src/provider/member-files.js";

const CHILD = "sess_child_hidden";

function fakeBreeder(
  result:
    | { anchorSessionId: string; childSessionId: string; elapsedMs: number; workspacePath?: string }
    | Error,
) {
  return {
    calls: [] as Array<{ teamId: string; workspacePath: string }>,
    async createChild(input: { teamId: string; workspacePath: string }) {
      this.calls.push({ teamId: input.teamId, workspacePath: input.workspacePath });
      if (result instanceof Error) throw result;
      return { ...result, workspacePath: result.workspacePath ?? input.workspacePath };
    },
  };
}

describe("ResumePerTurnProvider · sessionIsolation=child", () => {
  it("首轮 argv 含 --resume <child>；origin 记录隔离字段", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_x", childSessionId: CHILD, elapsedMs: 12 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-iso",
        name: "alpha",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(result.accepted).toBe(true);
      expect(breeder.calls).toEqual([{ teamId: kit.teamId, workspacePath: kit.cwd }]);

      const paths = memberPaths(kit.provider.teamDir, "m-iso");
      const origin = readOrigin(paths);
      expect(origin).toMatchObject({
        sessionId: CHILD,
        sessionIsolation: "child",
        anchorSessionId: "sess_anchor_x",
        logicalParentSessionId: kit.teamId,
        sessionKind: "selection_side_chat",
        initialUserMessageAccepted: true,
      });
      const turn = listTurns(paths.runDir)[0]!;
      expect(turn.argv).toContain("--resume");
      expect(turn.argv[turn.argv.indexOf("--resume") + 1]).toBe(CHILD);
      expect(turn.argv[turn.argv.indexOf("--cwd") + 1]).toBe(kit.cwd);
    } finally {
      await kit.cleanup();
    }
  });

  it("培育失败 → startContinuable 抛错（不静默回退）", async () => {
    const breeder = fakeBreeder(new Error("createSelectionSideSession rejected: unsupported"));
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-iso-fail",
          name: "beta",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/unsupported/);
      // 没有落 origin（失败发生在落盘前）
      const paths = memberPaths(kit.provider.teamDir, "m-iso-fail");
      expect(fs.existsSync(paths.originFile)).toBe(false);
      expect(fs.existsSync(path.join(paths.runDir))).toBe(false);
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · sessionIsolation=legacy（回滚路径）", () => {
  it("保持旧行为：首轮不带 --resume，origin 标记 legacy", async () => {
    const kit = buildProviderKit();
    try {
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-legacy",
        name: "gamma",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(result.accepted).toBe(true);
      const paths = memberPaths(kit.provider.teamDir, "m-legacy");
      const origin = readOrigin(paths);
      expect(origin).toMatchObject({ sessionIsolation: "legacy", sessionKind: "interactive" });
      expect(origin?.anchorSessionId).toBeUndefined();
      expect(listTurns(paths.runDir)[0]!.argv).not.toContain("--resume");
    } finally {
      await kit.cleanup();
    }
  });
});
