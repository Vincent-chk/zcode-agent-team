#!/usr/bin/env node
// agent-team 发布产包脚本（stage-7 T7.1）。
//
// 流程：四方版本校验 → npm ci（锁文件 + npmmirror）→ 构建 → 白名单装配 staging
//      → 产包时过滤 `._*`/`.DS_Store`/工程残留 → 确定性 zip → 解包逐项核验
//      → zcode plugins validate（CLI 0.17.0 只接受目录，故验解包目录）→ 指纹落盘。
//
// 用法：
//   node scripts/release.mjs --out <dir> [--market <dir>] [--require-tag] [--require-clean]
//   node scripts/release.mjs --check-only
//   node scripts/release.mjs --verify-repro --out <dir>
//
// 可复现性：zip 条目按路径排序、时间戳固定为 1980-01-01、无 extra field；
// 构建走 npm ci + package-lock.json。同一源码状态两次运行产物 sha256 应一致。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmmirror.com";
const ZCODE_CLI_DEFAULT = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const PACKAGE_NAME = "agent-team";

// 包内白名单（T7.1 + R7.4 + stage-7 T7.2 用户手册）。src/test/scripts/poc/coverage/node_modules 等一律不进入。
const PACKAGE_ENTRIES = [
  ".zcode-plugin/plugin.json",
  "dist",
  "skills",
  "commands",
  "hooks",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "THIRD-PARTY-NOTICES.md",
  "CHANGELOG.md",
  "docs/使用手册.md",
  "docs/assets/manual",
];

// 允许出现在包内的 docs/ 子树（手册与其截图）；其余 docs 内容仍是工程文档，不随包分发。
const PACKAGE_DOC_PREFIXES = ["docs/使用手册.md", "docs/assets/manual/"];

const REQUIRED_FILES = [
  ".zcode-plugin/plugin.json",
  "dist/team-daemon.mjs",
  "dist/team-hooks.mjs",
  "dist/team-ctl.mjs",
  "dist/ui/team-panel.html",
  "skills/team-coordination/SKILL.md",
  "commands/team.md",
  "hooks/hooks.json",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "THIRD-PARTY-NOTICES.md",
  "docs/使用手册.md",
];

const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "coverage",
  "poc",
  "src",
  "test",
  "scripts",
  ".git",
  ".mimosa",
  ".v2c",
  ".video_agent",
]);

function log(msg) {
  console.log(`[release] ${msg}`);
}

function fail(msg) {
  throw new Error(msg);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, "release"),
    market: null,
    requireTag: false,
    requireClean: false,
    checkOnly: false,
    verifyRepro: false,
    skipInstall: false,
    skipBuild: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--market") args.market = path.resolve(argv[++i]);
    else if (a === "--require-tag") args.requireTag = true;
    else if (a === "--require-clean") args.requireClean = true;
    else if (a === "--check-only") args.checkOnly = true;
    else if (a === "--verify-repro") args.verifyRepro = true;
    else if (a === "--skip-install") args.skipInstall = true;
    else if (a === "--skip-build") args.skipBuild = true;
    else if (a === "--help" || a === "-h") {
      console.log(awaitHelp());
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return args;
}

function awaitHelp() {
  return [
    "agent-team release packager",
    "",
    "  --out <dir>        output directory (default: <repo>/release)",
    "  --market <dir>     also materialize a release marketplace (catalog + unpacked plugin)",
    "  --require-tag      require HEAD to carry tag v<version>",
    "  --require-clean    require a clean git working tree before building",
    "  --check-only       only run the four-way version/description checks",
    "  --verify-repro     pack twice from independently prepared staging and compare sha256",
    "  --skip-install     skip npm ci (debug only; fingerprints record it)",
    "  --skip-build       skip npm run build (debug only)",
  ].join("\n");
}

function run(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? ROOT,
    stdio: opts.stdio ?? "inherit",
    env: opts.env ?? process.env,
    encoding: opts.encoding ?? "utf8",
  });
  if (res.error) fail(`${cmd} failed: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${argv.join(" ")} exited ${res.status}`);
  return res;
}

function runCapture(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
    encoding: "utf8",
  });
  return res;
}

function git(argv) {
  return runCapture("git", argv, { cwd: ROOT });
}

function firstChangelogEntry(text) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+/.test(l));
  if (idx < 0) fail("CHANGELOG.md has no release entry");
  const version = lines[idx].replace(/^##\s+/, "").trim().split(/\s+/)[0];
  const descLine = lines.slice(idx + 1).find((l) => l.startsWith("描述："));
  if (!descLine) fail("CHANGELOG.md first entry has no `描述：` line");
  return { version, description: descLine.slice("描述：".length).trim() };
}

async function checkVersionSync({ requireTag = false } = {}) {
  const plugin = await readJson(path.join(ROOT, ".zcode-plugin/plugin.json"));
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const market = await readJson(path.join(ROOT, "marketplace.json"));
  const changelog = await fsp.readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const lock = await readJson(path.join(ROOT, "package-lock.json"));

  const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
  if (!entry) fail(`marketplace.json has no entry named ${plugin.name}`);
  if (!plugin.version || !pkg.version || !entry.version) fail("missing version field");

  const versions = {
    plugin: plugin.version,
    package: pkg.version,
    marketplace: entry.version,
    changelog: firstChangelogEntry(changelog).version,
  };
  for (const [k, v] of Object.entries(versions)) {
    if (v !== plugin.version) fail(`version mismatch: ${k}=${v}, plugin.json=${plugin.version}`);
  }

  const descriptions = {
    package: pkg.description,
    marketplace: entry.description,
    changelog: firstChangelogEntry(changelog).description,
  };
  for (const [k, v] of Object.entries(descriptions)) {
    if (v !== plugin.description) fail(`description mismatch: ${k}=${JSON.stringify(v)}, plugin.json=${JSON.stringify(plugin.description)}`);
  }

  if (plugin.description_i18n) {
    const m = entry.description_i18n ?? {};
    for (const [locale, text] of Object.entries(plugin.description_i18n)) {
      if (m[locale] !== text) fail(`description_i18n mismatch for ${locale}: marketplace=${JSON.stringify(m[locale])}`);
    }
  }

  const lockVersion = lock.version ?? lock.packages?.[""]?.version;
  if (lockVersion !== plugin.version) fail(`package-lock.json version ${lockVersion} != ${plugin.version}`);
  if (lock.packages?.[""]?.version !== plugin.version) fail(`package-lock.json packages[""].version != ${plugin.version}`);

  if (!entry.displayName_i18n?.["zh-CN"] || !entry.displayName_i18n?.en) fail("marketplace entry missing displayName_i18n zh-CN/en");
  if (!entry.category) fail("marketplace entry missing category");

  if (requireTag) {
    const res = git(["tag", "--points-at", "HEAD"]);
    const tags = res.stdout.split(/\r?\n/).filter(Boolean);
    if (!tags.includes(`v${plugin.version}`)) fail(`HEAD is not tagged v${plugin.version} (tags: ${tags.join(", ") || "none"})`);
  }

  return { plugin, pkg, market, entry, versions };
}

function shouldExclude(rel) {
  const segments = rel.split("/");
  if (segments.some((s) => s === ".DS_Store" || s.startsWith("._"))) return true;
  for (const s of segments) {
    if (EXCLUDED_SEGMENTS.has(s)) return true;
    if (s.startsWith(".") && s !== ".zcode-plugin" && s !== ".mcp.json") return true;
  }
  return false;
}

async function walkFiles(absRoot, relDir, out) {
  const dirents = await fsp.readdir(path.join(absRoot, relDir), { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (shouldExclude(rel)) continue;
    const abs = path.join(absRoot, rel);
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) fail(`symlink is not allowed in package: ${rel}`);
    if (st.isDirectory()) await walkFiles(absRoot, rel, out);
    else if (st.isFile()) out.push(rel);
    else fail(`unsupported file type in package: ${rel}`);
  }
}

async function collectPackageFiles() {
  const files = [];
  for (const entry of PACKAGE_ENTRIES) {
    if (shouldExclude(entry)) fail(`package entry is excluded by policy: ${entry}`);
    const abs = path.join(ROOT, entry);
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      fail(`package entry missing: ${entry}`);
    }
    if (st.isSymbolicLink()) fail(`symlink is not allowed: ${entry}`);
    if (st.isDirectory()) await walkFiles(ROOT, entry, files);
    else if (st.isFile()) files.push(entry);
    else fail(`unsupported package entry: ${entry}`);
  }
  const unique = [...new Set(files)];
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

async function listAllFiles(dir, relDir = "") {
  const out = [];
  const dirents = await fsp.readdir(path.join(dir, relDir), { withFileTypes: true });
  for (const d of dirents) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    const st = await fsp.lstat(path.join(dir, rel));
    if (st.isDirectory()) out.push(...(await listAllFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

function isJunkPath(rel) {
  return rel.split("/").some((s) => s === ".DS_Store" || s.startsWith("._"));
}

async function verifyPackageLayout(dir, plugin, files) {
  const missing = REQUIRED_FILES.filter((rel) => !files.includes(rel));
  if (missing.length) fail(`package missing required files: ${missing.join(", ")}`);

  const junk = files.filter(isJunkPath);
  if (junk.length) fail(`package contains AppleDouble/DS_Store entries: ${junk.join(", ")}`);

  const forbidden = files.filter((rel) => {
    const top = rel.split("/")[0];
    if (["src", "test", "scripts", "poc", "coverage", "node_modules"].includes(top)) return true;
    if (top === "docs") {
      return !PACKAGE_DOC_PREFIXES.some((p) => rel === p || rel.startsWith(p));
    }
    return false;
  });
  if (forbidden.length) fail(`package contains engineering residue: ${forbidden.slice(0, 10).join(", ")}`);

  const manifest = await readJson(path.join(dir, ".zcode-plugin/plugin.json"));
  if (manifest.version !== plugin.version) fail(`packaged manifest version ${manifest.version} != ${plugin.version}`);
  if (manifest.description !== plugin.description) fail("packaged manifest description mismatch");
  if (manifest.name !== PACKAGE_NAME) fail(`packaged manifest name ${manifest.name} != ${PACKAGE_NAME}`);

  const surfaces = manifest.ui?.surfaces ?? [];
  if (!surfaces.length) fail("packaged manifest has no ui.surfaces");
  for (const s of surfaces) {
    if (!s.resourceUri?.startsWith("ui://")) fail(`surface ${s.id} has no ui:// resourceUri`);
    const base = s.resourceUri.split("/").pop();
    const expected = `dist/ui/${base}`;
    if (!files.includes(expected)) fail(`ui surface ${s.id} resource ${s.resourceUri} not found at ${expected}`);
  }
  const panel = await fsp.readFile(path.join(dir, "dist/ui/team-panel.html"));
  if (panel.byteLength > 4 * 1024 * 1024) fail(`team-panel.html exceeds 4MiB: ${panel.byteLength}`);
  if (!panel.includes(Buffer.from("<script"))) fail("team-panel.html has no inline script");

  const changelog = await fsp.readFile(path.join(dir, "CHANGELOG.md"), "utf8");
  const first = firstChangelogEntry(changelog);
  if (first.version !== plugin.version) fail(`packaged CHANGELOG first entry ${first.version} != ${plugin.version}`);
  if (first.description !== plugin.description) fail("packaged CHANGELOG first entry description mismatch");
}

// ---- deterministic zip writer -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 is the ZIP epoch; fixed so repeated packs are byte-identical.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

async function packZip(srcDir, files, outFile) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const rel of files) {
    const data = await fsp.readFile(path.join(srcDir, rel));
    const name = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const method = 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralChunks.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  await fsp.writeFile(outFile, zip);
  return { bytes: zip.length, entries: files.length };
}

// ---- staging / verification ---------------------------------------------------

async function prepareStaging(plugin) {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-team-stage-"));
  const files = await collectPackageFiles();
  for (const rel of files) {
    const dest = path.join(stage, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(ROOT, rel), dest);
  }
  await verifyPackageLayout(stage, plugin, files);
  return { stage, files };
}

async function extractZip(zipFile) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-team-unzip-"));
  run("unzip", ["-qq", zipFile, "-d", dir], { stdio: ["ignore", "pipe", "inherit"] });
  const files = (await listAllFiles(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { dir, files };
}

function findZcodeCli() {
  if (process.env.ZCODE_CLI) return process.env.ZCODE_CLI;
  if (fs.existsSync(ZCODE_CLI_DEFAULT)) return ZCODE_CLI_DEFAULT;
  const which = runCapture("which", ["zcode"]);
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function zcodeVersion(cli) {
  if (!cli) return null;
  if (cli.endsWith(".cjs") || cli.endsWith(".js")) {
    const res = runCapture(process.execPath, [cli, "--version"]);
    return res.status === 0 ? res.stdout.trim() : null;
  }
  const res = runCapture(cli, ["--version"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

function validateDir(cli, dir) {
  if (!cli) fail("zcode CLI not found; set ZCODE_CLI");
  const argv = cli.endsWith(".cjs") || cli.endsWith(".js")
    ? [cli, "plugins", "validate", dir, "--json"]
    : ["plugins", "validate", dir, "--json"];
  const res = runCapture(cli.endsWith(".cjs") || cli.endsWith(".js") ? process.execPath : cli, argv);
  const out = (res.stdout ?? "").trim();
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    fail(`zcode plugins validate produced non-JSON output (exit ${res.status}):\n${out}\n${res.stderr ?? ""}`);
  }
  if (parsed.ok !== true) {
    fail(`zcode plugins validate failed for ${dir}:\n${JSON.stringify(parsed, null, 2)}`);
  }
  return { ok: true, path: dir, diagnostics: parsed.diagnostics ?? [] };
}

async function pruneJunk(dir) {
  const all = await listAllFiles(dir);
  const junk = all.filter(isJunkPath);
  for (const rel of junk) await fsp.rm(path.join(dir, rel), { force: true });
  return junk;
}

async function materializeMarket(marketDir, extractDir, entry, plugin) {
  await fsp.mkdir(marketDir, { recursive: true });
  const pluginDir = path.join(marketDir, PACKAGE_NAME);
  await fsp.rm(pluginDir, { recursive: true, force: true });
  await fsp.cp(extractDir, pluginDir, { recursive: true });

  const prunedPlugin = await pruneJunk(pluginDir);
  const catalogPath = path.join(marketDir, "marketplace.json");
  let catalog = { name: "agent-team-release", plugins: [] };
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = await readJson(catalogPath);
    } catch {
      fail(`existing marketplace.json is invalid: ${catalogPath}`);
    }
  }
  if (!Array.isArray(catalog.plugins)) catalog.plugins = [];
  const nextEntry = {
    name: plugin.name,
    source: `./${PACKAGE_NAME}`,
    version: plugin.version,
    description: plugin.description,
    displayName: entry.displayName,
    displayName_i18n: entry.displayName_i18n,
    description_i18n: entry.description_i18n,
    category: entry.category,
  };
  const idx = catalog.plugins.findIndex((p) => p.name === plugin.name);
  if (idx >= 0) catalog.plugins[idx] = nextEntry;
  else catalog.plugins.push(nextEntry);
  await fsp.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  // exFAT 在复制/写入后会为目录与文件生成 AppleDouble；市场根目录也要清，
  // 否则 `._agent-team`/`._marketplace.json` 会留在发布目录里。
  const prunedRoot = await pruneJunk(marketDir);
  const pruned = [...new Set([...prunedPlugin, ...prunedRoot])].sort();

  const catalogSha = sha256(await fsp.readFile(catalogPath));
  return { dir: marketDir, pluginDir, catalogPath, catalogSha, prunedJunk: pruned };
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sync = await checkVersionSync({ requireTag: args.requireTag });
  const { plugin, entry } = sync;
  log(`four-way sync OK: ${PACKAGE_NAME}@${plugin.version}`);

  if (args.checkOnly) return;

  if (args.requireClean) {
    const st = git(["status", "--porcelain"]);
    if (st.status !== 0) fail("git status failed");
    if (st.stdout.trim()) fail(`working tree is not clean:\n${st.stdout}`);
  }

  const lockPath = path.join(ROOT, "package-lock.json");
  const lockSha = sha256(await fsp.readFile(lockPath));
  const lock = await readJson(lockPath);
  const depVersions = {};
  for (const name of ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/sdk", "zod"]) {
    depVersions[name] = lock.packages?.[`node_modules/${name}`]?.version ?? null;
  }

  if (!args.skipInstall) {
    log(`npm ci (registry ${REGISTRY})`);
    run("npm", ["ci", "--registry", REGISTRY, "--no-audit", "--no-fund"], {
      env: { ...process.env, npm_config_registry: REGISTRY },
    });
  } else {
    log("WARN: npm ci skipped (--skip-install)");
  }

  if (!args.skipBuild) {
    log("npm run build");
    run("npm", ["run", "build"]);
  } else {
    log("WARN: build skipped (--skip-build)");
  }

  await fsp.mkdir(args.out, { recursive: true });
  const zipFile = path.join(args.out, `${PACKAGE_NAME}-${plugin.version}.zip`);

  const first = await prepareStaging(plugin);
  log(`staging: ${first.files.length} files`);
  const packed = await packZip(first.stage, first.files, zipFile);
  const zipBytes = await fsp.readFile(zipFile);
  const zipSha = sha256(zipBytes);
  log(`zip: ${zipFile} (${packed.entries} entries, ${packed.bytes} bytes)`);
  log(`sha256: ${zipSha}`);

  if (args.verifyRepro) {
    const second = await prepareStaging(plugin);
    const secondZip = path.join(os.tmpdir(), `${PACKAGE_NAME}-${plugin.version}-repro-${process.pid}.zip`);
    await packZip(second.stage, second.files, secondZip);
    const secondSha = sha256(await fsp.readFile(secondZip));
    if (secondSha !== zipSha) fail(`reproducibility check failed: ${zipSha} != ${secondSha}`);
    log(`reproducibility OK: second pack sha256 ${secondSha}`);
  }

  const { dir: extractDir, files: extracted } = await extractZip(zipFile);
  const stageSet = first.files.slice().sort();
  const extractedSet = extracted.slice().sort();
  const missing = stageSet.filter((f) => !extractedSet.includes(f));
  const extra = extractedSet.filter((f) => !stageSet.includes(f));
  if (missing.length || extra.length) {
    fail(`zip entry mismatch: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  }
  await verifyPackageLayout(extractDir, plugin, extracted);
  log(`unpacked verification OK: ${extracted.length} files, zero ._*/.DS_Store, zero residue`);

  const cli = findZcodeCli();
  const cliVersion = zcodeVersion(cli);
  const validated = validateDir(cli, extractDir);
  log(`zcode plugins validate OK (${cliVersion ?? "unknown"})`);

  let market = null;
  if (args.market) {
    market = await materializeMarket(args.market, extractDir, entry, plugin);
    validateDir(cli, market.pluginDir);
    log(`market: ${market.dir} (source ./${PACKAGE_NAME}, catalog sha256 ${market.catalogSha})`);
    if (market.prunedJunk.length) log(`pruned regenerated junk in market copy: ${market.prunedJunk.join(", ")}`);
  }

  const gitCommit = git(["rev-parse", "HEAD"]).stdout.trim();
  const gitTags = git(["tag", "--points-at", "HEAD"]).stdout.split(/\r?\n/).filter(Boolean);
  const gitBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const gitDirtyAfter = git(["status", "--porcelain"]).stdout.trim();

  const fileRecords = [];
  for (const rel of extracted) {
    const buf = await fsp.readFile(path.join(extractDir, rel));
    fileRecords.push({ path: rel, size: buf.length, sha256: sha256(buf) });
  }

  const fingerprint = {
    schema: "agent-team-release-fingerprint/v1",
    package: PACKAGE_NAME,
    version: plugin.version,
    description: plugin.description,
    builtAt: new Date().toISOString(),
    git: { commit: gitCommit, branch: gitBranch, tags: gitTags, dirtyAfterBuild: gitDirtyAfter || null },
    toolchain: {
      node: process.version,
      npm: runCapture("npm", ["--version"]).stdout.trim(),
      zcode: cliVersion,
      zcodeCliPath: cli,
    },
    dependencyResolution: {
      lockfile: "package-lock.json",
      lockfileSha256: lockSha,
      registry: REGISTRY,
      npmCi: !args.skipInstall,
      versions: depVersions,
    },
    zip: {
      path: zipFile,
      sha256: zipSha,
      sizeBytes: zipBytes.length,
      entries: extracted.length,
      reproducibleDoublePack: args.verifyRepro ? true : null,
      timestampPolicy: "fixed DOS 1980-01-01, stable path order, no extra fields",
    },
    validate: {
      cliSupportsZipInput: false,
      note: "zcode 0.17.0 plugins validate resolves a file argument to its parent directory; the zip is extracted and the extracted directory is validated",
      extractedDir: extractDir,
      ok: validated.ok,
      diagnostics: validated.diagnostics,
    },
    market: market
      ? {
          dir: market.dir,
          catalogPath: market.catalogPath,
          catalogSha256: market.catalogSha,
          pluginDir: market.pluginDir,
          source: `./${PACKAGE_NAME}`,
          prunedRegeneratedJunk: market.prunedJunk,
        }
      : null,
    files: fileRecords,
  };

  const fingerprintFile = path.join(args.out, `${PACKAGE_NAME}-${plugin.version}.fingerprint.json`);
  await fsp.writeFile(fingerprintFile, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
  log(`fingerprint: ${fingerprintFile}`);
  log(`DONE ${PACKAGE_NAME}@${plugin.version} sha256=${zipSha}`);
}

main().catch((err) => {
  console.error(`[release] FAIL: ${err.message}`);
  process.exitCode = 1;
});
