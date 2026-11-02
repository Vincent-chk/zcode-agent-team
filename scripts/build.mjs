// agent-team 构建脚本：daemon/hooks 打包为 node ESM 单文件，panel 打包为浏览器 iife 并内联进 HTML。
// 〔D31 2026-11-02〕产物语法门：全部产物写完后 node --check 逐个校验（exFAT 落盘撕裂防护），
// 坏则整体重建 ≤3 次，仍坏 exit 1——撕裂 bundle 不允许离开构建这一步（此前靠人工复检）。
import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkNodeSyntax, BUNDLE_FILES } from "./check-bundles.mjs";

const root = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const proj = path.resolve(root, "..");
const runtime = path.join(proj, "runtime");

async function buildAll() {
  await mkdir(path.join(runtime, "ui"), { recursive: true });

  // 1) daemon + hooks + team-ctl（node 单文件）
  for (const [entry, out] of [
    ["src/daemon.ts", "runtime/team-daemon.mjs"],
    ["src/hooks.ts", "runtime/team-hooks.mjs"],
    ["src/cli/main.ts", "runtime/team-ctl.mjs"],
  ]) {
    await build({
      entryPoints: [path.join(proj, entry)],
      outfile: path.join(proj, out),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: false,
      logLevel: "info",
    });
  }

  // 1b) 独立子进程资产（runtime/team-daemon.mjs 同目录 sibling）
  await copyFile(path.join(proj, "src/provider/detach-helper.mjs"), path.join(runtime, "detach-helper.mjs"));
  await copyFile(path.join(proj, "src/provider/app-server-bridge.mjs"), path.join(runtime, "app-server-bridge.mjs"));

  // 2) panel + companion（浏览器 iife）
  for (const [entry, out] of [
    ["src/panel/main.ts", "panel.js"],
    ["src/panel/companion-main.ts", "companion.js"],
  ]) {
    await build({
      entryPoints: [path.join(proj, entry)],
      outfile: path.join(runtime, "ui", out),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      sourcemap: false,
      logLevel: "info",
    });
  }

  // 3) 内联进 HTML（ui:// 资源要求自包含，≤4MiB）。
  // 面板 JS（src/panel/main.ts）自建全部 DOM 并注入样式（ui-core/tokens+css 同源层，
  // 令牌映射见 docs/token-map.md）；HTML 壳只承载 <script>——零硬编码色（V12 扫描面最小）。
  const js = await readFile(path.join(runtime, "ui", "panel.js"), "utf8");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Team</title>
</head>
<body>
<script>
${js}
</script>
</body>
</html>`;
  await writeFile(path.join(runtime, "ui", "team-panel.html"), html);
  const htmlBytes = Buffer.byteLength(html, "utf8");
  console.log("panel html written:", path.join(runtime, "ui", "team-panel.html"), (htmlBytes / 1024).toFixed(1) + "KiB");

  // 4) 伴生面板页（T5.5 可选高保真；companion-server 以 __dirname/ui/team-companion.html 供页）
  const companionJs = await readFile(path.join(runtime, "ui", "companion.js"), "utf8");
  const companionHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Team · Companion</title>
</head>
<body>
<script>
${companionJs}
</script>
</body>
</html>`;
  await writeFile(path.join(runtime, "ui", "team-companion.html"), companionHtml);
  console.log("companion html written:", (Buffer.byteLength(companionHtml, "utf8") / 1024).toFixed(1) + "KiB");
}

// —— 〔D31〕语法门 + 整体重建循环（撕裂是偶发落盘问题，重试即好；连续坏 = 卷异常，fail-loud）
// JS 产物走 node --check（含 0 字节判定）；HTML 走「非空 + 以 </html> 收尾」（撕裂的 JS 会让内联
// HTML 截断）。4MiB ui:// 上限放到重建之后：撕裂可能撑大产物，重试后才判定为真超限。
const MAX_ATTEMPTS = 3;
const HTML_FILES = ["runtime/ui/team-panel.html", "runtime/ui/team-companion.html"];

/** HTML 完整性：非空且以 </html> 收尾（撕裂/截断即不满足）。返回第一个坏文件或 null。 */
async function checkHtml(files) {
  for (const file of files) {
    try {
      const text = await readFile(file, "utf8");
      if (text.trim().length === 0 || !text.trimEnd().endsWith("</html>")) return file;
    } catch {
      return file;
    }
  }
  return null;
}

for (let attempt = 1; ; attempt++) {
  await buildAll();
  const torn = checkNodeSyntax(BUNDLE_FILES.map((rel) => path.join(proj, rel))) ?? (await checkHtml(HTML_FILES.map((rel) => path.join(proj, rel))));
  if (torn === null) {
    const htmlBytes = Buffer.byteLength(await readFile(path.join(runtime, "ui", "team-panel.html"), "utf8"), "utf8");
    if (htmlBytes > 4 * 1024 * 1024) {
      console.error(`FAIL: panel html exceeds 4MiB ui:// resource limit (${(htmlBytes / 1024).toFixed(1)}KiB)`);
      process.exit(1);
    }
    console.log(`[build] 产物门 OK（${BUNDLE_FILES.length} 个 JS + ${HTML_FILES.length} 个 HTML）`);
    break;
  }
  console.error(`[build] FAIL: syntax/empty check on ${torn}（attempt ${attempt}/${MAX_ATTEMPTS}，疑似落盘撕裂 → 整体重建）`);
  if (attempt >= MAX_ATTEMPTS) {
    console.error(`[build] FAIL: 产物校验连续 ${MAX_ATTEMPTS} 次不过——排查卷健康后重试`);
    process.exit(1);
  }
}
