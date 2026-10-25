// F08 双语词典逐字 + 键集完整性（验收标准 §A F08；零容忍：一字之差 = 失败）。
// 基准 = 02 §10.7 词典表（25 键，命名空间 agent-team）；〔核查修订 B7〕不得新增
// status.deleted 键（deleted 复用 completed 文案由 statusKey() 承担）。
import { describe, expect, it } from "vitest";
import { DICT, DICT_KEYS, statusKey, memberStatusKey, langOfLocale, t, td, DETAIL_DICT } from "../../src/ui-core/dict.js";
import { MEMBER_SETTINGS_DICT, tms } from "../../src/ui-core/member-settings.js";

/** 02 §10.7 逐字基准（键 → [zh, en]；与规格表行序一致）。 */
const SPEC: Record<string, [string, string]> = {
  trigger: ["智能体团队", "Agent Team"],
  loading: ["正在加载团队…", "Loading Team…"],
  unavailable: ["Team 暂不可用", "Team is unavailable"],
  failure: ["团队持久记录无效：{message}", "Invalid persisted Team record: {message}"],
  empty: ["暂无共享任务，可以通过对话创建", "No shared tasks yet. Create them through the conversation."],
  roster: ["成员", "Members"],
  tasks: ["共享任务", "Shared tasks"],
  model: ["模型", "Model"],
  open: ["打开成员会话", "Open member conversation"],
  current: ["当前会话", "Current chat"],
  owner: ["Owner", "Owner"],
  unowned: ["未分配", "Unowned"],
  blockedBy: ["依赖", "Blocked by"],
  writeScopes: ["写入范围", "Write scopes"],
  ready: ["可开始", "Ready"],
  blocked: ["被依赖阻塞", "Blocked by dependencies"],
  "task.expand": ["展开", "Show more"],
  "task.collapse": ["收起", "Show less"],
  "memberStatus.running": ["运行中", "Running"],
  "memberStatus.inactive": ["未运行", "Inactive"],
  "memberStatus.provisioning": ["准备中", "Provisioning"],
  "memberStatus.failed": ["失败", "Failed"],
  "status.pending": ["待处理", "Pending"],
  "status.in_progress": ["进行中", "In progress"],
  "status.completed": ["已完成", "Completed"],
};

describe("F08 · 词典逐字（02 §10.7）", () => {
  it("恰为 25 键（不多不少）", () => {
    expect(DICT_KEYS).toHaveLength(25);
    expect(Object.keys(SPEC)).toHaveLength(25);
  });

  it("zh/en 逐字命中规格表（一字不差）", () => {
    for (const key of DICT_KEYS) {
      const [zh, en] = SPEC[key];
      expect(DICT.zh[key], `zh[${key}]`).toBe(zh);
      expect(DICT.en[key], `en[${key}]`).toBe(en);
    }
  });

  it("键集完整：zh 与 en 键集一致 = DICT_KEYS = SPEC 键集", () => {
    expect(Object.keys(DICT.zh).sort()).toEqual([...DICT_KEYS].sort());
    expect(Object.keys(DICT.en).sort()).toEqual([...DICT_KEYS].sort());
    expect(Object.keys(DICT.zh).sort()).toEqual(Object.keys(SPEC).sort());
  });

  it("〔B7〕不存在 status.deleted 键（deleted 复用 completed 由 statusKey 承担）", () => {
    expect(DICT_KEYS).not.toContain("status.deleted" as never);
    expect("status.deleted" in DICT.zh).toBe(false);
    expect("status.deleted" in DICT.en).toBe(false);
  });

  it("loading 省略号为单字符 U+2026（非三点）", () => {
    expect(DICT.zh.loading).toContain("\u2026");
    expect(DICT.zh.loading).not.toContain("...");
    expect(DICT.en.loading).toContain("\u2026");
  });
});

describe("statusKey / memberStatusKey（B7 deleted 复用）", () => {
  it("statusKey(deleted) → status.completed（不新增键）", () => {
    expect(statusKey("deleted")).toBe("status.completed");
    expect(statusKey("pending")).toBe("status.pending");
    expect(statusKey("in_progress")).toBe("status.in_progress");
    expect(statusKey("completed")).toBe("status.completed");
  });
  it("memberStatusKey 四态", () => {
    expect(memberStatusKey("running")).toBe("memberStatus.running");
    expect(memberStatusKey("inactive")).toBe("memberStatus.inactive");
    expect(memberStatusKey("provisioning")).toBe("memberStatus.provisioning");
    expect(memberStatusKey("failed")).toBe("memberStatus.failed");
  });
});

describe("langOfLocale / 插值", () => {
  it("zh* → zh；其余 → en；缺省 → en", () => {
    expect(langOfLocale("zh-CN")).toBe("zh");
    expect(langOfLocale("zh")).toBe("zh");
    expect(langOfLocale("ZH-hant")).toBe("zh");
    expect(langOfLocale("en-US")).toBe("en");
    expect(langOfLocale("ja")).toBe("en");
    expect(langOfLocale(undefined)).toBe("en");
    expect(langOfLocale(null)).toBe("en");
  });
  it("failure 键 {message} 插值逐字", () => {
    expect(t("zh", "failure", { message: "bad line 3" })).toBe("团队持久记录无效：bad line 3");
    expect(t("en", "failure", { message: "bad line 3" })).toBe("Invalid persisted Team record: bad line 3");
  });
  it("t 无插值变量时保留 {message} 原样（不误替换）", () => {
    expect(t("zh", "failure")).toBe("团队持久记录无效：{message}");
  });
});

describe("DETAIL_DICT（T5.7 新增文案；不进 F08 逐字面，但 zh/en 键集须一致）", () => {
  it("zh/en 键集一致", () => {
    expect(Object.keys(DETAIL_DICT.zh).sort()).toEqual(Object.keys(DETAIL_DICT.en).sort());
  });
  it("td 插值 {name}/{n}/{message}", () => {
    expect(td("zh", "detail.framedFrom", { name: "alice" })).toBe("Team 消息 · 来自 alice");
    expect(td("en", "detail.count", { n: 42 })).toBe("42 items");
    expect(td("zh", "detail.failed", { message: "x" })).toBe("会话读取失败：x");
  });
  it("〔视图修订 2026-10-25·二次〕动作组/摘要计数文案（无模式键——视图只有简洁形态）", () => {
    expect(td("zh", "detail.toolGroup", { n: 7, list: "Bash×7" })).toBe("7 个动作 · Bash×7");
    expect(td("en", "detail.toolGroup", { n: 2, list: "Bash×2" })).toBe("2 actions · Bash×2");
    expect(td("zh", "detail.countSummary", { n: 3, sourceTotal: 132 })).toBe("3 条 · 共 132 条转录");
    expect(td("en", "detail.countSummary", { n: 3, sourceTotal: 132 })).toBe(
      "3 items · of 132 transcript items",
    );
    expect("detail.modeSummary" in DETAIL_DICT.zh).toBe(false);
    expect("detail.modeFull" in DETAIL_DICT.en).toBe(false);
  });
});

describe("MEMBER_SETTINGS_DICT（stage-8 D 新增文案；不进 F08 逐字面）", () => {
  it("zh/en 键集一致；命名空间与 25 键 DICT 完全隔离", () => {
    expect(Object.keys(MEMBER_SETTINGS_DICT.zh).sort()).toEqual(Object.keys(MEMBER_SETTINGS_DICT.en).sort());
    for (const key of Object.keys(MEMBER_SETTINGS_DICT.zh)) {
      expect(key.startsWith("settings.")).toBe(true);
      expect(DICT_KEYS).not.toContain(key as never);
    }
    expect(DICT_KEYS).toHaveLength(25);
  });
  it("tms 插值 {reason}/{message}", () => {
    expect(tms("zh", "settings.disabledBecause", { reason: "inactive" })).toBe("（inactive）");
    expect(tms("en", "settings.error", { message: "x" })).toBe("Model settings unavailable: x");
  });
});
