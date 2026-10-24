// 共享：路径/配置/日志（daemon 与 hooks 都用；一律写文件+stderr，严禁污染 stdout）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateTeamLimits, validateLeadMode, type LeadMode } from "./domain/config.js";

export const PLUGIN_ID = "agent-team";

/** 数据目录：优先 daemon env（TEAM_PLUGIN_DATA），其次 hook env overlay（ZCODE_PLUGIN_DATA/CLAUDE_PLUGIN_DATA），最后开发兜底。 */
export function dataDir(): string {
  const candidates = [
    process.env.TEAM_PLUGIN_DATA,
    process.env.ZCODE_PLUGIN_DATA,
    process.env.CLAUDE_PLUGIN_DATA,
  ];
  for (const c of candidates) if (c && c.trim()) return c;
  return path.join(os.homedir(), ".zcode", "agent-team-dev-data");
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 0700 私有目录（插件数据/日志/meta/团队目录）。已存在目录也尽力收紧权限。 */
export function ensurePrivateDir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    /* 共享卷/非 POSIX：继续，启动日志会暴露权限告警 */
  }
  return p;
}

export function logsDir(): string {
  return ensureDir(path.join(dataDir(), "logs"));
}

/** daemon 落盘的有效运行配置（hooks 读不到 userConfig，只能经此文件取 interrupt/leadMode 等开关）。 */
export interface RuntimeConfig {
  version: 1;
  interrupt: boolean;
  leadMode: LeadMode;
  limits: LimitConfig;
  updatedAt: string;
}

export function runtimeConfigPath(): string {
  return path.join(dataDir(), "meta", "runtime-config.json");
}

export function readRuntimeConfig(): RuntimeConfig | undefined {
  try {
    const raw = fs.readFileSync(runtimeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
    if (parsed.version !== 1 || typeof parsed.interrupt !== "boolean") return undefined;
    // v1 兼容（D26）：旧文件无 leadMode 字段 → 回落默认，不让整个配置判无效而丢 interrupt。
    return { ...(parsed as RuntimeConfig), leadMode: parsed.leadMode === "collaborator" ? "collaborator" : "orchestrator" };
  } catch {
    return undefined;
  }
}

export function writeRuntimeConfig(input: { interrupt: boolean; leadMode: LeadMode; limits: LimitConfig }): void {  const file = runtimeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const doc: RuntimeConfig = {
    version: 1,
    interrupt: input.interrupt,
    leadMode: input.leadMode,
    limits: input.limits,
    updatedAt: ts(),
  };
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 〔stage-6.5 R2，2026-10-24〕宿主 config.json 的 leadMode 直读回落层：消除「配置已改、
 * daemon 未启动 → session-start hook 用默认值」的首会话时序限制（撤销 D26 已知限制）。
 * 只读固定路径 `<homedir>/.zcode/cli/config.json`（homedir 参数仅供单测注入；hook 运行时
 * 取 os.homedir()，测试经 HOME env 覆盖）；解析 plugins.options 下所有 agent-team* 键的
 * leadMode，**仅当有值且全部一致且为合法枚举**时返回该值，否则 undefined
 * （读取失败/无值/垃圾值/多副本冲突 → 退回 runtime-config → 默认 链路）。
 */
export function readHostLeadModeOverride(homedir: string = os.homedir()): LeadMode | undefined {
  const file = path.join(homedir, ".zcode", "cli", "config.json");
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const options = (doc as { plugins?: { options?: unknown } } | null)?.plugins?.options;
  if (options === null || typeof options !== "object") return undefined;
  const strings: string[] = [];
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (!key.startsWith("agent-team")) continue;
    if (value !== null && typeof value === "object") {
      const mode = (value as { leadMode?: unknown }).leadMode;
      if (typeof mode === "string" && mode.length > 0) strings.push(mode);
    }
  }
  if (strings.length === 0) return undefined;
  const first = strings[0] as string;
  // 只接受合法枚举且全键一致；垃圾值/冲突 → 退回下一层（validateLeadMode 不在此用——
  // 它的回落语义是「变默认」，这里要的是「忽略、让下层决定」）。
  if (strings.every((v) => v === first) && (first === "orchestrator" || first === "collaborator")) {
    return validateLeadMode(first);
  }
  return undefined;
}

export function appendJsonl(file: string, obj: unknown): void {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", { mode: 0o600 });
  chmodPrivateOnce(file);
}

export function ts(): string {
  return new Date().toISOString();
}

/**
 * 敏感 env 键（仅用于日志/排障副本脱敏；**绝不**用于真实 spawn 环境）。
 * 覆盖复数/复合/无下划线写法与 URL 内嵌凭据。
 */
const SENSITIVE_ENV_KEY =
  /(?:^|_)(?:KEY|KEYS|APIKEY|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWORDS|PASSWD|PASSPHRASE|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|PRIVATE|URL|URI|DSN|CONNECTION)(?:$|_)/i;

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY.test(key);
}

/** 返回脱敏副本（保留键名，值替换为 <redacted>）。只用于日志/诊断，不得传给真实子进程。 */
export function redactSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSensitiveEnvKey(key) && value !== undefined ? "<redacted>" : value;
  }
  return out;
}

/** 工具名白名单：per-call meta 文件名只能来自已验证的 MCP 工具名，杜绝路径穿越。 */
export function sanitizeToolName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "unknown-tool";
}

/**
 * daemon per-call meta 文件路径：工具名先过白名单（sanitizeToolName），再在 meta/ 根目录内
 * 解析并复核目标仍位于根目录下。非法名/越界路径 → null（调用方跳过落盘）。
 */
export function metaFilePath(dataRoot: string, toolName: unknown, now = Date.now()): string | null {
  const safe = sanitizeToolName(toolName);
  if (safe === "unknown-tool") return null;
  const metaDir = path.resolve(dataRoot, "meta");
  const target = path.resolve(metaDir, `${safe}-${now}-${Math.random().toString(36).slice(2, 8)}.json`);
  if (!target.startsWith(`${metaDir}${path.sep}`)) return null;
  return target;
}

/** 工具参数落盘脱敏：正文/提示词/描述只留长度；敏感键值替换。用于 meta-log / per-call 文件。 */
export function redactToolArguments(args: unknown): unknown {
  const redactValue = (value: unknown, depth = 0): unknown => {
    if (depth > 6) return "<truncated>";
    if (typeof value === "string") {
      return value.length > 256 ? `${value.slice(0, 256)}…(${value.length} chars)` : value;
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (isSensitiveEnvKey(key)) {
          out[key] = "<redacted>";
          continue;
        }
        if (key === "message" || key === "prompt" || key === "description" || key === "content") {
          const length = typeof child === "string" ? child.length : Array.isArray(child) ? child.length : 0;
          out[key] = { redacted: true, chars: length };
          continue;
        }
        out[key] = redactValue(child, depth + 1);
      }
      return out;
    }
    return value;
  };
  return redactValue(args);
}

/** 清理残留的轮次 spec 文件（helper 读后应删除；崩溃窗口可能留下 0600 文件）。 */
export function cleanupStaleSpecs(dataRoot: string, maxAgeMs = 5 * 60_000): number {
  const teamsRoot = path.join(dataRoot, "teams");
  let removed = 0;
  let teams: string[];
  try {
    teams = fs.readdirSync(teamsRoot);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const team of teams) {
    const membersRoot = path.join(teamsRoot, team, "members");
    let members: string[];
    try {
      members = fs.readdirSync(membersRoot);
    } catch {
      continue;
    }
    for (const member of members) {
      const runDir = path.join(membersRoot, member, "run");
      let files: string[];
      try {
        files = fs.readdirSync(runDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".spec.json")) continue;
        const full = path.join(runDir, file);
        try {
          if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
            fs.unlinkSync(full);
            removed += 1;
          }
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return removed;
}

/** per-call meta 文件保留策略：最多 maxFiles 个、最多 maxAgeMs；超限按 mtime 淘汰。 */
export function pruneMetaFiles(dataRoot: string, maxFiles = 500, maxAgeMs = 7 * 24 * 3_600_000): number {
  const dir = path.join(dataRoot, "meta");
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const full = path.join(dir, name);
        return { name, mtimeMs: fs.statSync(full).mtimeMs };
      });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  const stale = entries.filter((e) => now - e.mtimeMs > maxAgeMs);
  const remaining = entries.filter((e) => now - e.mtimeMs <= maxAgeMs).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = Math.max(0, remaining.length - maxFiles);
  for (const entry of [...stale, ...remaining.slice(0, excess)]) {
    try {
      fs.unlinkSync(path.join(dir, entry.name));
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

const chmodded = new Set<string>();
/** 日志文件首次写入后收紧到 0600（兼容历史 0644 文件）。 */
export function chmodPrivateOnce(file: string): void {
  if (chmodded.has(file)) return;
  chmodded.add(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

export interface LimitConfig {
  maxMembers: number;
  maxTasks: number;
  maxMessageBytes: number;
  disposalTimeoutMs: number;
}

export interface ConfigResult {
  ok: boolean;
  error?: string;
  values?: LimitConfig;
}

const LIMIT_KEYS: Array<[keyof LimitConfig, string, number]> = [
  ["maxMembers", "TEAM_MAX_MEMBERS", 8],
  ["maxTasks", "TEAM_MAX_TASKS", 256],
  ["maxMessageBytes", "TEAM_MAX_MESSAGE_BYTES", 65536],
  ["disposalTimeoutMs", "TEAM_DISPOSAL_TIMEOUT_MS", 5000],
];

/**
 * 校验 userConfig 注入的 4 项限额（〔对齐轮〕0.2.1 删 maxPendingMessagesPerMember）：
 * 复用域层 validateTeamLimits（严格十进制 + safe integer）。非法 → TEAM_INVALID_CONFIG，fail loud。
 */
export function loadConfig(): ConfigResult {
  const input: Record<string, unknown> = {};
  for (const [key, envName, def] of LIMIT_KEYS) {
    const raw = process.env[envName];
    // 未注入（如本地手动运行）时用默认值；插件安装形态下 ${user_config.*} 带 default 必然注入
    input[key] = raw === undefined || raw === "" ? def : raw;
  }
  try {
    return { ok: true, values: validateTeamLimits(input) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `TEAM_INVALID_CONFIG: ${detail}（请在 Settings → Plugins → agent-team 的用户配置中改回正整数）。`,
    };
  }
}

/** stderr 结构化日志（stdout 保留给 MCP 协议）。 */
export function logErr(scope: string, msg: string, extra?: unknown): void {
  try {
    process.stderr.write(
      JSON.stringify({ ts: ts(), scope, msg, extra }) + "\n",
    );
  } catch {
    /* 日志失败不致命 */
  }
}
