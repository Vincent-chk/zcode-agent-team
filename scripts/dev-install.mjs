#!/usr/bin/env node
// agent-team 开发直载管理：把插件目录写入 ~/.zcode/cli/config.json 的 plugins.dirs（用户级）
// 并一次性显式启用（enabledPlugins["agent-team@inline"]=true，dirs 直载默认禁用）。
// 动作：status | install | uninstall | reinstall
// 约束：只追加/移除 plugins.dirs 与 enabledPlugins 的 agent-team 相关键，不动其他配置。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(os.homedir(), ".zcode", "cli", "config.json");
const ENABLE_KEY = "agent-team@inline";

const action = process.argv[2] ?? "status";

function loadConfig() {
  const raw = fs.readFileSync(CONFIG, "utf8");
  return JSON.parse(raw);
}

function saveConfig(cfg) {
  const backup = CONFIG + ".agent-team-bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(CONFIG, backup);
  const tmp = CONFIG + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG);
}

function status(cfg) {
  const dirs = cfg.plugins?.dirs ?? [];
  const enabled = cfg.plugins?.enabledPlugins?.[ENABLE_KEY];
  console.log(JSON.stringify({ pluginDir: PLUGIN_DIR, inDirs: dirs.includes(PLUGIN_DIR), dirs, enabled: enabled === true, enableKey: ENABLE_KEY }, null, 2));
}

function install() {
  const cfg = loadConfig();
  cfg.plugins ??= {};
  cfg.plugins.dirs ??= [];
  if (!cfg.plugins.dirs.includes(PLUGIN_DIR)) cfg.plugins.dirs.push(PLUGIN_DIR);
  cfg.plugins.enabledPlugins ??= {};
  cfg.plugins.enabledPlugins[ENABLE_KEY] = true;
  saveConfig(cfg);
  status(cfg);
  console.log("installed (dirs 直载 + 已显式启用)。开新任务/会话即生效。");
}

function uninstall() {
  const cfg = loadConfig();
  if (cfg.plugins?.dirs) cfg.plugins.dirs = cfg.plugins.dirs.filter((d) => d !== PLUGIN_DIR);
  if (cfg.plugins?.enabledPlugins && ENABLE_KEY in cfg.plugins.enabledPlugins) delete cfg.plugins.enabledPlugins[ENABLE_KEY];
  saveConfig(cfg);
  status(cfg);
  console.log("uninstalled（其他配置未动）。");
}

if (action === "install") install();
else if (action === "uninstall") uninstall();
else if (action === "reinstall") { uninstall(); install(); }
else if (action === "status") status(loadConfig());
else {
  console.error("用法: node scripts/dev-install.mjs [status|install|uninstall|reinstall]");
  process.exit(1);
}
