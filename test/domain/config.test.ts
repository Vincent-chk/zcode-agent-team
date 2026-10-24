// F31：4 限额启动校验（02 规格 §4；〔对齐轮修订〕0.2.1-alpha.5 删 maxPendingMessagesPerMember）。非正 safe integer → TEAM_INVALID_CONFIG，消息逐字。
import { describe, expect, it } from "vitest";
import { validateTeamLimits, TEAM_LIMIT_KEYS, validateLeadMode } from "../../src/domain/config.js";
import { TeamError } from "../../src/domain/errors.js";

const VALID = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

describe("config · validateTeamLimits", () => {
  it("合法数值对象原样通过（出厂 profile 值）", () => {
    // F31
    expect(validateTeamLimits(VALID)).toEqual(VALID);
    expect(TEAM_LIMIT_KEYS).toHaveLength(4);
  });

  it("env 注入的整数字符串可解析", () => {
    // F31
    expect(
      validateTeamLimits({
        maxMembers: "8",
        maxTasks: "256",
        maxMessageBytes: "65536",
        disposalTimeoutMs: "5000",
      }),
    ).toEqual(VALID);
  });

  it.each([
    ["maxMembers", 0],
    ["maxMembers", -1],
    ["maxMembers", 1.5],
    ["maxMembers", Number.NaN],
    ["maxMembers", Number.MAX_SAFE_INTEGER + 1],
    ["maxMembers", "abc"],
    ["maxMembers", ""],
    ["maxMembers", null],
    ["maxMembers", undefined],
    ["maxTasks", 0],
    ["maxMessageBytes", "12.5"],
    ["disposalTimeoutMs", "  -7"],
  ])("%s=%j → TEAM_INVALID_CONFIG，消息逐字", (key, value) => {
    // F31
    expect(() => validateTeamLimits({ ...VALID, [key]: value })).toThrowError(
      new TeamError("TEAM_INVALID_CONFIG", `${key} must be a positive safe integer`),
    );
    try {
      validateTeamLimits({ ...VALID, [key]: value });
    } catch (err) {
      expect(err).toBeInstanceOf(TeamError);
      expect((err as TeamError).code).toBe("TEAM_INVALID_CONFIG");
    }
  });

  it("缺键同样非法（fail loud，不回退默认）", () => {
    // F31
    const partial = { ...VALID } as Record<string, unknown>;
    delete partial.maxTasks;
    expect(() => validateTeamLimits(partial)).toThrowError(
      "maxTasks must be a positive safe integer",
    );
  });
});

// 〔stage-6.5 D26〕leadMode 校验：宽松回落（区别于 4 限额的 fail-loud）——非法值回落默认，
// 绝不并入 config.ok（一个拼写错误不得禁用工具面）。
describe("config · validateLeadMode（D26）", () => {
  it("合法值原样通过", () => {
    expect(validateLeadMode("orchestrator")).toBe("orchestrator");
    expect(validateLeadMode("collaborator")).toBe("collaborator");
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["  "],
    ["Orchestrator"],
    ["ORCHESTRATOR"],
    ["orchestrator "],
    ["bogus-mode"],
    [0],
    [1],
    [true],
    [false],
    [{}],
    [[]],
  ])("非法输入 %j → 回落默认 orchestrator（不抛错）", (raw) => {
    expect(() => validateLeadMode(raw)).not.toThrow();
    expect(validateLeadMode(raw)).toBe("orchestrator");
  });
});
