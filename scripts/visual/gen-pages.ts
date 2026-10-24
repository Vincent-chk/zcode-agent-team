// 夹具页生成（visual-regress.mjs 第一步；esbuild bundle 后以 node 运行）：
// 8 组状态夹具 × {light,dark} × {zh,en} × {panel,card} → test/visual/.work/<fixture>-<theme>-<lang>-<carrier>.html；
// T5.7 detail 夹具（成员转录快照 +1 组）× {light,dark} × {zh,en} → detail-*.html（V16 版面断言）。
// panel 载体 = 面板同源结构（COMPONENT_CSS + PANEL_CSS，无 App 连接——静态注入帧）；
// card 载体 = renderWidgetFragment 产物包 standalone 壳（::visualize 沙箱等价）。
// 两载体共用同一渲染器/几何（布局同源 → V15 基线共用前提）。
// 安全：输出目录为固定仓内路径（test/visual/.work，不接受外部输入）；夹具名来自
// FIXTURES 常量键集并经白名单校验——无动态路径片段参与文件写入。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENT_CSS, PANEL_CSS } from "../../src/ui-core/css.js";
import { renderPanelBody } from "../../src/ui-core/render.js";
import { renderDetailView } from "../../src/ui-core/detail-render.js";
import { renderWidgetFragment } from "../../src/ui-core/widget.js";
import { DICT, type Lang } from "../../src/ui-core/dict.js";
import { FIXTURES, FIXTURE_DETAIL, FIXTURE_DETAIL_EMPTY } from "../../test/visual/fixtures.js";
import type { DetailResult } from "../../src/panel/detail.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// 固定输出根 = 本 bundle 所在目录（visual-regress.mjs 约定 bundle 输出进 test/visual/.work；
// 不接受外部路径入参——无动态路径片段参与文件写入）
const outDir = scriptDir;
fs.mkdirSync(outDir, { recursive: true });

const themes = ["light", "dark"] as const;
const langs: Lang[] = ["zh", "en"];
const carriers = ["panel", "card"] as const;

let count = 0;
for (const [fixture, frame] of Object.entries(FIXTURES)) {
  // 夹具名白名单（仅 FIXTURES 常量键；文件名安全字符集）
  if (!/^[a-z][a-z-]*$/.test(fixture)) throw new Error(`gen-pages: 非法夹具名 ${fixture}`);
  for (const theme of themes) {
    for (const lang of langs) {
      for (const carrier of carriers) {
        const body = carrier === "panel" ? panelPage(frame, lang, theme) : cardPage(frame, lang, theme);
        const fileName = [fixture, theme, lang, carrier].join("-") + ".html";
        fs.writeFileSync(path.join(outDir, fileName), body);
        count += 1;
      }
    }
  }
}

// T5.7 detail 夹具（+1 组成员转录快照；V16 版面 = 几何不破版 + 风格宿主一致）
const detailFixtures: Record<string, { detail: DetailResult; name: string }> = {
  detail: { detail: FIXTURE_DETAIL as unknown as DetailResult, name: "alice" },
  "detail-empty": { detail: FIXTURE_DETAIL_EMPTY as unknown as DetailResult, name: "newbie" },
};
for (const [fixture, fx] of Object.entries(detailFixtures)) {
  if (!/^[a-z][a-z-]*$/.test(fixture)) throw new Error(`gen-pages: 非法夹具名 ${fixture}`);
  for (const theme of themes) {
    for (const lang of langs) {
      const body = detailPage(fx.detail, fx.name, lang, theme);
      fs.writeFileSync(path.join(outDir, [fixture, theme, lang, "panel"].join("-") + ".html"), body);
      count += 1;
    }
  }
}
console.log(`gen-pages: ${count} pages → ${outDir}`);

function panelPage(frame: (typeof FIXTURES)[string], lang: Lang, theme: string): string {
  const compact = frame.members.length === 1 && frame.tasks.length === 0;
  const body = renderPanelBody(frame, lang, { loading: false });
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}" data-theme="${theme}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${DICT[lang].trigger}</title>
<style>${COMPONENT_CSS}${PANEL_CSS}</style>
</head>
<body>
<div class="at-root">
<div class="team-panel${compact ? " compact" : ""}" role="dialog" aria-label="${DICT[lang].trigger}" data-team-panel tabindex="-1">
<div class="panel-body" data-list-view>${body}</div>
</div>
</div>
</body>
</html>`;
}

function cardPage(frame: (typeof FIXTURES)[string], lang: Lang, theme: string): string {
  const fragment = renderWidgetFragment({ frame, lang, theme: theme as "light" | "dark" });
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}" data-theme="${theme}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${DICT[lang].trigger}</title>
<style>html,body{margin:0}</style>
</head>
<body>
${fragment}
</body>
</html>`;
}

/** T5.7 detail 夹具页（V16：占满面板内容区的二级视图；面板载体同壳）。 */
function detailPage(detail: DetailResult, name: string, lang: Lang, theme: string): string {
  const inner = renderDetailView({ kind: "ready", memberId: detail.memberId, name, detail }, lang);
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}" data-theme="${theme}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${DICT[lang].trigger}</title>
<style>${COMPONENT_CSS}${PANEL_CSS}
.at-root .team-panel { height: 640px; }
</style>
</head>
<body>
<div class="at-root">
<div class="team-panel" role="dialog" aria-label="${DICT[lang].trigger}" data-team-panel tabindex="-1" data-detail-fixture>
<div class="detail-view" data-detail-view>${inner}</div>
</div>
</div>
</body>
</html>`;
}
