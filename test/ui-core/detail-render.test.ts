// T5.7 成员会话查看视图渲染单测（detail-render；F13 渲染面 + V16 只读边界）。
// 纯函数（面板 src/panel/main.ts 与伴生页共用 = 单一实现）。
import { describe, expect, it } from "vitest";
import { renderDetailView, renderDetailItem, renderDetailBody } from "../../src/ui-core/detail-render.js";
import type { DetailItem, DetailResult } from "../../src/panel/detail.js";
import type { DetailViewState } from "../../src/ui-core/detail-render.js";

function item(partial: Partial<DetailItem> & { seq: number }): DetailItem {
  return { ts: "2026-10-18T12:34:56.000Z", role: "user", kind: "text", text: "hi", ...partial };
}

function detail(items: DetailItem[], partial: Partial<DetailResult> = {}): DetailResult {
  return {
    sessionId: "sess_child",
    memberId: "m_alice",
    page: { items },
    total: items.length,
    ...partial,
  };
}

describe("renderDetailItem", () => {
  it("text（user）→ role 文案「我」+ 时间 + 文本", () => {
    const html = renderDetailItem(item({ seq: 1, role: "user", text: "请实现" }), "zh");
    expect(html).toContain("我"); // detail.you
    expect(html).toContain("12:34:56");
    expect(html).toContain("请实现");
  });

  it("assistant text → role=assistant（非「我」）", () => {
    const html = renderDetailItem(item({ seq: 1, role: "assistant", text: "已完成" }), "zh");
    expect(html).toContain(">assistant<");
    expect(html).toContain("已完成");
  });

  it("framed 徽标（团队消息回填）：来自 <name>", () => {
    const html = renderDetailItem(
      item({ seq: 1, role: "user", text: "Team message from lead:\n推进", framed: { messageId: "m1", from: "lead" } }),
      "zh",
    );
    expect(html).toContain("msg-badge");
    expect(html).toContain("Team 消息 · 来自 lead");
    expect(html).toContain("Team message from lead:"); // 原文不改写
  });

  it("toolCall 有载荷 → 可折叠按钮（默认 aria-expanded=false）+ 工具名/状态", () => {
    const html = renderDetailItem(
      item({ seq: 1, role: "assistant", kind: "toolCall", text: "input: {}\noutput: ok", tool: { name: "Bash", status: "completed" } }),
      "zh",
    );
    expect(html).toContain('class="tool-row" aria-expanded="false"');
    expect(html).toContain("Bash");
    expect(html).toContain("completed");
    expect(html).toContain("tool-detail");
    expect(html).toContain("output: ok");
  });

  it("toolCall 无载荷 → 静态行（非按钮，不可展开）", () => {
    const html = renderDetailItem(
      item({ seq: 1, role: "assistant", kind: "toolCall", text: undefined, tool: { name: "Read", status: "running" } }),
      "zh",
    );
    expect(html).toContain('class="tool-static"');
    expect(html).not.toContain("tool-detail");
    expect(html).toContain("Read");
  });

  it("XSS 面：text/工具名/徽标 name 全转义", () => {
    const html = renderDetailItem(
      item({ seq: 1, role: "user", text: "<script>alert(1)</script>", framed: { messageId: "m", from: "<b>evil</b>" } }),
      "zh",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });
});

describe("renderDetailBody（三态 + 分页）", () => {
  it("loading → 加载态（ongoing 点 + 文案）", () => {
    const html = renderDetailBody({ kind: "loading", memberId: "m", name: "alice" }, "zh");
    expect(html).toContain("detail-state");
    expect(html).toContain("dot ongoing");
    expect(html).toContain("正在加载会话…");
  });

  it("error（一般）→ 可读原因 + 重试", () => {
    const html = renderDetailBody({ kind: "error", memberId: "m", name: "alice", message: "boom" }, "zh");
    expect(html).toContain("detail-state error");
    expect(html).toContain("会话读取失败：boom");
    expect(html).toContain("data-detail-retry");
  });

  it("error（session-not-settled）→ noSession 文案（不留死按钮）", () => {
    const html = renderDetailBody(
      { kind: "error", memberId: "m", name: "alice", message: "x", reason: "session-not-settled" },
      "zh",
    );
    expect(html).toContain("会话 id 未落定");
  });

  it("ready 空 items → 无消息态", () => {
    const html = renderDetailBody({ kind: "ready", memberId: "m", name: "alice", detail: detail([]) }, "zh");
    expect(html).toContain("该成员暂无会话消息");
  });

  it("ready 有 items + nextCursor → 更早消息分页器 + 计数", () => {
    const d = detail([item({ seq: 5 }), item({ seq: 6 })], { total: 20 });
    d.page.nextCursor = 5;
    const html = renderDetailBody({ kind: "ready", memberId: "m", name: "alice", detail: d }, "zh");
    expect(html).toContain("data-detail-earlier");
    expect(html).toContain('data-cursor="5"');
    expect(html).toContain("更早消息");
    expect(html).toContain("20 条"); // detail.count
  });

  it("ready 无 nextCursor（首屏）→ 仅计数，无更早按钮", () => {
    const html = renderDetailBody(
      { kind: "ready", memberId: "m", name: "alice", detail: detail([item({ seq: 1 })]) },
      "zh",
    );
    expect(html).not.toContain("data-detail-earlier");
    expect(html).toContain("1 条");
  });
});

describe("renderDetailView（二级视图头部 + 只读边界）", () => {
  it("closed → 空串", () => {
    expect(renderDetailView({ kind: "closed" }, "zh")).toBe("");
  });

  it("ready → 返回按钮 + 标题 + 复制会话 id + 刷新（wake 按 opts）", () => {
    const st: DetailViewState = { kind: "ready", memberId: "m", name: "alice", detail: detail([item({ seq: 1 })]) };
    const withWake = renderDetailView(st, "zh", { wake: true });
    expect(withWake).toContain("data-detail-back");
    expect(withWake).toContain("返回");
    expect(withWake).toContain("alice");
    expect(withWake).toContain("data-detail-copy");
    expect(withWake).toContain("复制会话 id");
    expect(withWake).toContain("data-detail-refresh");
    expect(withWake).toContain("data-detail-wake"); // 面板载体才注入唤醒下钻

    const noWake = renderDetailView(st, "zh");
    expect(noWake).not.toContain("data-detail-wake"); // 伴生页无模型通道 → 不注入
  });

  it("只读边界（F13）：无发送/中断控件（DOM 扫描）", () => {
    const st: DetailViewState = { kind: "ready", memberId: "m", name: "alice", detail: detail([item({ seq: 1 })]) };
    const html = renderDetailView(st, "zh", { wake: true });
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/data-detail-(send|interrupt|kill|stop)/);
    // 允许的控件：返回/刷新/复制/唤醒/更早/工具折叠
    expect(html).toContain("data-detail-copy");
  });

  it("en 词典（双语一致面）", () => {
    const st: DetailViewState = { kind: "ready", memberId: "m", name: "alice", detail: detail([item({ seq: 1 })]) };
    const html = renderDetailView(st, "en", { wake: true });
    expect(html).toContain("Back");
    expect(html).toContain("Copy session id");
    expect(html).toContain("Ask Lead to wake this member");
  });

  it("error 态头部无复制/刷新（仅返回 + body 重试）", () => {
    const html = renderDetailView({ kind: "error", memberId: "m", name: "alice", message: "x" }, "zh");
    expect(html).toContain("data-detail-back");
    expect(html).not.toContain("data-detail-copy");
    expect(html).toContain("data-detail-retry");
  });
});
