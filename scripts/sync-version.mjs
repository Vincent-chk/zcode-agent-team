#!/usr/bin/env node
// 四方版本同步：plugin.json / package.json / marketplace.json 条目 / package-lock.json。
// CHANGELOG 首条由人工撰写；本脚本校验其版本与描述是否已与 plugin.json 一致。
//
// 用法：node scripts/sync-version.mjs 0.1.1

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/sync-version.mjs <semver>");
  process.exit(1);
}

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));
}

async function writeJson(rel, value) {
  await fs.writeFile(path.join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const plugin = await readJson(".zcode-plugin/plugin.json");
const pkg = await readJson("package.json");
const market = await readJson("marketplace.json");
const lock = await readJson("package-lock.json");

plugin.version = version;
pkg.version = version;

const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
if (!entry) {
  console.error(`marketplace.json has no entry named ${plugin.name}`);
  process.exit(1);
}
entry.version = version;

lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;

const changelog = await fs.readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const idx = lines.findIndex((l) => /^##\s+/.test(l));
const firstVersion = idx >= 0 ? lines[idx].replace(/^##\s+/, "").trim().split(/\s+/)[0] : null;
const descLine = idx >= 0 ? lines.slice(idx + 1).find((l) => l.startsWith("描述：")) : null;
const firstDescription = descLine ? descLine.slice("描述：".length).trim() : null;

if (firstVersion !== version || firstDescription !== plugin.description) {
  console.error(
    `CHANGELOG.md 首条必须已是 ${version} 且描述与 plugin.json 一致（当前 version=${firstVersion}, description=${JSON.stringify(firstDescription)}）`,
  );
  process.exit(1);
}

await writeJson(".zcode-plugin/plugin.json", plugin);
await writeJson("package.json", pkg);
await writeJson("marketplace.json", market);
await writeJson("package-lock.json", lock);

console.log(`synced version ${version}: plugin.json / package.json / marketplace.json / package-lock.json`);
