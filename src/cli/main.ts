// team-ctl 入口（stage-2 第四轮 C / T2.5 + stage-5 T5.3/T5.7）：state / tail / inject-event /
// call / transcript / widget。
// 薄启动器 scripts/team-ctl.mjs → dist/team-ctl.mjs（build.mjs 增入口）；本文件保持可单测。
// 错误摘要单行化（无多行堆栈污染）；非 TTY / NO_COLOR 自动降级纯文本。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "../coord/replay.js";
import { renderState } from "./state.js";
import { followEvents, eventsFileOf } from "./tail.js";
import { injectEvent, invalidMemberSample } from "./inject.js";
import { callTeam } from "./call.js";
import { paintForStream } from "./colors.js";
import { renderTranscript, renderWidget } from "./ui.js";
import { openPanel } from "./open-panel.js";
import { auditSidebar, renderSidebarAudit } from "./sidebar-audit.js";

const USAGE = `team-ctl — Agent Teams 运维/排障工具

用法：
  team-ctl state <teamDir> [--json] [--team <id>]     读盘重放：Roster/Tasks/Mailbox 分区视图
  team-ctl tail <teamDir> [--n <lines>]               跟随 events.jsonl（四类事件着色，本地时区）
  team-ctl inject-event <teamDir> <json-line>         直写原始事件行（test-only，绕过 journal）
  team-ctl inject-event <teamDir> --sample invalid-member --team <id>
                                                      注入非法 member 事件样例（重放 → failure 终态）
  team-ctl call <teamDir> <method> [params-json]      经 socket 调协调者（无协调者 → 可读错误）
  team-ctl transcript <teamDir> <member> [--json] [--cursor <seq>] [--limit <n>] [--mode summary|full] [--team <id>]
                                                      成员会话查看流（T5.7 CLI 对等；与面板 detail 同一合成）
  team-ctl widget <teamDir> [--out <file.html>] [--theme light|dark] [--lang zh|en] [--standalone]
                                                      ::visualize 快照卡片片段 / standalone 静态页（T5.3 CLI 降级链）
  team-ctl open-panel [--no-open]                     打开伴生面板（T5.5；daemon 需以 TEAM_COMPANION=1 运行）
  team-ctl sidebar-audit <teamDir> [--apply] [--json]  把已泄漏到左侧任务栏的成员会话归档（默认 dry-run）`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE + "\n");
    return command === undefined ? 2 : 0;
  }
  try {
    switch (command) {
      case "state":
        return await cmdState(rest);
      case "tail":
        return await cmdTail(rest);
      case "inject-event":
        return cmdInject(rest);
      case "call":
        return await cmdCall(rest);
      case "transcript":
        return await cmdTranscript(rest);
      case "widget":
        return await cmdWidget(rest);
      case "open-panel":
        return await cmdOpenPanel(rest);
      case "sidebar-audit":
        return cmdSidebarAudit(rest);
      default:
        process.stderr.write(`team-ctl: 未知子命令 ${JSON.stringify(command)}\n\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    // 单行化：仅首行消息，无堆栈
    const first = err instanceof Error ? err.message.split("\n")[0] : String(err);
    process.stderr.write(`team-ctl ${command}: ${first}\n`);
    return 1;
  }
}

// 直接执行 dist/team-ctl.mjs（/team 文档与 README 的路径）时自执行；被薄启动器
// scripts/team-ctl.mjs import 时不重复执行（argv[1] 指向启动器，不是本模块）。
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.exitCode = await main(process.argv.slice(2));
}

function takeFlag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

/** teamId 推断：--team > 首个事件的 teamId > 目录名（提示带 --team）。 */
function resolveTeamId(teamDir: string, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const eventsFile = path.join(teamDir, "events.jsonl");
  if (fs.existsSync(eventsFile)) {
    const first = fs.readFileSync(eventsFile, "utf8").split("\n", 1)[0];
    if (first !== undefined && first.length > 0) {
      try {
        const parsed = JSON.parse(first) as { event?: { teamId?: string } };
        if (typeof parsed.event?.teamId === "string") return parsed.event.teamId;
      } catch {
        /* 首行不可解析 → 目录名兜底 */
      }
    }
  }
  const base = path.basename(teamDir);
  if (base.length === 0) throw new Error("无法推断 teamId：空目录名；请传 --team <id>");
  return base;
}

async function cmdState(rest: string[]): Promise<number> {
  const teamDir = rest[0];
  if (teamDir === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl state: 需要 <teamDir>\n");
    return 2;
  }
  const json = rest.includes("--json");
  const teamId = resolveTeamId(teamDir, takeFlag(rest, "--team"));
  const loaded = await load(teamDir, teamId);
  process.stdout.write(renderState({ teamId, loaded, json }, paintForStream(process.stdout)) + "\n");
  return 0;
}

async function cmdTail(rest: string[]): Promise<number> {
  const teamDir = rest[0];
  if (teamDir === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl tail: 需要 <teamDir>\n");
    return 2;
  }
  const nFlag = takeFlag(rest, "--n");
  const fromLines = nFlag !== undefined ? Number(nFlag) : undefined;
  if (fromLines !== undefined && (!Number.isInteger(fromLines) || fromLines < 0)) {
    process.stderr.write("team-ctl tail: --n 必须是非负整数\n");
    return 2;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await followEvents(eventsFileOf(teamDir), {
    fromLines,
    paint: paintForStream(process.stdout),
    signal: controller.signal,
    onLine: (formatted) => process.stdout.write(formatted + "\n"),
  });
  return 0;
}

function cmdInject(rest: string[]): number {
  const teamDir = rest[0];
  if (teamDir === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl inject-event: 需要 <teamDir>\n");
    return 2;
  }
  const sample = takeFlag(rest, "--sample");
  let line: string | undefined = rest[1];
  if (sample === "invalid-member") {
    const teamId = resolveTeamId(teamDir, takeFlag(rest, "--team"));
    line = invalidMemberSample(teamId);
  } else if (sample !== undefined) {
    process.stderr.write(`team-ctl inject-event: 未知样例 ${JSON.stringify(sample)}（可用：invalid-member）\n`);
    return 2;
  }
  if (line === undefined || line.startsWith("--")) {
    process.stderr.write("team-ctl inject-event: 需要 <json-line>（或 --sample invalid-member）\n");
    return 2;
  }
  const result = injectEvent(teamDir, line);
  process.stdout.write(
    [
      `test-only：已绕过 journal 直写（无不变量/无锁/无 fsync）`,
      `seq=${result.seq} file=${result.file}`,
      result.line,
      JSON.stringify({ tool: "team-ctl", action: "inject-event", teamDir, seq: result.seq, ok: true }),
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdCall(rest: string[]): Promise<number> {
  const [teamDir, method, paramsJson] = rest;
  if (teamDir === undefined || method === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl call: 需要 <teamDir> <method> [params-json]\n");
    return 2;
  }
  const outcome = await callTeam(teamDir, method, paramsJson);
  process.stdout.write(outcome.output + "\n");
  process.stderr.write(outcome.audit + "\n");
  return outcome.ok ? 0 : 1;
}

/** team-ctl transcript <teamDir> <member>（T5.7 CLI 对等；面板 detail 同一合成函数）。 */
async function cmdTranscript(rest: string[]): Promise<number> {
  const teamDir = rest[0];
  const member = rest[1];
  if (teamDir === undefined || member === undefined || teamDir.startsWith("--") || member.startsWith("--")) {
    process.stderr.write("team-ctl transcript: 需要 <teamDir> <member>\n");
    return 2;
  }
  const teamId = resolveTeamId(teamDir, takeFlag(rest, "--team"));
  const loaded = await load(teamDir, teamId);
  const cursorFlag = takeFlag(rest, "--cursor");
  const limitFlag = takeFlag(rest, "--limit");
  const cursor = cursorFlag !== undefined ? Number(cursorFlag) : undefined;
  const limit = limitFlag !== undefined ? Number(limitFlag) : undefined;
  if (cursor !== undefined && !Number.isSafeInteger(cursor)) {
    process.stderr.write("team-ctl transcript: --cursor 必须是安全整数\n");
    return 2;
  }
  if (limit !== undefined && !Number.isSafeInteger(limit)) {
    process.stderr.write("team-ctl transcript: --limit 必须是安全整数\n");
    return 2;
  }
  const modeFlag = takeFlag(rest, "--mode");
  if (modeFlag !== undefined && modeFlag !== "summary" && modeFlag !== "full") {
    process.stderr.write("team-ctl transcript: --mode 仅支持 summary|full\n");
    return 2;
  }
  const out = renderTranscript({
    teamDir,
    teamId,
    loaded,
    member,
    json: rest.includes("--json"),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(modeFlag !== undefined ? { mode: modeFlag } : {}),
  });
  process.stdout.write(out + "\n");
  return 0;
}

/** team-ctl widget <teamDir>（T5.3 CLI 降级链：::visualize 片段 / standalone 静态页）。 */
async function cmdWidget(rest: string[]): Promise<number> {
  const teamDir = rest[0];
  if (teamDir === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl widget: 需要 <teamDir>\n");
    return 2;
  }
  const teamId = resolveTeamId(teamDir, takeFlag(rest, "--team"));
  const loaded = await load(teamDir, teamId);
  const theme = takeFlag(rest, "--theme");
  if (theme !== undefined && theme !== "light" && theme !== "dark") {
    process.stderr.write("team-ctl widget: --theme 仅支持 light|dark\n");
    return 2;
  }
  const langFlag = takeFlag(rest, "--lang");
  if (langFlag !== undefined && langFlag !== "zh" && langFlag !== "en") {
    process.stderr.write("team-ctl widget: --lang 仅支持 zh|en\n");
    return 2;
  }
  const result = renderWidget({
    teamDir,
    teamId,
    loaded,
    theme: theme ?? "light",
    lang: langFlag ?? "zh",
    standalone: rest.includes("--standalone"),
    ...(takeFlag(rest, "--out") !== undefined ? { out: takeFlag(rest, "--out") } : {}),
  });
  if (result.out !== undefined) {
    process.stdout.write(`${result.out}\n`);
  } else {
    process.stdout.write(result.html + "\n");
  }
  return 0;
}

/** team-ctl sidebar-audit（stage-6 存量迁移；默认 dry-run）。 */
function cmdSidebarAudit(rest: string[]): number {
  const teamDir = rest[0];
  if (teamDir === undefined || teamDir.startsWith("--")) {
    process.stderr.write("team-ctl sidebar-audit: 需要 <teamDir>\n");
    return 2;
  }
  const result = auditSidebar({
    teamDir,
    dryRun: !rest.includes("--apply"),
    ...(takeFlag(rest, "--tasks-index") !== undefined ? { tasksIndexPath: takeFlag(rest, "--tasks-index")! } : {}),
  });
  process.stdout.write(
    rest.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${renderSidebarAudit(result)}\n`,
  );
  return 0;
}

/** team-ctl open-panel（T5.5 伴生面板入口；--no-open 只打印 URL）。 */
async function cmdOpenPanel(rest: string[]): Promise<number> {
  const result = await openPanel({ noOpen: rest.includes("--no-open") });
  process.stdout.write(result.message + "\n");
  return result.ok ? 0 : 1;
}
