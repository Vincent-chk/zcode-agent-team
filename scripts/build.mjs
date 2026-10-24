// agent-team 构建脚本：daemon/hooks 打包为 node ESM 单文件，panel 打包为浏览器 iife 并内联进 HTML。
import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const proj = path.resolve(root, "..");
const dist = path.join(proj, "dist");

await mkdir(path.join(dist, "ui"), { recursive: true });

// 1) daemon + hooks + team-ctl（node 单文件）
for (const [entry, out] of [
  ["src/daemon.ts", "dist/team-daemon.mjs"],
  ["src/hooks.ts", "dist/team-hooks.mjs"],
  ["src/cli/main.ts", "dist/team-ctl.mjs"],
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

// 1b) 独立子进程资产（dist/team-daemon.mjs 同目录 sibling）
await copyFile(path.join(proj, "src/provider/detach-helper.mjs"), path.join(dist, "detach-helper.mjs"));
await copyFile(path.join(proj, "src/provider/app-server-bridge.mjs"), path.join(dist, "app-server-bridge.mjs"));

// 2) panel + companion（浏览器 iife）
for (const [entry, out] of [
  ["src/panel/main.ts", "panel.js"],
  ["src/panel/companion-main.ts", "companion.js"],
]) {
  await build({
    entryPoints: [path.join(proj, entry)],
    outfile: path.join(dist, "ui", out),
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
const js = await readFile(path.join(dist, "ui", "panel.js"), "utf8");
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
await writeFile(path.join(dist, "ui", "team-panel.html"), html);
const htmlBytes = Buffer.byteLength(html, "utf8");
console.log("panel html written:", path.join(dist, "ui", "team-panel.html"), (htmlBytes / 1024).toFixed(1) + "KiB");
if (htmlBytes > 4 * 1024 * 1024) {
  console.error("FAIL: panel html exceeds 4MiB ui:// resource limit");
  process.exit(1);
}

// 4) 伴生面板页（T5.5 可选高保真；companion-server 以 __dirname/ui/team-companion.html 供页）
const companionJs = await readFile(path.join(dist, "ui", "companion.js"), "utf8");
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
await writeFile(path.join(dist, "ui", "team-companion.html"), companionHtml);
console.log("companion html written:", (Buffer.byteLength(companionHtml, "utf8") / 1024).toFixed(1) + "KiB");
