// S7 编排旅程剧本（stage-6.5 D26 / F-O8；真模型）：单条自然目标 prompt（零插件触发词）→
// Lead 在 orchestrator 注入下自主建队/建任务/分配/等待/汇总 —— **脚本全程零代调**（区别于 S1
// 的控制面手法），宿主自起 daemon；断言锚定 events.jsonl / meta-log.jsonl / 产物文件 / 最终投影。
// 运行前置：dist 已构建、插件已 dev-install、本机模型可用；TEAM_LEAD_MODE=orchestrator 显式注入
// （hook env 优先 → 确定性，不依赖 daemon 落盘时序）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Checks, loadConfig, readEvents, readJsonl, runZcode, waitFor, writeResult } from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s7-ws-"));
const checks = new Checks("S7");
const evidence = { ws, model: cfg.model };

// 旅程 prompt：自然语言、可并行（两个互不依赖模块）、可机器校验 + 一条隐蔽要求（// audit-ok）。
const PROMPT = `请在本目录交付一个小型 JS 工具库，包含两个互不依赖的模块和一份总览：
- 模块A string-util.js：导出 reverse(s) 与 isPalindrome(s)，配测试文件 string-util.test.js（node 原生 test runner，node --test 可运行）。
- 模块B math-util.js：导出 gcd(a,b) 与 lcm(a,b)，配测试文件 math-util.test.js（同上）。
- README.md：每个模块两行说明（用途、导出函数清单）。
交付硬性要求：1) node --test 运行两个测试文件全绿；2) 每个源文件与测试文件的第一行都是注释 // audit-ok；3) 三个交付物齐全。
为每个工作包写明验收标准。完成后给我一份简短的交付报告。`;

// B.2.2 同款禁词表（插件触发词 + 工具名）——prompt 自身洁净性由脚本先行核验。
const FORBIDDEN = [
  "agent team", "agent-team", "团队", "teammate", "spawn", "成员", "任务板", "编排",
  "多代理", "子代理", "spawn_teammate", "send_message", "list_agents", "interrupt_agent",
  "wait_agent", "team_task_create", "team_task_list", "team_task_get", "team_task_update",
];
checks.check(
  "prompt 洁净（零插件触发词/工具名）",
  !FORBIDDEN.some((w) => PROMPT.toLowerCase().includes(w.toLowerCase())),
  { prompt: PROMPT.slice(0, 200) },
);

/** 在所有 agent-team 数据根中定位 teams/<leadId>（真实插件数据根由宿主分配，不预设单根）。 */
function findTeamRoot(leadId) {
  const safe = String(leadId).replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0).toString(16));
  const candidates = [];
  const dataHome = path.join(os.homedir(), ".zcode", "cli", "plugins", "data");
  if (fs.existsSync(dataHome)) {
    for (const name of fs.readdirSync(dataHome)) {
      if (!name.startsWith("agent-team")) continue;
      const root = path.join(dataHome, name);
      if (fs.existsSync(path.join(root, "teams", safe))) candidates.push(root);
    }
  }
  const devRoot = path.join(os.homedir(), ".zcode", "agent-team-dev-data");
  if (fs.existsSync(path.join(devRoot, "teams", safe))) candidates.push(devRoot);
  return candidates.length > 0 ? candidates[0] : null;
}

function latestTaskSnapshots(events) {
  const map = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type === "team/task") map.set(ev.task.id, ev.task);
  }
  return [...map.values()];
}

try {
  // 1) 单条旅程：Lead 全程自驱（建队/任务/分配/等待/汇总），900s 预算。
  const journey = await runZcode(cfg, {
    prompt: PROMPT,
    cwd: ws,
    timeoutMs: 900_000,
    env: { TEAM_LEAD_MODE: "orchestrator" },
  });
  const leadId = journey.parsed?.sessionId;
  const answer = String(journey.parsed?.response ?? "");
  evidence.leadId = leadId;
  evidence.journeyMs = journey.ms;
  evidence.answer = answer.slice(0, 1200);
  checks.check(
    "Lead 真会话完成单条目标回合（有 sessionId 与最终答复）",
    typeof leadId === "string" && leadId.length > 0 && answer.trim().length > 0,
    { ms: journey.ms, code: journey.code, stderr: journey.stderr.slice(-300) },
  );
  if (typeof leadId !== "string" || leadId.length === 0) throw new Error("no leadId — journey failed");

  // 2) 定位团队目录（隐式团队：首条成员/任务事件后出现；Lead 未建队 = 不存在 → 失败即证据）
  const root = (await waitFor(() => findTeamRoot(leadId), { timeoutMs: 60_000, label: "team data root" })).value;
  const teamDir = path.join(root, "teams", leadId);
  evidence.dataRoot = root;
  evidence.teamDir = teamDir;
  // F-O1 链路证据：daemon 落盘的 runtime-config 应含 leadMode
  const runtimeConfigPath = path.join(root, "meta", "runtime-config.json");
  if (fs.existsSync(runtimeConfigPath)) {
    evidence.runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
  }

  // 3) 等待任务面收敛（所有任务终态 completed；teammate 回合可能晚于 Lead 答复落账）
  const settled = await waitFor(
    () => {
      const tasks = latestTaskSnapshots(readEvents(teamDir));
      return tasks.length >= 2 && tasks.every((t) => t.status === "completed") ? tasks : null;
    },
    { timeoutMs: 300_000, label: "all tasks completed" },
  );
  const events = readEvents(teamDir);
  const memberEvents = events.filter((l) => l.event?.type === "team/member");
  const memberNames = new Set(memberEvents.map((l) => l.event.member.name));
  checks.check("自主建队：≥2 名 teammate（事件证据）", memberNames.size >= 2, {
    members: [...memberNames],
    memberEvents: memberEvents.length,
  });

  const tasks = latestTaskSnapshots(events);
  const withCriteria = tasks.filter((t) => /验收|acceptance/i.test(t.description));
  checks.check("任务编排：≥2 个共享任务且描述含验收标准", tasks.length >= 2 && withCriteria.length >= 2, {
    tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, ownerId: t.ownerId ?? null, descHead: t.description.slice(0, 80) })),
  });

  // 分配：每个任务在事件流中出现过 ownerId（claim/reassign 指派落账）
  const ownedIds = new Set(
    events.filter((l) => l.event?.type === "team/task" && typeof l.event.task.ownerId === "string").map((l) => l.event.task.id),
  );
  checks.check(
    "任务分配：每个任务都有 owner 落账（事件流 ownerId）",
    tasks.length > 0 && tasks.every((t) => ownedIds.has(t.id)),
    { owned: [...ownedIds] },
  );
  checks.check("任务终态：全部 completed", settled.value.every((t) => t.status === "completed"), {
    statuses: tasks.map((t) => `${t.id}:${t.status}`),
  });

  // meta-log：工具调用账目（spawn ≥2；complete ≥2）。按 Lead 会话（params_meta.session_id）
  // 与本团队 task_id 过滤，避免与其它剧本/团队在同根 meta-log 上的窗口污染。
  const metaLogPath = path.join(root, "logs", "meta-log.jsonl");
  const metaLog = fs.existsSync(metaLogPath) ? readJsonl(metaLogPath) : [];
  const ourTaskIds = new Set(tasks.map((t) => t.id));
  const spawnCalls = metaLog.filter((l) => l.tool === "spawn_teammate" && l.params_meta?.session_id === leadId);
  const completeCalls = metaLog.filter(
    (l) => l.tool === "team_task_update" && l.arguments?.action === "complete" && ourTaskIds.has(l.arguments?.task_id),
  );
  checks.check("meta-log：spawn_teammate ≥2 次（Lead 自主调用账目）", spawnCalls.length >= 2, {
    spawnCalls: spawnCalls.length,
  });
  checks.check("meta-log：complete 落账 ≥2 次", completeCalls.length >= 2, { completeCalls: completeCalls.length });

  // reopen 循环（加分非阻断）：同任务 completed→pending 序列若发生则合法（pending 后必有再完成）
  const statusSeq = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type !== "team/task") continue;
    const seq = statusSeq.get(ev.task.id) ?? [];
    if (seq[seq.length - 1] !== ev.task.status) seq.push(ev.task.status);
    statusSeq.set(ev.task.id, seq);
  }
  const reopenIds = [...statusSeq.entries()]
    .filter(([, seq]) => { const i = seq.lastIndexOf("completed"); return i >= 0 && seq.length > i + 1 && seq.includes("pending", i + 1); })
    .map(([id]) => id);
  checks.check("reopen 循环（若发生则序列合法；未发生不判失败）", true, { reopenIds, seqs: Object.fromEntries(statusSeq) });

  // 4) 产物核验（交付硬性要求逐条：文件齐全 / audit-ok 首行 / node --test 全绿）
  const files = ["string-util.js", "math-util.js", "string-util.test.js", "math-util.test.js", "README.md"];
  const missing = files.filter((f) => !fs.existsSync(path.join(ws, f)));
  checks.check("交付物齐全（4 源/测试文件 + README）", missing.length === 0, { missing });
  const auditOk = files.filter((f) => f !== "README.md");
  const okHeaders = auditOk.filter((f) => {
    const first = fs.readFileSync(path.join(ws, f), "utf8").split("\n")[0] ?? "";
    return first.includes("// audit-ok");
  });
  checks.check("隐蔽要求：每个源/测试文件首行 // audit-ok", okHeaders.length === auditOk.length, {
    withHeader: okHeaders,
  });
  const testRun = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--test", "string-util.test.js", "math-util.test.js"],
      { cwd: ws, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, tail: String(stdout).slice(-600), stderr: String(stderr).slice(-300) }),
    );
  });
  checks.check("node --test 两套测试全绿（独立复跑）", testRun.ok, testRun);

  // 5) Lead 最终答复反映交付
  checks.check(
    "Lead 交付报告提及产物与测试",
    /README|测试|全绿|通过|模块/.test(answer),
    { answerHead: answer.slice(0, 200) },
  );

  evidence.taskBoard = tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status }));
  evidence.members = [...memberNames];
} catch (err) {
  checks.check("S7 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({
    evidence,
    env: { zcode: cfg.zcode, ws, model: cfg.model },
  });
  const file = writeResult(cfg.out, "S7", result);
  process.stdout.write(`S7 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
