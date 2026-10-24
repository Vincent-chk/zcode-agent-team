// ::visualize 快照卡片渲染器单测（T5.3）：沙箱纪律（无 doctype/单根/无网络 API）+
// 与面板同源（同一 renderPanelBody 输出）+ 双语/双主题参数面。
import { describe, expect, it } from "vitest";
import { renderWidgetFragment, renderStandalonePage, widgetLabels } from "../../src/ui-core/widget.js";
import { renderPanelBody } from "../../src/ui-core/render.js";
import { PANEL_CSS } from "../../src/ui-core/css.js";
import { FIXTURE_TASK_STATES, FIXTURE_SOLO_LEAD, FIXTURE_EMPTY } from "../visual/fixtures.js";

describe("renderWidgetFragment（::visualize 沙箱纪律）", () => {
  it("无 doctype/html/head/body；单根节点唯一 id", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES });
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html.startsWith('<div id="agent-team-widget"')).toBe(true);
    // 根节点唯一 id（选择器纪律）
    expect(html.match(/id="agent-team-widget"/g)).toHaveLength(1);
  });

  it("无 fetch/XHR/WebSocket（沙箱禁网络）", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES });
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("WebSocket");
    expect(html).not.toContain("EventSource");
  });

  it("自定义 rootId 生效且唯一", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_SOLO_LEAD, rootId: "my-team-card" });
    expect(html.startsWith('<div id="my-team-card"')).toBe(true);
    expect(html.match(/id="my-team-card"/g)).toHaveLength(1);
  });

  it("与面板同源：body 内容 = renderPanelBody 输出逐字节一致", () => {
    const body = renderPanelBody(FIXTURE_TASK_STATES, "zh", { loading: false });
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES });
    expect(html).toContain(body);
  });

  it("紧凑模式类随帧（仅 1 成员且 0 任务）", () => {
    expect(renderWidgetFragment({ frame: FIXTURE_SOLO_LEAD })).toContain('class="team-panel compact"');
    expect(renderWidgetFragment({ frame: FIXTURE_TASK_STATES })).toContain('class="team-panel" role="dialog"');
    expect(renderWidgetFragment({ frame: FIXTURE_TASK_STATES })).not.toContain('class="team-panel compact"');
  });

  it("双语/双主题参数进 data-*（宿主切换面）", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES, lang: "en", theme: "dark" });
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-lang="en"');
    expect(html).toContain("Shared tasks");
    expect(html).toContain("&quot;expand&quot;:&quot;Show more&quot;"); // data-labels（展开脚本文案同源）
  });

  it("空团队帧 → unavailable 通知条（与面板一致；无花名册节标记）", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_EMPTY });
    expect(html).toContain("Team 暂不可用");
    expect(html).not.toContain('<div class="roster">');
    expect(html).not.toContain('class="member');
  });

  it("widgetState/sendFollowUpMessage 桥为可选调用（沙箱缺 window.zcode 不抛错）", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES });
    expect(html).toContain("window.zcode && window.zcode.widgetState");
    expect(html).toContain("window.zcode && window.zcode.setWidgetState");
    expect(html).toContain("window.zcode && window.zcode.sendFollowUpMessage");
    expect(html).toContain("prompt: '/team'"); // 手动刷新下钻
  });

  it("体积预算：单帧卡片 < 1MB（visualize 上限）", () => {
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES });
    expect(html.length).toBeLessThan(1024 * 1024);
  });
});

describe("PANEL_CSS（列表↔详情切换）", () => {
  it("hidden 必须压过作者样式 display（避免返回列表后详情残留）", () => {
    expect(PANEL_CSS).toContain(".team-panel [hidden] { display: none !important; }");
  });
});

describe("renderStandalonePage（CLI 高保真降级路径）", () => {
  it("完整 HTML 文档（doctype + 片段内嵌）", () => {
    const html = renderStandalonePage({ frame: FIXTURE_TASK_STATES, lang: "en", theme: "dark", title: "Agent Team" });
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain("<title>Agent Team</title>");
    expect(html).toContain('id="agent-team-widget"');
  });
  it("zh 缺省标题 = 词典 trigger 逐字", () => {
    const html = renderStandalonePage({ frame: FIXTURE_SOLO_LEAD });
    expect(html).toContain("<title>智能体团队</title>");
  });
});

describe("widgetLabels", () => {
  it("展开/收起文案 = 词典逐字（V09 零容忍面）", () => {
    expect(widgetLabels("zh")).toEqual({ expand: "展开", collapse: "收起" });
    expect(widgetLabels("en")).toEqual({ expand: "Show more", collapse: "Show less" });
  });
});
