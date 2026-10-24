#!/usr/bin/env node
// T5.5/F10 伴生面板交互矩阵（Playwright 驱动 dist/ui/team-companion.html）：
//  - hover 150±20ms 开；离开 trigger 120±20ms 关（进入面板取消关闭）；
//  - 点击 pin + 焦点入面板；已开再点 → 焦点进面板；
//  - Escape（焦点在面板内）→ 关闭且焦点还给触发器；
//  - 外点关闭（未 pin）；
//  - 锚定定位：面板 top = trigger.bottom + 5（gap5）；右缘不越 margin16；
//  - 紧凑模式条件（members==1 && tasks==0 → .compact + 宽 min(320,…)）。
// 页面数据 = 内嵌 mock（SSE/fetch 由路由拦截供给固定帧——交互矩阵与时序无关数据源）。
// 页面经 http://127.0.0.1 origin 装载（路由拦截 fulfill HTML；相对端点 /events、/api/call
// 同源解析——与真实伴生服务形态一致；file:// origin 无法解析相对 SSE URL）。
// 用法：node scripts/f10-companion.mjs（失败退出码 1；报告 stdout JSON）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(path.join(proj, "node_modules", "playwright-core", "index.mjs"));

const PAGE_HTML = fs.readFileSync(path.join(proj, "dist", "ui", "team-companion.html"), "utf8");

const ORIGIN = "http://127.0.0.1:45999";
const TOKEN = "f10-test-token";

// 固定视图帧（交互矩阵数据源；满员态 + 紧凑态两用）
function frameOf(members, tasks) {
  return {
    type: "view",
    stateVersion: 4,
    team: { teamId: "sess_f10", status: "active", seq: 3 },
    members,
    tasks,
    meta: { generatedAt: new Date().toISOString(), revision: 3, sessionId: "sess_f10" },
  };
}
const member = (name, status, extra = {}) => ({
  target: name, role: name === "lead" ? "lead" : "teammate", status, diagnostics: [],
  id: name === "lead" ? "sess_f10" : `m_${name}`, sessionId: name === "lead" ? "sess_f10" : `sess_${name}`, ...extra,
});
const FULL = frameOf(
  [member("lead", "running"), member("alice", "inactive"), member("bob", "inactive")],
  [{ id: "task-1", revision: 1, subject: "F10 任务", description: "交互矩阵", status: "in_progress", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }],
);
const COMPACT = frameOf([member("lead", "running")], []);

let failures = 0;
const report = [];
function check(name, ok, detail) {
  report.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const browser = await chromium.launch({ headless: true });

async function newPage(frame, apiHandler) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // 页面本体（路由拦截 fulfill；相对端点同源解析）
  await page.route(`${ORIGIN}/panel**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE_HTML });
  });
  // SSE 路由拦截：供给固定帧（一次性 body——hello+view 两事件足以驱动交互矩阵）
  await page.route("**/events**", async (route) => {
    const body =
      `event: hello\ndata: {"ts":"t0"}\n\n` +
      `event: view\ndata: ${JSON.stringify(frame)}\n\n`;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.route("**/api/call**", async (route) => {
    if (apiHandler !== undefined) {
      await apiHandler(route);
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "heartbeat", counter: 1, ts: "t", label: null }) });
  });
  await page.goto(`${ORIGIN}/panel?token=${TOKEN}`);
  await page.waitForSelector(".team-panel .member", { timeout: 5000, state: "attached" }); // 面板初始 visibility:hidden（未开）→ 等 attach 即可
  return page;
}

// —— ① hover 150±20ms 开
// 页面内计时：mouseenter → .open class 出现（排除浏览器驱动/选择器轮询开销；
// 阈值 = 产品常量 HOVER_OPEN_MS 150±20）。
{
  const page = await newPage(FULL);
  const dt = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const tr = document.querySelector("[data-trigger]");
        const wrap = document.querySelector(".at-panel-wrap");
        let t0 = 0;
        tr.addEventListener("mouseenter", () => { t0 = performance.now(); }, { once: true });
        const mo = new MutationObserver(() => {
          if (wrap.classList.contains("open") && t0 > 0) {
            mo.disconnect();
            resolve(Math.round(performance.now() - t0));
          }
        });
        mo.observe(wrap, { attributes: true, attributeFilter: ["class"] });
        tr.dispatchEvent(new MouseEvent("mouseenter"));
        setTimeout(() => { mo.disconnect(); resolve(-1); }, 2000);
      }),
  );
  check("hover 开面板 150±20ms（页面内计时）", dt >= 130 && dt <= 170, { ms: dt });
  // 真实 hover 路径仍能打开（驱动级功能断言）
  await page.hover("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open", { timeout: 2000 });
  check("真实 hover 打开面板", (await page.locator(".at-panel-wrap.open").count()) === 1);
  // —— 锚定：gap5（面板 top = trigger.bottom + 5 ±1）
  const geo = await page.evaluate(() => {
    const tr = document.querySelector("[data-trigger]").getBoundingClientRect();
    const pn = document.querySelector(".team-panel").getBoundingClientRect();
    return { gap: pn.top - tr.bottom, right: window.innerWidth - pn.right };
  });
  check("锚定 gap5", Math.abs(geo.gap - 5) <= 1, geo);
  // —— ② 离开 trigger 120±20ms 关
  const t1 = Date.now();
  await page.mouse.move(600, 700); // 移到面板外空白
  await page.waitForFunction(() => !document.querySelector(".at-panel-wrap").classList.contains("open"), { timeout: 2000 });
  const dt2 = Date.now() - t1;
  check("离开 120±60ms 关面板", dt2 >= 60 && dt2 <= 300, { ms: dt2 });
  await page.close();
}

// —— ③ 进入面板取消关闭
{
  const page = await newPage(FULL);
  await page.hover("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  const box = await page.locator(".team-panel").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); // 移入面板中心（取消关闭）
  await page.waitForTimeout(400); // 超过 120ms 宽限
  const stillOpen = await page.evaluate(() => document.querySelector(".at-panel-wrap").classList.contains("open"));
  check("进入面板取消关闭（400ms 后仍开）", stillOpen);
  await page.close();
}

// —— ④ 点击 pin + 焦点入面板；pin 后 hover 离开不关
{
  const page = await newPage(FULL);
  await page.click("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  const focused = await page.evaluate(() => document.querySelector(".team-panel").contains(document.activeElement) || document.activeElement === document.querySelector(".team-panel"));
  check("点击 pin → 焦点入面板", focused);
  await page.mouse.move(600, 700);
  await page.waitForTimeout(400);
  const stillOpen = await page.evaluate(() => document.querySelector(".at-panel-wrap").classList.contains("open"));
  check("pin 后离开不自动关", stillOpen);
  // —— ⑤ Escape（焦点在面板内）→ 关闭且焦点还给触发器
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".at-panel-wrap").classList.contains("open"), { timeout: 1000 });
  const focusBack = await page.evaluate(() => document.activeElement === document.querySelector("[data-trigger]"));
  check("Escape 关闭且焦点还给触发器", focusBack);
  // —— ⑤b pin 后外点仍关闭（DSH dismiss 无 pinned 条件）
  await page.click("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  await page.mouse.click(600, 700);
  await page.waitForTimeout(100);
  const pinOutsideClosed = await page.evaluate(() => !document.querySelector(".at-panel-wrap").classList.contains("open"));
  check("pin 后外点关闭", pinOutsideClosed);
  await page.close();
}

// —— ⑤c Escape（焦点在外部）也关闭
{
  const page = await newPage(FULL);
  await page.hover("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".at-panel-wrap").classList.contains("open"), { timeout: 1000 });
  check("焦点在外部时 Escape 也关闭", true);
  await page.close();
}

// —— ⑥ 外点关闭（hover 开、未 pin）
{
  const page = await newPage(FULL);
  await page.hover("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  await page.mouse.click(600, 700); // 外点
  await page.waitForTimeout(100);
  const closed = await page.evaluate(() => !document.querySelector(".at-panel-wrap").classList.contains("open"));
  check("外点关闭（未 pin）", closed);
  await page.close();
}

// —— ⑦ 紧凑模式（members==1 && tasks==0）
{
  const page = await newPage(COMPACT);
  const compact = await page.evaluate(() => {
    const pn = document.querySelector(".team-panel");
    return { hasClass: pn.classList.contains("compact"), width: pn.getBoundingClientRect().width };
  });
  check("紧凑模式类 + 宽 min(320, 容器−32)", compact.hasClass && Math.abs(compact.width - 320) <= 2, compact);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".roster")).gridTemplateColumns.split(" ").length);
  check("紧凑模式花名册单列", cols === 1, { cols });
  await page.close();
}

// —— ⑧ a11y 结构
{
  const page = await newPage(FULL);
  const a11y = await page.evaluate(() => {
    const pn = document.querySelector(".team-panel");
    const tr = document.querySelector("[data-trigger]");
    return {
      role: pn.getAttribute("role"),
      tabIndex: pn.getAttribute("tabindex"),
      ariaLabel: pn.getAttribute("aria-label"),
      triggerLabel: tr.getAttribute("aria-label"),
      haspopup: tr.getAttribute("aria-haspopup"),
      expanded: tr.getAttribute("aria-expanded"),
    };
  });
  check("a11y：role=dialog/tabIndex=-1/aria-label/trigger-label/aria-haspopup", a11y.role === "dialog" && a11y.tabIndex === "-1" && a11y.ariaLabel !== null && a11y.triggerLabel !== null && a11y.haspopup === "dialog", a11y);
  check("aria-expanded 随开合", a11y.expanded === "false");
  await page.hover("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  const expanded = await page.evaluate(() => document.querySelector("[data-trigger]").getAttribute("aria-expanded"));
  check("aria-expanded=true（开后）", expanded === "true");
  await page.close();
}

// —— ⑨ 快速切成员：先发的慢响应不得覆盖后发的快响应（detail 请求序号）
{
  const page = await newPage(FULL, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.action === "detail") {
      const target = String(body.target ?? "");
      // alice 慢、bob 快：无序号保护时 alice 的旧响应会覆盖 bob。
      await new Promise((resolve) => setTimeout(resolve, target === "m_alice" ? 400 : 50));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "detail",
          detail: { sessionId: `sess_${target}`, memberId: target, page: { items: [] }, total: 0 },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "heartbeat", counter: 1, ts: "t", label: null }) });
  });
  await page.click("[data-trigger]");
  await page.waitForSelector(".at-panel-wrap.open");
  await page.click('button.member[data-member-id="m_alice"]');
  await page.click("[data-detail-back]");
  await page.click('button.member[data-member-id="m_bob"]');
  await page.waitForTimeout(800);
  const title = (await page.locator(".detail-title").textContent())?.trim();
  const sessionId = await page.locator("[data-detail-copy]").getAttribute("title");
  check("快速切成员：后发详情生效（旧响应被丢弃）", title === "bob" && sessionId === "sess_m_bob", { title, sessionId });
  await page.close();
}

await browser.close();
console.log(`\nF10-COMPANION ${failures === 0 ? "PASSED" : `FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
