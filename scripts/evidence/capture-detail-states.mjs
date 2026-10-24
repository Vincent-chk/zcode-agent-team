#!/usr/bin/env node
// U04 三态截图（loading / ready / error）+ DOM 断言（伴生面板载体；与 MCP Apps 面板同源组件层）。
// 证据：stage-6-e2e-acceptance/evidence/26-U04-{loading,ready,error}.png + DOM 断言 JSON。
// 用法：node scripts/evidence/capture-detail-states.mjs [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.resolve(proj, "../zcode-agent-team-plan/stage-6-e2e-acceptance/evidence");
fs.mkdirSync(outDir, { recursive: true });
const { chromium } = await import(path.join(proj, "node_modules", "playwright-core", "index.mjs"));

const PAGE = fs.readFileSync(path.join(proj, "dist", "ui", "team-companion.html"), "utf8");
const ORIGIN = "http://127.0.0.1:46991";
const TOKEN = "u04-token";
const frame = {
  type: "view",
  stateVersion: 4,
  team: { teamId: "sess_u04", status: "active", seq: 5 },
  members: [
    { target: "lead", role: "lead", status: "running", diagnostics: [], id: "sess_u04", sessionId: "sess_u04" },
    { target: "alice", role: "teammate", status: "inactive", diagnostics: [], id: "m_alice", sessionId: "sess_alice" },
  ],
  tasks: [],
  meta: { generatedAt: new Date().toISOString(), revision: 5, sessionId: "sess_u04" },
};
const detailReady = {
  sessionId: "sess_alice",
  memberId: "m_alice",
  page: {
    items: [
      { seq: 2, ts: new Date().toISOString(), role: "assistant", kind: "text", text: "收到任务，开始执行。" },
      { seq: 1, ts: new Date().toISOString(), role: "user", kind: "text", text: "请实现 alpha.txt" },
    ],
  },
  total: 2,
};

const results = [];
const shot = async (page, name) => {
  const file = path.join(outDir, `26-U04-${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
let mode = "loading";
await page.route(`${ORIGIN}/panel**`, (route) =>
  route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE }),
);
await page.route("**/events**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: hello\ndata: {"ts":"t0"}\n\nevent: view\ndata: ${JSON.stringify(frame)}\n\n`,
  }),
);
await page.route("**/api/call**", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  if (body.action !== "detail") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "heartbeat" }) });
    return;
  }
  if (mode === "loading") {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "detail", detail: detailReady }) });
    return;
  }
  if (mode === "error") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ kind: "error", message: "成员会话尚未落定（可重试）", reason: "session-not-settled" }),
    });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "detail", detail: detailReady }) });
});
await page.goto(`${ORIGIN}/panel?token=${TOKEN}`);
await page.click("[data-trigger]");
await page.waitForSelector(".at-panel-wrap.open");
await page.waitForSelector("button.member[data-member-id='m_alice']");

// loading
await page.click("button.member[data-member-id='m_alice']");
await page.waitForSelector(".detail-state .dot.ongoing", { timeout: 2000 });
results.push({ state: "loading", ok: await page.locator(".detail-state").innerText(), shot: await shot(page, "loading") });

// ready（等响应返回：copy 按钮只在 ready 态出现）
await page.waitForSelector("[data-detail-copy]", { timeout: 8000 });
await page.waitForTimeout(200);
results.push({
  state: "ready",
  ok: (await page.locator(".detail-title").innerText()).trim(),
  items: await page.locator(".detail-list").innerText(),
  copyTitle: await page.locator("[data-detail-copy]").getAttribute("title"),
  shot: await shot(page, "ready"),
});

// error（refresh 触发第二次请求 → error）
mode = "error";
await page.click("[data-detail-refresh]");
await page.waitForSelector(".detail-state.error", { timeout: 3000 });
results.push({ state: "error", ok: (await page.locator(".detail-state.error").innerText()).trim(), shot: await shot(page, "error") });

await browser.close();
const pass =
  /Loading|加载/.test(results[0].ok) &&
  results[1].ok === "alice" &&
  results[1].items.includes("alpha.txt") &&
  results[1].copyTitle === "sess_alice" &&
  /not settled|尚未落定/.test(results[2].ok);
const report = { scenario: "U04-detail-three-states", pass, carrier: "companion-panel（同源组件层）", states: results };
fs.writeFileSync(path.join(outDir, "26-U04-three-states.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = pass ? 0 : 1;
