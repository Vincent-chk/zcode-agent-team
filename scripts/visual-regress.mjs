#!/usr/bin/env node
// T5.6 视觉回归工程化：Playwright(chromium) 打开面板/卡片静态夹具页
// （test/visual/fixtures.ts 的 8 组状态快照注入）→ 截图 + DOM 几何断言
// （对照 CSS 数值表 = 02 §10.3–§10.6 / assets/TeamAction.module.pretty.css 自动生成期望值）。
// 基线入库 test/visual/baseline/（浅/深 × zh/en × 8 状态；面板与卡片布局同源 → 共用基线，
// 载体差异仅容器覆写（PANEL_CSS/CARD_CSS），几何断言两载体各自跑）。
// 用法：
//   node scripts/visual-regress.mjs            # 断言 + 与基线比对（缺基线 → 生成）
//   node scripts/visual-regress.mjs --update   # 重录基线
//   node scripts/visual-regress.mjs --only=full,failure  # 只跑指定夹具
// 像素 diff：同版本重跑自比对 ≤0.5%（V15；纯 JS 逐像素，无额外依赖）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = path.join(proj, "test", "visual", "baseline");
const workDir = path.join(proj, "test", "visual", ".work");
const UPDATE = process.argv.includes("--update");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg !== undefined ? onlyArg.slice(7).split(",") : undefined;

// —— 夹具页生成（tsx 不可用 → esbuild 打一个 node 脚本渲染夹具页到 .work/）
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(baselineDir, { recursive: true });

const genEntry = path.join(workDir, "gen-pages.mjs");
const genResult = spawnSync(
  process.execPath,
  [
    path.join(proj, "node_modules", "esbuild", "bin", "esbuild"),
    path.join(proj, "scripts", "visual", "gen-pages.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${genEntry}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);
if (genResult.status !== 0) {
  console.error("FAIL: gen-pages bundle");
  process.exit(1);
}
// gen-pages 输出目录固定 = test/visual/.work（与 workDir 同路径约定，无外部入参）
const gen = spawnSync(process.execPath, [genEntry], { stdio: "inherit" });
if (gen.status !== 0) {
  console.error("FAIL: gen-pages run");
  process.exit(1);
}

// —— Playwright（chromium 无头；系统缓存 ~/Library/Caches/ms-playwright）
const { chromium } = await import(path.join(proj, "node_modules", "playwright-core", "index.mjs"));

const pages = fs
  .readdirSync(workDir)
  // exFAT AppleDouble（._*）不是页面（README 疑难解答同源纪律）
  .filter((f) => f.endsWith(".html") && !f.startsWith("._"))
  .sort();

const browser = await chromium.launch({ headless: true });
let failures = 0;
const results = [];

for (const file of pages) {
  // 命名：<fixture>-<theme>-<lang>-<carrier>.html；fixture 名可含连字符（如 solo-lead/long-text）
  // → theme/lang/carrier 取末尾三段，其余为 fixture。
  const stem = file.replace(/\.html$/, "");
  const segs = stem.split("-");
  const carrier = segs.pop();
  const lang = segs.pop();
  const theme = segs.pop();
  const fixture = segs.join("-");
  if (only !== undefined && !only.includes(fixture)) continue;
  const page = await browser.newPage({
    viewport: fixture === "narrow" ? { width: 400, height: 900 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.error(`  [pageerror] ${file}: ${e.message}`));
  try {
    await page.goto(`file://${path.join(workDir, file)}`);
    await page.waitForSelector(".team-panel", { timeout: 10_000 });
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${file} — 页面加载/选择器超时: ${err.message.split("\n")[0]}`);
    results.push({ case: file, status: "FAIL", asserts: [`load: ${err.message.split("\n")[0]}`] });
    await page.close();
    continue;
  }
  await page.evaluate(() => document.fonts?.ready);
  // 布局稳定（ResizeObserver 测量轮）
  await page.waitForTimeout(150);

  // DOM 几何断言（期望值 = CSS 数值表，容差 ±1px；V01–V11/V13/V16）
  const geo = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cs = (el, k) => getComputedStyle(el)[k];
    const px = (el, k) => parseFloat(getComputedStyle(el)[k]);
    const rect = (el) => el.getBoundingClientRect();
    const panel = q(".team-panel");
    const out = {
      panelWidth: rect(panel).width,
      panelRadius: px(panel, "borderRadius"),
      panelPadding: cs(panel, "padding"),
      compact: panel.classList.contains("compact"),
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
    const body = q(".panel-body");
    if (body) {
      out.bodyPadding = cs(body, "padding");
      out.bodyGutter = cs(body, "scrollbarGutter");
    }
    const h3 = q(".panel-body h3");
    if (h3) {
      out.h3FontSize = px(h3, "fontSize");
      out.h3Weight = cs(h3, "fontWeight");
      out.h3Margin = cs(h3, "margin");
    }
    const h3s = document.querySelectorAll(".panel-body section h3");
    if (h3s.length > 1) out.h3SecondMargin = cs(h3s[1], "margin");
    const count = q("h3 .count");
    if (count) {
      out.countFontSize = px(count, "fontSize");
      out.countNumeric = cs(count, "fontVariantNumeric");
    }
    const roster = q(".roster");
    if (roster) {
      out.rosterColumns = cs(roster, "gridTemplateColumns").split(" ").length;
      out.rosterGap = px(roster, "gap");
    }
    const m = q(".member");
    if (m) {
      out.memberRadius = px(m, "borderRadius");
      out.memberPadding = cs(m, "padding");
      const name = q(".member .name");
      if (name) out.nameEllipsis = cs(name, "textOverflow");
      const sub = q(".member .sub");
      if (sub) out.subFontSize = px(sub, "fontSize");
    }
    const dot = q(".dot");
    if (dot) { out.dotW = px(dot, "width"); out.dotH = px(dot, "height"); }
    const userIcon = q(".icon-user svg");
    if (userIcon) { out.iconUserW = rect(userIcon).width; }
    const tag = q(".current-tag");
    if (tag) {
      out.tagFontSize = px(tag, "fontSize");
      out.tagPadding = cs(tag, "padding");
    }
    const t = q("article.task");
    if (t) {
      out.taskRadius = px(t, "borderRadius");
      out.taskBorder = px(t, "borderTopWidth");
      out.taskPadding = cs(t, "padding");
      const strong = q(".task strong");
      if (strong) { out.taskTitleSize = px(strong, "fontSize"); out.taskTitleWeight = cs(strong, "fontWeight"); }
      const p = q(".task p");
      if (p) { out.descSize = px(p, "fontSize"); out.descLineHeight = px(p, "lineHeight"); out.descMargin = cs(p, "margin"); }
      const meta = q(".task .meta");
      if (meta) { out.metaSize = px(meta, "fontSize"); out.metaLineHeight = px(meta, "lineHeight"); }
      const metaSpan = q(".task .meta > span");
      if (metaSpan) out.metaSpanGap = px(metaSpan, "marginRight");
    }
    const toggle = q(".expand-toggle:not([hidden])");
    if (toggle) {
      out.toggleFloat = cs(toggle, "float");
      out.toggleSize = px(toggle, "fontSize");
      const svg = toggle.querySelector("svg");
      if (svg) out.chevronSize = rect(svg).width;
    }
    const notice = q(".notice, .error-bar");
    if (notice) {
      out.noticePadding = px(notice, "padding");
      out.noticeGap = px(notice, "gap");
      out.noticeSize = px(notice, "fontSize");
    }
    const empty = q(".empty-notice");
    if (empty) {
      out.emptySize = px(empty, "fontSize");
      out.emptyMargin = cs(empty, "margin");
    }
    // 两行截断实测语义（§10.6）：长文本夹具下 clamp 生效（clientHeight ≈ 2×18px）
    const clamped = q(".task p:not(.expanded)");
    if (clamped) {
      out.clampVisibleH = clamped.clientHeight;
      out.clampScrollH = clamped.scrollHeight;
    }
    // 颜色硬编码扫描在 node 侧做（读产物源码），此处收集计算色供基线记录
    const panelBg = cs(panel, "backgroundColor");
    out.panelBg = panelBg;
    // T5.7 detail 视图（V16 版面断言数据）
    const dv = q("[data-detail-view]");
    if (dv) {
      const dl = q(".detail-list");
      out.detailPresent = true;
      out.detailFillsPanel = rect(dv).height > rect(panel).height * 0.8;
      out.detailListOverflowX = dl !== null ? dl.scrollWidth - dl.clientWidth : 0;
      out.msgCount = document.querySelectorAll(".msg").length;
      out.badgeCount = document.querySelectorAll(".msg-badge").length;
      out.toolRowCount = document.querySelectorAll(".tool-row, .tool-static").length;
      const msgText = q(".msg-text");
      if (msgText) { out.msgTextSize = px(msgText, "fontSize"); out.msgTextWrap = cs(msgText, "overflowWrap"); }
      const back = q(".detail-back");
      if (back) out.hasBack = true;
      const copy = q("[data-detail-copy]");
      out.hasCopy = copy !== null;
      out.hasSendControl = q("textarea, input[type=text]") !== null;
      const emptyState = q(".detail-state");
      if (emptyState !== null && out.msgCount === 0) out.emptyStateText = emptyState.textContent.trim();
    }
    return out;
  });

  // 断言（±1px 容差；期望值 = CSS 数值表）
  const asserts = [];
  const near = (name, actual, expected, tol = 1) => {
    if (actual === undefined) return; // 该夹具无此元素 → 跳过
    if (Math.abs(actual - expected) > tol) asserts.push(`${name}: ${actual} ≠ ${expected}±${tol}`);
  };
  const eq = (name, actual, expected) => {
    if (actual === undefined) return;
    if (actual !== expected) asserts.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  };
  if (fixture.startsWith("detail")) {
    // V16（T5.7 查看视图版面；无 DSH 参照——判据 = 几何不破版 + 只读边界 + 三态）
    eq("detailPresent", geo.detailPresent, true);
    eq("detailFillsPanel(V16 占满内容区)", geo.detailFillsPanel, true);
    near("detail 无横向溢出(V16 ≤1px)", geo.detailListOverflowX, 0);
    near("docOverflowX(V13)", geo.docOverflowX, 0);
    eq("hasBack(返回按钮)", geo.hasBack, true);
    eq("hasSendControl(只读边界 F13)", geo.hasSendControl, false);
    if (fixture === "detail") {
      eq("msgCount(转录夹具 6 条)", geo.msgCount, 6);
      eq("badgeCount(framed 徽标 1)", geo.badgeCount, 1);
      eq("toolRowCount(工具行 2)", geo.toolRowCount, 2);
      eq("hasCopy(复制会话 id 恒有)", geo.hasCopy, true);
      eq("msgTextSize(12px)", geo.msgTextSize, 12);
      eq("msgTextWrap(长文本不破版)", geo.msgTextWrap, "anywhere");
    } else {
      // detail-empty：ready 但 0 消息 → 「无消息」三态（复制会话 id 恒有，T5.7 口径）
      eq("msgCount(空态 0)", geo.msgCount, 0);
      eq("hasCopy(复制会话 id 恒有)", geo.hasCopy, true);
      if (geo.emptyStateText === undefined || geo.emptyStateText.length === 0) asserts.push("empty detail state missing");
    }
  } else if (fixture !== "empty") {
    const wantCompact = fixture === "solo-lead";
    eq("compact", geo.compact, wantCompact);
    // §10.3 卡片几何两载体同源（布局同源 → V15 基线共用）：宽 min(500,容器−32)、圆角 12、padding 8px 2px 0
    const vw = fixture === "narrow" ? 400 : 1440;
    if (carrier === "card") near("panelWidth", geo.panelWidth, Math.min(wantCompact ? 320 : 500, vw - 32), 2);
    eq("panelRadius", Math.round(geo.panelRadius), 12);
    eq("panelPadding", geo.panelPadding, "8px 2px 0px");
    near("docOverflowX(V13)", geo.docOverflowX, 0);
    eq("h3FontSize", geo.h3FontSize, 13);
    eq("h3Weight", geo.h3Weight, "500");
    // §10.5：h3 margin 16px 0 8px 4px；body 首节 margin-top 8px（roster 恒为首节）
    eq("h3Margin(首节)", geo.h3Margin, "8px 0px 8px 4px");
    if (geo.h3SecondMargin !== undefined) eq("h3Margin(任务节)", geo.h3SecondMargin, "16px 0px 8px 4px");
    eq("countFontSize", geo.countFontSize, 12);
    if (geo.countNumeric !== undefined) eq("countNumeric", geo.countNumeric.includes("tabular"), true);
    if (geo.rosterColumns !== undefined) eq("rosterColumns", geo.rosterColumns, wantCompact ? 1 : 2);
    eq("rosterGap", geo.rosterGap, 8);
    eq("memberRadius", Math.round(geo.memberRadius), 8);
    eq("memberPadding", geo.memberPadding, "10px 12px");
    eq("nameEllipsis", geo.nameEllipsis, "ellipsis");
    eq("subFontSize", geo.subFontSize, 11);
    near("dotW", geo.dotW, 8, 0.5);
    near("dotH", geo.dotH, 8, 0.5);
    near("iconUserW", geo.iconUserW, 14);
    if (geo.tagFontSize !== undefined) { eq("tagFontSize", geo.tagFontSize, 10); eq("tagPadding", geo.tagPadding, "0px 4px"); }
    if (geo.taskRadius !== undefined) {
      eq("taskRadius", Math.round(geo.taskRadius), 9);
      // border 0.5px：渲染 ≥1 物理px 即可（V07；DPR2 → 计算值可能收敛到 0.5 或 1）
      if (geo.taskBorder < 0.5 || geo.taskBorder > 1.5) asserts.push(`taskBorder: ${geo.taskBorder} ∉ [0.5,1.5]`);
      eq("taskPadding", geo.taskPadding, "11px 13px");
      eq("taskTitleSize", geo.taskTitleSize, 13);
      eq("taskTitleWeight", geo.taskTitleWeight, "500");
      eq("descSize", geo.descSize, 12);
      eq("descLineHeight", geo.descLineHeight, 18);
      eq("descMargin", geo.descMargin, "5px 0px");
      eq("metaSize", geo.metaSize, 11);
      eq("metaLineHeight", geo.metaLineHeight, 20);
      eq("metaSpanGap", geo.metaSpanGap, 10);
    }
    if (geo.toggleSize !== undefined) {
      eq("toggleFloat", geo.toggleFloat, "right");
      eq("toggleSize", geo.toggleSize, 11);
      near("chevronSize", geo.chevronSize, 12);
    }
    if (geo.noticePadding !== undefined) {
      eq("noticePadding", geo.noticePadding, 9);
      eq("noticeGap", geo.noticeGap, 6);
      eq("noticeSize", geo.noticeSize, 12);
    }
    if (geo.emptySize !== undefined) {
      eq("emptySize", geo.emptySize, 12);
      eq("emptyMargin", geo.emptyMargin, "16px 0px 0px 4px");
    }
    if (fixture === "long-text") {
      // 两行截断：可见高 ≈ 2×18=36；scrollHeight > clientHeight（溢出才出开关）
      near("clampVisibleH(2×18)", geo.clampVisibleH, 36, 2);
      if (!(geo.clampScrollH > geo.clampVisibleH + 1)) asserts.push(`clamp not overflowing: scroll=${geo.clampScrollH} client=${geo.clampVisibleH}`);
    }
  } else {
    // 空团队：unavailable 条（§10.4）
    if (geo.noticePadding === undefined) asserts.push("empty fixture: notice bar missing");
  }

  // 截图（.team-panel 边界框；card 载体截整个 body 居中呈现）
  const shotName = `${fixture}-${theme}-${lang}-${carrier}.png`;
  const shotPath = path.join(workDir, shotName);
  const target = carrier === "card" ? await page.$(".team-panel") : await page.$(".at-root");
  await target.screenshot({ path: shotPath });

  // 基线比对（V15：同版本重跑自比对 ≤0.5%）
  const baselinePath = path.join(baselineDir, shotName);
  let pixelDiff = null;
  if (fs.existsSync(baselinePath) && !UPDATE) {
    pixelDiff = await pngDiffPercent(baselinePath, shotPath);
    if (pixelDiff > 0.5) asserts.push(`pixel diff ${pixelDiff.toFixed(2)}% > 0.5%`);
  }
  if (UPDATE || !fs.existsSync(baselinePath)) {
    fs.copyFileSync(shotPath, baselinePath);
  }

  const status = asserts.length === 0 ? "PASS" : "FAIL";
  if (asserts.length > 0) failures += 1;
  results.push({ case: file, status, geo, asserts, ...(pixelDiff !== null ? { pixelDiff } : {}) });
  console.log(`${status} ${file}${asserts.length > 0 ? " — " + asserts.join("; ") : ""}${pixelDiff !== null ? ` (pixel diff ${pixelDiff.toFixed(3)}%)` : ""}`);
  await page.close();
}

await browser.close();

// 几何断言报告 + 基线清单入库（回归脚本报告 = F01 证据）
fs.writeFileSync(
  path.join(proj, "test", "visual", "last-report.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), failures, results }, null, 2),
);

// —— 硬编码色扫描（V12：组件 CSS 0 命中十六进制/rgb 字面量；tokens.ts 兜底层豁免）
const uiCoreDir = path.join(proj, "src", "ui-core");
const colorRe = /(#[0-9a-fA-F]{3,8}\b|rgba?\()/;
for (const f of ["css.ts", "render.ts", "widget.ts", "icons.ts"]) {
  const src = fs.readFileSync(path.join(uiCoreDir, f), "utf8");
  // css.ts 的 COMPONENT_CSS 内只准 var()/color-mix；tokens.ts 才允许字面色
  if (f === "css.ts") {
    // 提取 COMPONENT_CSS/PANEL_CSS/CARD_CSS 模板段扫描（TOKEN_CSS 在 tokens.ts）
    const m = src.match(/`[^`]*`/gs) ?? [];
    for (const seg of m) {
      if (colorRe.test(seg)) {
        console.error(`FAIL V12: hardcoded color in src/ui-core/${f}: ${seg.match(colorRe)[0]}`);
        failures += 1;
      }
    }
  } else if (colorRe.test(src.replace(/\/\/[^\n]*/g, ""))) {
    console.error(`FAIL V12: hardcoded color in src/ui-core/${f}`);
    failures += 1;
  }
}
// 面板 HTML 壳（dist 产物）扫描：只含 <script>（壳零样式）
const panelHtml = fs.readFileSync(path.join(proj, "dist", "ui", "team-panel.html"), "utf8");
const shellOnly = panelHtml.replace(/<script>[\s\S]*<\/script>/, "");
if (colorRe.test(shellOnly)) {
  console.error("FAIL V12: hardcoded color in panel html shell");
  failures += 1;
}

console.log(failures === 0 ? "\nVISUAL-REGRESS PASSED" : `\nVISUAL-REGRESS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------- PNG diff（零依赖）
// PNG 解码 = zlib inflate + 逐 scanline unfilter（8bit 真彩 RGB/RGBA，无隔行）；
// 比较 RGB 通道差异 >16/255 的像素占比。截图由同一 Playwright 版本产出，格式固定。
async function pngDiffPercent(aPath, bPath) {
  const a = decodePng(fs.readFileSync(aPath));
  const b = decodePng(fs.readFileSync(bPath));
  if (a === null || b === null) return 100; // 解码失败 → 视为全异
  if (a.width !== b.width || a.height !== b.height) return 100;
  let diff = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const oa = i * a.bpp;
    const ob = i * b.bpp;
    if (
      Math.abs(a.data[oa] - b.data[ob]) > 16 ||
      Math.abs(a.data[oa + 1] - b.data[ob + 1]) > 16 ||
      Math.abs(a.data[oa + 2] - b.data[ob + 2]) > 16
    ) {
      diff += 1;
    }
  }
  return (diff / n) * 100;
}

function decodePng(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      const body = buf.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        bitDepth = body[8];
        colorType = body[9];
        interlace = body[12];
      } else if (type === "IDAT") {
        idat.push(body);
      } else if (type === "IEND") break;
      off += 12 + len;
    }
    // 仅 8bit 真彩（2=RGB / 6=RGBA）非隔行（Playwright 截图产物域）
    const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (bitDepth !== 8 || bpp === 0 || interlace !== 0) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[p++];
      const line = raw.subarray(p, p + stride);
      p += stride;
      const cur = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v & 0xff;
      }
      cur.copy(out, y * stride);
      prev = cur;
    }
    return { width, height, bpp, data: out };
  } catch {
    return null;
  }
}
