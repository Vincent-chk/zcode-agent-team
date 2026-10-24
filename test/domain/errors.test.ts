// F31（错误码目录完整性部分）：27 个错误码（〔对齐轮修订〕0.2.1-alpha.5 删 TEAM_MAILBOX_FULL）、无重复、目录键一致、code 字符串逐字。
import { describe, expect, it } from "vitest";
import {
  TEAM_ERROR_CODES,
  TEAM_ERROR_CATALOG,
  TeamError,
  isTeamError,
  serializeTeamError,
} from "../../src/domain/errors.js";

// 冻结包 06 §4.1（27 行全集，code 逐字）。
const SPEC_CODES = [
  "TEAM_INVALID_CONFIG",
  "TEAM_DISPOSED",
  "TEAM_DISPOSAL_TIMEOUT",
  "TEAM_NOT_MEMBER",
  "TEAM_LEAD_REQUIRED",
  "TEAM_INVALID_MEMBER_NAME",
  "TEAM_MEMBER_NAME_TAKEN",
  "TEAM_MEMBER_LIMIT",
  "TEAM_PROVISIONING_CONFLICT",
  "TEAM_MEMBER_NOT_FOUND",
  "TEAM_INVALID_TARGET",
  "TEAM_SELF_MESSAGE",
  "TEAM_MESSAGE_TOO_LARGE",
  "TEAM_INVALID_TIMEOUT",
  "TEAM_WAIT_ABORTED",
  "TEAM_INVALID_ARGUMENT",
  "TEAM_INVALID_WRITE_SCOPE",
  "TEAM_TASK_LIMIT",
  "TEAM_TASK_NOT_FOUND",
  "TEAM_TASK_STALE_REVISION",
  "TEAM_TASK_DELETED",
  "TEAM_TASK_UNAUTHORIZED",
  "TEAM_TASK_ALREADY_CLAIMED",
  "TEAM_TASK_BLOCKED",
  "TEAM_TASK_INVALID_TRANSITION",
  "TEAM_TASK_HAS_DEPENDENTS",
  "TEAM_TASK_DEPENDENCY_CYCLE",
] as const;

describe("errors · 错误码目录完整性", () => {
  it("恰好 27 个错误码，无重复", () => {
    // F31
    expect(TEAM_ERROR_CODES).toHaveLength(27);
    expect(new Set(TEAM_ERROR_CODES).size).toBe(27);
  });

  it("code 字符串与 02 规格 §11 总表逐字一致", () => {
    // F31
    expect([...TEAM_ERROR_CODES]).toEqual([...SPEC_CODES]);
  });

  it("目录键与错误码全集一致，每个条目都有规格出处", () => {
    // F31
    expect(Object.keys(TEAM_ERROR_CATALOG).sort()).toEqual([...TEAM_ERROR_CODES].sort());
    for (const code of TEAM_ERROR_CODES) {
      expect(TEAM_ERROR_CATALOG[code].spec.length).toBeGreaterThan(0);
    }
  });

  it("已实现码目录标记覆盖已知实现路径（≥10 个），且每条有模板", () => {
    // 只做下限断言：随服务轮次新增实现码时无需改测试；但 implemented=true 必须有消息模板。
    const knownImplemented = [
      "TEAM_INVALID_ARGUMENT",
      "TEAM_INVALID_CONFIG",
      "TEAM_INVALID_WRITE_SCOPE",
      "TEAM_NOT_MEMBER",
      "TEAM_TASK_DEPENDENCY_CYCLE",
      "TEAM_TASK_NOT_FOUND",
      "TEAM_INVALID_TARGET",
      "TEAM_MEMBER_NOT_FOUND",
      "TEAM_MESSAGE_TOO_LARGE",
      "TEAM_SELF_MESSAGE",
    ] as const;
    for (const code of knownImplemented) {
      expect(TEAM_ERROR_CATALOG[code].implemented, code).toBe(true);
    }
    const implemented = TEAM_ERROR_CODES.filter((c) => TEAM_ERROR_CATALOG[c].implemented);
    expect(implemented.length).toBeGreaterThanOrEqual(knownImplemented.length);
    for (const code of implemented) {
      expect(TEAM_ERROR_CATALOG[code].messages.length, code).toBeGreaterThan(0);
    }
  });
});

describe("errors · TeamError", () => {
  it("code/message/cause 保留，name 为 TeamError", () => {
    const cause = new Error("boom");
    const err = new TeamError("TEAM_DISPOSED", "Agent Teams service disposed", { cause });
    expect(err).toBeInstanceOf(TeamError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TeamError");
    expect(err.code).toBe("TEAM_DISPOSED");
    expect(err.message).toBe("Agent Teams service disposed");
    expect(err.cause).toBe(cause);
    expect(isTeamError(err)).toBe(true);
    expect(isTeamError(new Error("x"))).toBe(false);
  });

  it("toJSON 序列化保留 cause 链（TeamError → plain Error → TeamError）", () => {
    const inner = new TeamError("TEAM_DISPOSED", "Agent Teams service disposed");
    const middle = new Error("middle failure", { cause: inner });
    const outer = new TeamError("TEAM_DISPOSAL_TIMEOUT", "Agent Teams runtime disposal exceeded 5000ms", {
      cause: middle,
    });
    const json = outer.toJSON();
    expect(json.code).toBe("TEAM_DISPOSAL_TIMEOUT");
    expect(json.cause).toMatchObject({ name: "Error", message: "middle failure" });
    expect(json.cause).toMatchObject({ cause: { name: "TeamError", code: "TEAM_DISPOSED" } });
    // JSON 往返不丢链
    const round = JSON.parse(JSON.stringify(json));
    expect(round.cause.cause.code).toBe("TEAM_DISPOSED");
  });

  it("非 Error cause 以字符串形态保留；cause 环被截断", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const serialized = serializeTeamError(
      new TeamError("TEAM_NOT_MEMBER", 'agent "x" is not a member of an active Agent Team', {
        cause: b,
      }),
    );
    expect(serialized.cause).toMatchObject({ name: "Error", message: "b" });
    expect(serialized.cause).toMatchObject({ cause: { name: "Error", message: "a" } });
    expect((serialized.cause as { cause?: { cause?: unknown } }).cause?.cause).toMatchObject({
      message: "[circular cause]",
    });

    const strCause = new TeamError("TEAM_DISPOSED", "Agent Teams service is disposing", {
      cause: "raw string reason",
    });
    expect(strCause.toJSON().cause).toEqual({ message: "raw string reason" });
  });
});
