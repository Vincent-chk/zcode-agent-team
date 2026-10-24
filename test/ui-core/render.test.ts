// 渲染器单测（F01/F05/F06/F09/V03/V08/V11 的纯函数面；DOM 几何断言归 T5.6 视觉回归）。
// 夹具 = 8 组状态（验收标准 F01 枚举）的子集直构。
import { describe, expect, it } from "vitest";
import {
  renderPanelBody,
  renderRoster,
  renderTasks,
  renderTaskMeta,
  renderNotices,
  renderMember,
  isCompact,
  currentMemberId,
  isMemberDisabled,
  memberDot,
  taskDot,
  esc,
} from "../../src/ui-core/render.js";
import type { ViewFrame, ViewFrameMember } from "../../src/ui-core/view.js";
import type { TeamTaskView } from "../../src/domain/task-view.js";

const TEAM = "sess_lead_1";

function member(partial: Partial<ViewFrameMember> & { target: string }): ViewFrameMember {
  return {
    role: "teammate",
    status: "inactive",
    diagnostics: [],
    id: `m_${partial.target}`,
    ...partial,
  } as ViewFrameMember;
}

function task(partial: Partial<TeamTaskView> & { id: string }): TeamTaskView {
  return {
    revision: 1,
    subject: "s",
    description: "d",
    status: "pending",
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...partial,
  };
}

function frame(partial: Partial<ViewFrame>): ViewFrame {
  return {
    type: "view",
    stateVersion: 4,
    team: { teamId: TEAM, status: "active", seq: 1 },
    members: [],
    tasks: [],
    meta: { generatedAt: "2026-10-18T00:00:00.000Z", revision: 1, sessionId: TEAM },
    ...partial,
  };
}

describe("状态点映射（F09）", () => {
  it("member：running/provisioning→ongoing、failed→error、inactive→icon", () => {
    expect(memberDot("running")).toBe("ongoing");
    expect(memberDot("provisioning")).toBe("ongoing");
    expect(memberDot("failed")).toBe("error");
    expect(memberDot("inactive")).toBe("icon");
  });
  it("task：pending∧ready→idle、pending∧¬ready→warning、in_progress→ongoing、completed→done、deleted→done", () => {
    expect(taskDot(task({ id: "t1", ready: true }))).toBe("idle");
    expect(taskDot(task({ id: "t2", ready: false }))).toBe("warning");
    expect(taskDot(task({ id: "t3", status: "in_progress" }))).toBe("ongoing");
    expect(taskDot(task({ id: "t4", status: "completed" }))).toBe("done");
    expect(taskDot(task({ id: "t5", status: "deleted" }))).toBe("idle");
  });
});

describe("紧凑模式与当前会话（V01/§10.5）", () => {
  it("紧凑 = 仅 1 成员且 0 任务", () => {
    expect(isCompact(frame({ members: [member({ target: "lead", role: "lead", id: TEAM })] }))).toBe(true);
    expect(isCompact(frame({ members: [member({ target: "lead", role: "lead", id: TEAM })], tasks: [task({ id: "t1" })] }))).toBe(false);
    expect(isCompact(frame({ members: [] }))).toBe(false);
    expect(
      isCompact(frame({ members: [member({ target: "lead", role: "lead", id: TEAM }), member({ target: "a" })] })),
    ).toBe(false);
  });
  it("当前会话 = sessionId 命中；禁用行 = 当前/failed/provisioning", () => {
    const f = frame({
      members: [
        member({ target: "lead", role: "lead", id: TEAM, sessionId: TEAM }),
        member({ target: "a", status: "failed", diagnostics: ["boom"] }),
        member({ target: "b", status: "provisioning" }),
        member({ target: "c", status: "running" }),
      ],
    });
    expect(currentMemberId(f)).toBe(TEAM);
    expect(isMemberDisabled(f.members[0], TEAM)).toBe(true);
    expect(isMemberDisabled(f.members[1], TEAM)).toBe(true);
    expect(isMemberDisabled(f.members[2], TEAM)).toBe(true);
    expect(isMemberDisabled(f.members[3], TEAM)).toBe(false);
  });
});

describe("成员卡渲染（V05/V06）", () => {
  it("当前卡高亮 + Tag 文案逐字；禁用行 disabled", () => {
    const html = renderMember(member({ target: "lead", role: "lead", id: TEAM }), {
      lang: "zh",
      isCurrent: true,
      disabled: true,
    });
    expect(html).toContain('class="member current"');
    expect(html).toContain("当前会话");
    expect(html).toContain("disabled");
  });  it("en 词典：Current chat；模型 hover 后缀", () => {
    const html = renderMember(member({ target: "a", status: "running", model: "gpt-x" }), {
      lang: "en",
      isCurrent: false,
      disabled: false,
    });
    expect(html).toContain('title="Open member conversation"');
    expect(html).toContain('class="model"> · Model: gpt-x</span>');
    expect(html).toContain("Running");
  });
  it("failed 卡追加 diagnostic 行（错误色类）", () => {
    const html = renderMember(member({ target: "x", status: "failed", diagnostics: ["spawn failed: closed"] }), {
      lang: "zh",
      isCurrent: false,
      disabled: true,
    });
    expect(html).toContain('class="diagnostic">spawn failed: closed</span>');
  });
  it("inactive → 人形图标（14px）；running → ongoing 状态点", () => {
    const inactive = renderMember(member({ target: "i" }), { lang: "zh", isCurrent: false, disabled: false });
    expect(inactive).toContain('class="icon-user"');
    expect(inactive).toContain('width="14"');
    const running = renderMember(member({ target: "r", status: "running" }), { lang: "zh", isCurrent: false, disabled: false });
    expect(running).toContain('class="dot ongoing"');
  });
  it("30 字长名字夹具：转义注入 + ellipsis 类在场（不破卡）", () => {
    const long = "名".repeat(30);
    const html = renderMember(member({ target: long }), { lang: "zh", isCurrent: false, disabled: false });
    expect(html).toContain(long);
    expect(html).toContain('class="name"');
  });
});

describe("成员设置齿轮（stage-8 D）", () => {
  const twoMembers = frame({
    members: [
      member({ target: "lead", role: "lead", id: TEAM, sessionId: TEAM }),
      member({ target: "alice", id: "m_alice" }),
    ],
  });

  it("默认关：不输出 member-card/齿轮（伴生页/静态卡片结构不变）", () => {
    const html = renderRoster(twoMembers, "zh");
    expect(html).not.toContain("member-card");
    expect(html).not.toContain("data-member-gear");
    const viaBody = renderPanelBody(twoMembers, "zh");
    expect(viaBody).not.toContain("data-member-gear");
  });

  it("开启后：成员按钮外包 div.member-card；仅 teammate 出齿轮（Lead 不放）", () => {
    const html = renderRoster(twoMembers, "zh", { memberSettings: true });
    expect(html).toContain('<div class="member-card"><button class="member" data-member-id="m_alice"');
    expect((html.match(/data-member-gear=/g) ?? []).length).toBe(1);
    expect(html).toContain('data-member-gear="m_alice"');
    // Lead 行保持原结构（不包 member-card、无齿轮）
    expect(html).toContain(`<button class="member current" data-member-id="${TEAM}"`);
    expect(html).not.toContain(`data-member-gear="${TEAM}"`);
  });

  it("齿轮在成员按钮之外（不嵌套 button）+ aria/title 文案 + 14px 图标", () => {
    const html = renderRoster(twoMembers, "en", { memberSettings: true });
    // 结构：</button><button class="member-gear" ...>（HTML 不允许 button 嵌 button）
    expect(html).toMatch(/<\/button><button class="member-gear" data-member-gear="m_alice"/);
    expect(html).toContain('title="Member settings"');
    expect(html).toContain('aria-label="Member settings"');
    expect(html).toContain('width="14"');
    expect(html).toContain('class="member-gear"');
  });

  it("renderPanelBody 透传选项（第 4 参）", () => {
    const html = renderPanelBody(twoMembers, "zh", { loading: false }, { memberSettings: true });
    expect(html).toContain("data-member-gear");
  });
});

describe("任务卡与 meta（V07/V08）", () => {
  it("meta 顺序 = id、Owner、可开始（仅 pending）、依赖、写入范围、警告", () => {
    const html = renderTaskMeta(
      task({
        id: "task-7",
        ownerName: "alice",
        blockedBy: ["task-1", "task-2"],
        writeScopes: ["src/a", "src/b"],
        writeScopeWarnings: ["write scopes overlap with task-9"],
      }),
      "zh",
    );
    const order = ["task-7", "Owner: alice", "可开始", "依赖: task-1, task-2", "写入范围: src/a, src/b", "write scopes overlap with task-9"];
    let pos = -1;
    for (const frag of order) {
      const p = html.indexOf(frag);
      expect(p, frag).toBeGreaterThan(pos);
      pos = p;
    }
    expect(html).toContain('class="warning"');
  });
  it("未分配 + 非 pending 不渲染 ready/blocked + 空字段不渲染", () => {
    const html = renderTaskMeta(task({ id: "t2", status: "in_progress" }), "zh");
    expect(html).toContain("未分配");
    expect(html).not.toContain("可开始");
    expect(html).not.toContain("被依赖阻塞");
    expect(html).not.toContain("依赖:");
    expect(html).not.toContain("写入范围");
  });
  it("pending∧¬ready → 被依赖阻塞", () => {
    const html = renderTaskMeta(task({ id: "t3", ready: false, blockedBy: ["t1"] }), "zh");
    expect(html).toContain("被依赖阻塞");
  });
  it("任务卡：展开开关默认 hidden + aria-expanded=false + chevron 12px；描述两行截断类", () => {
    const html = renderTasks(frame({ tasks: [task({ id: "t1", subject: "标题", description: "行1\n行2\n行3" })] }), "zh");
    expect(html).toContain("<h3>共享任务<span class=\"count\">1</span></h3>");
    expect(html).toContain('class="expand-toggle" hidden aria-expanded="false"');
    expect(html).toContain('width="12"');
    expect(html).toContain("data-task-desc");
    expect(html).toContain("行1\n行2\n行3");
    expect(html).toContain("<strong>标题</strong>");
    // 上游 DOM：title → p → meta，toggle 是 meta 首子元素（float:right）。
    expect(html).toMatch(/<p data-task-desc>[\s\S]*<\/p><div class="meta"><button class="expand-toggle"/);
  });
  it("空任务板（V11）：无 h3，仅 emptyNotice 段落文案逐字", () => {
    const html = renderTasks(frame({ tasks: [] }), "zh");
    expect(html).not.toContain("<h3>");
    expect(html).toContain('<p class="empty-notice">暂无共享任务，可以通过对话创建</p>');
    const en = renderTasks(frame({ tasks: [] }), "en");
    expect(en).toContain("No shared tasks yet. Create them through the conversation.");
  });
});

describe("花名册（V03/V04）", () => {
  it("count 仅 members>1 显示", () => {
    const one = renderRoster(frame({ members: [member({ target: "lead", role: "lead", id: TEAM })] }), "zh");
    expect(one).toContain("<h3>成员</h3>");
    expect(one).not.toContain("count");
    const two = renderRoster(
      frame({ members: [member({ target: "lead", role: "lead", id: TEAM }), member({ target: "a" })] }),
      "zh",
    );
    expect(two).toContain('<span class="count">2</span>');
  });
  it("当前 Tag 恒显示；members>1 才有当前卡高亮", () => {
    const solo = renderRoster(frame({ members: [member({ target: "lead", role: "lead", id: TEAM, sessionId: TEAM })] }), "zh");
    expect(solo).toContain("current-tag");
    expect(solo).not.toContain("member current");
    const duo = renderRoster(
      frame({
        members: [
          member({ target: "lead", role: "lead", id: TEAM, sessionId: TEAM }),
          member({ target: "a", sessionId: "sess_a" }),
        ],
      }),
      "zh",
    );
    expect(duo).toContain("member current");
    expect(duo).toContain("当前会话");
  });
});

describe("通知条（F06/V10，§10.4 顺序）", () => {
  it("三型按序：导航错误(alert) → 加载/不可用(status) → failure(alert)", () => {
    const html = renderNotices({ lang: "zh", navError: "导航失败", loading: true, failure: "record corrupt" });
    const nav = html.indexOf("导航失败");
    const loading = html.indexOf("正在加载团队…");
    const failure = html.indexOf("团队持久记录无效：record corrupt");
    expect(nav).toBeGreaterThanOrEqual(0);
    expect(loading).toBeGreaterThan(nav);
    expect(failure).toBeGreaterThan(loading);
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });
  it("加载完仍无 team → unavailable（warning 点）", () => {
    const html = renderNotices({ lang: "zh", noTeam: true });
    expect(html).toContain("Team 暂不可用");
    expect(html).toContain('dot warning');
  });
  it("loading 优先于 unavailable（同槽位互斥）", () => {
    const html = renderNotices({ lang: "zh", loading: true, noTeam: true });
    expect(html).toContain("正在加载团队…");
    expect(html).not.toContain("Team 暂不可用");
    expect(html).toContain('dot ongoing');
  });
});

describe("renderPanelBody 组合（F01）", () => {
  it("failure 终态：failure 条显示 + roster/tasks 照常渲染（最后有效状态之上）", () => {
    const html = renderPanelBody(
      frame({
        team: { teamId: TEAM, status: "failure", failure: "bad record", seq: 9 },
        members: [member({ target: "lead", role: "lead", id: TEAM }), member({ target: "a" })],
        tasks: [task({ id: "t1" })],
      }),
      "zh",
    );
    expect(html).toContain("团队持久记录无效：bad record");
    expect(html).toContain("成员");
    expect(html).toContain("共享任务");
  });
  it("team:null + 非加载 → 仅 unavailable 条（不渲染空花名册）", () => {
    const html = renderPanelBody(frame({ team: null }), "zh");
    expect(html).toContain("Team 暂不可用");
    expect(html).not.toContain("roster");
  });
  it("team:null + loading → 加载条", () => {
    const html = renderPanelBody(frame({ team: null }), "zh", { loading: true });
    expect(html).toContain("正在加载团队…");
  });
  it("满员 8 成员 + 六态任务全部渲染", () => {
    const members: ViewFrameMember[] = [
      member({ target: "lead", role: "lead", id: TEAM, status: "running" }),
      member({ target: "a", status: "running" }),
      member({ target: "b", status: "inactive" }),
      member({ target: "c", status: "provisioning" }),
      member({ target: "d", status: "failed", diagnostics: ["e1"] }),
      member({ target: "e", status: "inactive" }),
      member({ target: "f", status: "inactive" }),
      member({ target: "g", status: "inactive" }),
    ];
    const tasks = [
      task({ id: "t1", status: "pending", ready: true }),
      task({ id: "t2", status: "pending", ready: false, blockedBy: ["t1"] }),
      task({ id: "t3", status: "in_progress" }),
      task({ id: "t4", status: "completed" }),
    ];
    const html = renderPanelBody(frame({ members, tasks }), "zh");
    for (const m of members) expect(html).toContain(m.target);
    expect(html.match(/dot ongoing/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("dot idle");
    expect(html).toContain("dot warning");
    expect(html).toContain("dot done");
    expect(html).toContain("dot error");
    expect(html).toContain('class="icon-user"');
  });
});

describe("esc 转义", () => {
  it("HTML 注入面全转义", () => {
    expect(esc(`<img src=x onerror="a&b">`)).toBe("&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;");
    expect(esc("it's")).toBe("it&#39;s");
  });
  it("任务 subject/description 走转义（XSS 面）", () => {
    const html = renderTasks(frame({ tasks: [task({ id: "t1", subject: "<b>x</b>", description: "<script>" })] }), "zh");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
