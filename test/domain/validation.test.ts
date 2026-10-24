// F22 前置：requiredText 与 writeScope/writeScopes 归一（02 规格 §7.2/§7.5）。消息逐字。
import { describe, expect, it } from "vitest";
import { requiredText, writeScope, writeScopes } from "../../src/domain/validation.js";
import { TeamError } from "../../src/domain/errors.js";

describe("validation · requiredText", () => {
  it("trim 后返回，非空且不超长通过", () => {
    // F22
    expect(requiredText("subject", "  hello  ", 200)).toBe("hello");
    expect(requiredText("description", "x".repeat(16384), 16384)).toHaveLength(16384);
  });

  it.each([
    ["", "subject must be non-empty"],
    ["   \t\n", "subject must be non-empty"],
    [undefined, "subject must be non-empty"],
    [42, "subject must be non-empty"],
  ])("%j → %s", (value, message) => {
    // F22
    expect(() => requiredText("subject", value, 200)).toThrowError(
      new TeamError("TEAM_INVALID_ARGUMENT", message),
    );
  });

  it("description 字段名按入参呈现", () => {
    // F22
    expect(() => requiredText("description", "   ", 200)).toThrowError(
      "description must be non-empty",
    );
  });

  it("超长 → `<field> exceeds <n> characters`", () => {
    // F22
    expect(() => requiredText("subject", "x".repeat(201), 200)).toThrowError(
      "subject exceeds 200 characters",
    );
    expect(() => requiredText("description", "y".repeat(16385), 16384)).toThrowError(
      "description exceeds 16384 characters",
    );
  });
});

describe("validation · writeScope 归一", () => {
  it.each([
    ["src\\lib", "src/lib"],
    ["./src", "src"],
    ["src/", "src"],
    ["././a", "a"],
    [".\\src\\lib\\", "src/lib"],
  ])("%j → %j", (input, expected) => {
    // F22
    expect(writeScope(input)).toBe(expected);
  });

  it.each([
    "",
    "/abs/path",
    "C:/Users",
    "c:\\temp",
    "a//b",
    "a/./b",
    "a/../b",
    ".",
    "..",
    "src/..",
  ])("%j → TEAM_INVALID_WRITE_SCOPE，消息含 JSON 编码", (input) => {
    // F22
    expect(() => writeScope(input)).toThrowError(
      new TeamError(
        "TEAM_INVALID_WRITE_SCOPE",
        `invalid workspace-relative write scope ${JSON.stringify(input)}`,
      ),
    );
  });

  it("非字符串输入同样拒绝（JSON 编码呈现）", () => {
    expect(() => writeScope(42)).toThrowError(
      'invalid workspace-relative write scope 42',
    );
    expect(() => writeScope(null)).toThrowError(
      'invalid workspace-relative write scope null',
    );
  });
});

describe("validation · writeScopes 集合", () => {
  it("逐项归一 + 去重（保序）", () => {
    // F22
    expect(writeScopes(["src", "src/", "src\\lib", "./docs", "docs"])).toEqual([
      "src",
      "src/lib",
      "docs",
    ]);
    expect(writeScopes([])).toEqual([]);
  });

  it("任一项非法 → 整体拒绝", () => {
    expect(() => writeScopes(["src", "../escape"])).toThrowError(TeamError);
    expect(() => writeScopes("src")).toThrowError("write_scopes must be an array");
  });
});
