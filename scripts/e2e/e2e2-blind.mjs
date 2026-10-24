// 独立真实盲测 E2E 第二轮（2026-10-24，用户指定）：全新会话 + 全新任务域（date/text 工具库）
// + prompt 零插件词 + 生产默认链。在 U-O1 判定细则之上加验：
// ① R1 修复——reopen 若发生，findings 必须持久化进任务描述（修复前会被丢弃）；
// ② 会话隔离——成员会话行不进任务栏（tasks-index absent）；
// ③ 验收记录——completed 后 description 再变化（edit 追加验收 verdict）；
// ④ 事件重放一致性（team-ctl state 无 failure）；⑤ runtime-config 生产链 leadMode=orchestrator。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  Checks, PROJ, loadConfig, queryDb, readEvents, readJsonl, realDbPath,
  runZcode, waitFor, writeResult,
} from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-e2e2-ws-"));
const dbPath = realDbPath();
const checks = new Checks("E2E2");
const verdict = {};
const evidence = { ws, dbPath };

const PROMPT = `请在本目录交付一个小型工具库，包含两个互不依赖的模块和一份总览：
- 模块A date-util.js：导出 formatDate(d)（输出 YYYY-MM-DD）与 daysBetween(a, b)（两日期自然日差值），配测试 date-util.test.js（node:test，node --test 可运行）。
- 模块B text-util.js：导出 wordCount(s) 与 slugify(s)，配测试 text-util.test.js（同上）。
- README.md：每个模块两行说明（用途、导出函数清单）。
交付硬性要求：1) node --test 运行两个测试文件全绿；2) 每个测试文件至少 5 个用例；3) 每个源文件与测试文件的第一行都是注释 // audit-ok；4) 三个交付物齐全。
为每个工作包写明验收标准。完成后给我一份简短的交付报告。`;

const FORBIDDEN = [
  "agent team", "agent-team", "团队", "teammate", "spawn", "成员", "任务板", "编排",
  "多代理", "子代理", "spawn_teammate", "send_message", "list_agents", "interrupt_agent",
  "wait_agent", "team_task_create", "team_task_list", "team_task_get", "team_task_update",
];
const ARTIFACTS = ["date-util.js", "text-util.js", "date-util.test.js", "text-util.test.js"];
const ALL_FILES = [...ARTIFACTS, "README.md"];

function toolCalls(sessionId) {
  return queryDb(
    dbPath,
    `SELECT p.data AS raw FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(m.data,'$.role')='assistant'
       AND json_extract(p.data,'$.type') IN ('tool','tool_use')
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  ).map((row) => {
    try {
      const d = JSON.parse(row.raw);
      return { name: d.tool ?? d.name ?? null, input: d.state?.input ?? d.input ?? null };
    } catch { return { name: null, input: null }; }
  }).filter((c) => typeof c.name === "string");
}
function toolResultTexts(sessionId) {
  return queryDb(
    dbPath,
    `SELECT p.data AS raw FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(p.data,'$.type')='tool_result'
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  ).map((row) => { try { return JSON.stringify(JSON.parse(row.raw)); } catch { return String(row.raw); } });
}
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
function latestOf(events, type, pick) {
  const map = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type !== type) continue;
    map.set(pick(ev), ev);
  }
  return map;
}

const bundleDir = path.join(cfg.out, "..", "stage-6.5-lead-orchestrator", "evidence", "E2E2-blind");
fs.mkdirSync(bundleDir, { recursive: true });

try {
  // 判定 1：prompt 洁净
  const dirty = FORBIDDEN.filter((w) => PROMPT.toLowerCase().includes(w.toLowerCase()));
  verdict["1-prompt-clean"] = { pass: dirty.length === 0, dirty };
  checks.check("1 prompt 洁净（零插件触发词）", dirty.length === 0, { dirty });

  // 旅程：生产默认链（无 TEAM_* env）
  const env = { ...process.env };
  delete env.TEAM_LEAD_MODE;
  const journey = await runZcode(cfg, { prompt: PROMPT, cwd: ws, timeoutMs: 1_800_000, env });
  const leadId = journey.parsed?.sessionId;
  const answer = String(journey.parsed?.response ?? "");
  evidence.leadId = leadId;
  evidence.journeyMs = journey.ms;
  checks.check("Lead 真会话完成单条目标回合", typeof leadId === "string" && leadId.length > 0 && answer.trim().length > 0, {
    ms: journey.ms, code: journey.code, stderr: journey.stderr.slice(-300),
  });
  if (typeof leadId !== "string" || leadId.length === 0) throw new Error("no leadId");

  const root = (await waitFor(() => findTeamRoot(leadId), { timeoutMs: 60_000, label: "team root" })).value;
  const teamDir = path.join(root, "teams", leadId);
  evidence.dataRoot = root;
  evidence.teamDir = teamDir;

  // 生产链：runtime-config 应为 orchestrator（daemon 落盘）
  const rc = JSON.parse(fs.readFileSync(path.join(root, "meta", "runtime-config.json"), "utf8"));
  evidence.runtimeConfig = rc;
  checks.check("5 生产默认链生效（runtime-config.leadMode=orchestrator）", rc.leadMode === "orchestrator", { leadMode: rc.leadMode });

  // 等任务面收敛
  const settled = await waitFor(() => {
    const tasks = [...latestOf(readEvents(teamDir), "team/task", (e) => e.task.id).values()].map((e) => e.task);
    return tasks.length >= 2 && tasks.every((t) => t.status === "completed") ? tasks : null;
  }, { timeoutMs: 300_000, label: "all tasks completed" });
  const events = readEvents(teamDir);
  const tasks = [...latestOf(events, "team/task", (e) => e.task.id).values()].map((e) => e.task);
  const members = [...latestOf(events, "team/member", (e) => e.member.id).values()].map((e) => e.member);

  // 判定 2：自主建队
  const metaLog = readJsonl(path.join(root, "logs", "meta-log.jsonl"));
  const spawnCalls = metaLog.filter((l) => l.tool === "spawn_teammate" && l.params_meta?.session_id === leadId);
  verdict["2-autonomous-team"] = { pass: spawnCalls.length >= 2, spawns: spawnCalls.length };
  checks.check("2 自主建队 spawn_teammate ≥2", spawnCalls.length >= 2, {
    spawns: spawnCalls.length, members: members.map((m) => `${m.name}:${m.phase ?? "active"}`),
  });

  // 判定 3：任务编排（验收标准 + 隐蔽要求进任务面 + owner 落账）
  const withCriteria = tasks.filter((t) => /验收|acceptance/i.test(t.description));
  const descUnion = tasks.map((t) => t.description).join("\n");
  const hidden = descUnion.includes("audit-ok") && descUnion.includes("5");
  verdict["3-task-orchestration"] = { pass: tasks.length >= 2 && withCriteria.length >= 2 && hidden };
  checks.check("3 任务编排：≥2 任务 + 验收标准 + 隐蔽要求（audit-ok 与 ≥5 用例）进任务面", tasks.length >= 2 && withCriteria.length >= 2 && hidden, {
    tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, ownerId: t.ownerId ?? null, descHead: t.description.slice(0, 80) })),
  });
  const ownedIds = new Set(events.filter((l) => l.event?.type === "team/task" && typeof l.event.task.ownerId === "string").map((l) => l.event.task.id));
  const allOwned = tasks.length > 0 && tasks.every((t) => ownedIds.has(t.id));
  checks.check("3b 分配：每任务 owner 落账", allOwned, { owned: [...ownedIds] });

  // 判定 4：全链路闭环 + 无异常阻塞
  const completeIds = new Set(events.filter((l) => { const e = l.event; return e?.type === "team/task" && e.task.status === "completed"; }).map((l) => l.event.task.id));
  const queuedToLead = events.filter((l) => l.event?.type === "team/message/queued" && l.event.message.targetId === leadId);
  const deliveredToLead = events.filter((l) => l.event?.type === "team/message/delivered" && l.event.targetId === leadId);
  const stuck = members.filter((m) => m.phase === "provisioning" || m.phase === "failed");
  // 成员会话定位 + 执行证据
  const memberSessionIds = [];
  const membersDir = path.join(teamDir, "members");
  for (const mid of fs.existsSync(membersDir) ? fs.readdirSync(membersDir) : []) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(membersDir, mid, "origin.json"), "utf8"));
      if (typeof o.sessionId === "string") memberSessionIds.push(o.sessionId);
    } catch { /* skip */ }
  }
  const memberEvidence = {};
  for (const sid of memberSessionIds) {
    const calls = toolCalls(sid);
    memberEvidence[sid] = {
      writeEdit: calls.filter((c) => (c.name === "Write" || c.name === "Edit") && ARTIFACTS.some((f) => String(c.input?.file_path ?? "").endsWith(f))).length,
      total: calls.length,
    };
  }
  const leadTools = toolCalls(leadId);
  const leadBash = leadTools.filter((c) => c.name === "Bash");
  const leadRanTests = leadBash.some((c) => /--test|npm\s+test|vitest/.test(String(c.input?.command ?? "")));
  const leadReadSources =
    leadTools.filter((c) => c.name === "Read" && ARTIFACTS.some((f) => String(c.input?.file_path ?? "").endsWith(f))).length > 0 ||
    leadBash.some((c) => /head\s+-n\s+1|grep.*audit-ok/.test(String(c.input?.command ?? "")));
  const teamErrorHits = [];
  for (const sid of [leadId, ...memberSessionIds]) {
    for (const text of toolResultTexts(sid)) {
      const m = text.match(/TEAM_[A-Z_]+/g);
      if (m) teamErrorHits.push({ sid, codes: [...new Set(m)] });
    }
  }
  const chain = {
    distributed: allOwned,
    executed: Object.values(memberEvidence).some((e) => e.writeEdit > 0),
    returned: completeIds.size >= 2,
    verified: leadRanTests || leadReadSources,
    completedFinal: settled.value.every((t) => t.status === "completed"),
  };
  const withinBudget = journey.ms <= 30 * 60_000;
  const noAnomaly = queuedToLead.length === deliveredToLead.length && stuck.length === 0 && teamErrorHits.length === 0 && withinBudget;
  verdict["4-chain-no-blocking"] = { pass: Object.values(chain).every(Boolean) && noAnomaly, chain, teamErrorHits };
  checks.check("4 全链路闭环（分发→执行→返回→验收→标记完成）", Object.values(chain).every(Boolean), { chain, memberEvidence });
  checks.check("4b 无异常阻塞（零 TEAM_* 错误/pending 清零/无滞留/≤30min）", noAnomaly, {
    pendingCleared: queuedToLead.length === deliveredToLead.length, stuck: stuck.length,
    minutes: Math.round(journey.ms / 60000), teamErrorHits, queuedToLead: queuedToLead.length,
  });

  // 判定 5：Lead 不亲自实现
  const leadHandsOn = leadTools.filter((c) => (c.name === "Write" || c.name === "Edit") && ARTIFACTS.some((f) => String(c.input?.file_path ?? "").endsWith(f)));
  checks.check("5b Lead 不亲自实现（源/测试文件 Write/Edit=0）", leadHandsOn.length === 0, { leadHandsOn: leadHandsOn.length });

  // 判定 6：验收环 + 独立复跑（含 ≥5 用例核验）
  const missing = ALL_FILES.filter((f) => !fs.existsSync(path.join(ws, f)));
  const okHeaders = ARTIFACTS.filter((f) => (fs.readFileSync(path.join(ws, f), "utf8").split("\n")[0] ?? "").includes("// audit-ok"));
  const caseCounts = {};
  for (const f of ["date-util.test.js", "text-util.test.js"]) {
    const p = path.join(ws, f);
    if (fs.existsSync(p)) caseCounts[f] = (fs.readFileSync(p, "utf8").match(/\b(?:it|test)\s*\(/g) ?? []).length;
  }
  const casesOk = Object.values(caseCounts).every((n) => n >= 5) && Object.keys(caseCounts).length === 2;
  const testRun = await new Promise((resolve) => {
    execFile(process.execPath, ["--test", "date-util.test.js", "text-util.test.js"], { cwd: ws, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, tail: String(stdout).slice(-400), stderr: String(stderr).slice(-200) }));
  });
  const productOk = missing.length === 0 && okHeaders.length === ARTIFACTS.length && testRun.ok && casesOk;
  verdict["6-acceptance-correct"] = { pass: chain.verified && productOk, leadRanTests, leadReadSources, caseCounts };
  checks.check("6 验收环在案且判定正确（独立复跑全绿 + audit-ok 4/4 + 每测试文件 ≥5 用例）", chain.verified && productOk, {
    leadRanTests, leadReadSources, missing, okHeaders: `${okHeaders.length}/${ARTIFACTS.length}`, caseCounts, testOk: testRun.ok,
  });

  // 判定 7【新】：R1 修复实证——reopen 若发生，findings 持久化（修复前 description 会被丢弃=与完成时相同）
  const perTaskEvents = new Map();
  for (const line of events) {
    const e = line.event;
    if (e?.type !== "team/task") continue;
    const arr = perTaskEvents.get(e.task.id) ?? [];
    arr.push(e.task);
    perTaskEvents.set(e.task.id, arr);
  }
  const reopenFindings = [];
  for (const [id, arr] of perTaskEvents) {
    for (let i = 1; i < arr.length; i += 1) {
      const prev = arr[i - 1];
      const curr = arr[i];
      if (prev.status === "completed" && curr.status === "pending") {
        reopenFindings.push({ id, beforeDesc: prev.description, findingsDesc: curr.description, persisted: curr.description !== prev.description && curr.description.trim().length > 0 });
      }
    }
  }
  verdict["7-reopen-persistence"] = { occurred: reopenFindings.length > 0, allPersisted: reopenFindings.every((r) => r.persisted) };
  checks.check("7 reopen findings 持久化（R1 修复；未发生不判失败，发生则必须持久化）", reopenFindings.length === 0 || reopenFindings.every((r) => r.persisted), { reopenFindings: reopenFindings.map((r) => ({ id: r.id, persisted: r.persisted })) });

  // 判定 8【新】：验收记录（completed 后 description 再变化 = Lead edit 追加 verdict）
  const acceptanceRecords = [];
  for (const [id, arr] of perTaskEvents) {
    for (let i = 1; i < arr.length; i += 1) {
      const prev = arr[i - 1];
      const curr = arr[i];
      if (prev.status === "completed" && curr.status === "completed" && curr.description !== prev.description) {
        acceptanceRecords.push({ id, at: curr.description.slice(-200) });
      }
    }
  }
  checks.check("8 验收记录（completed 后 description 追加变化；记录性断言，非硬门）", true, { acceptanceRecords: acceptanceRecords.length, samples: acceptanceRecords.slice(0, 2) });

  // 判定 9【新】：会话隔离——成员会话行不进任务栏
  const isolationRows = [];
  let isolationOk = true;
  try {
    const db = new DatabaseSync(path.join(os.homedir(), ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
    try {
      for (const sid of memberSessionIds) {
        const row = db.prepare("select task_id, archived, deleted from tasks where task_id = ?").get(sid);
        const visible = row !== undefined && row.archived === 0 && row.deleted === 0;
        if (visible) isolationOk = false;
        isolationRows.push({ sid, row: row ?? null, visible });
      }
    } finally { db.close(); }
  } catch (err) { isolationOk = false; isolationRows.push({ error: String(err) }); }
  checks.check("9 会话隔离：成员会话不进任务栏（tasks-index 全 absent）", isolationOk, { isolationRows });

  // 判定 10【新】：事件重放一致性
  const stateRun = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(PROJ, "dist/team-ctl.mjs"), "state", teamDir, "--json", "--team", leadId], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
  let replayed = null;
  try { replayed = JSON.parse(stateRun.stdout); } catch { replayed = null; }
  checks.check("10 事件重放一致（team-ctl state 无 failure）", stateRun.ok && replayed !== null && replayed.failure === undefined, {
    failure: replayed?.failure, seq: replayed?.seq,
  });

  // 判定 11：最终汇总准确
  const summaryOk = /README|测试|全绿|通过|模块/.test(answer) && productOk;
  checks.check("11 最终汇总准确（与独立复跑一致）", summaryOk, { answerHead: answer.slice(0, 260) });

  // 证据束归档
  fs.writeFileSync(path.join(bundleDir, "prompt.txt"), PROMPT);
  fs.writeFileSync(path.join(bundleDir, "answer.txt"), answer);
  fs.copyFileSync(path.join(teamDir, "events.jsonl"), path.join(bundleDir, "events.jsonl"));
  const relevantMeta = metaLog.filter((l) => l.params_meta?.session_id === leadId || (l.tool === "team_task_update" && tasks.some((t) => t.id === l.arguments?.task_id)));
  fs.writeFileSync(path.join(bundleDir, "meta-log-filtered.jsonl"), relevantMeta.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(bundleDir, "lead-tool-calls.json"), JSON.stringify({ leadId, calls: leadTools }, null, 2));
  fs.writeFileSync(path.join(bundleDir, "verdict.json"), JSON.stringify({ verdict, evidence, caseCounts, reopenFindings, acceptanceRecords }, null, 2));
  evidence.bundleDir = bundleDir;
} catch (err) {
  checks.check("E2E2 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ verdict, evidence, env: { ws, dbPath } });
  const file = writeResult(cfg.out, "E2E2", result);
  process.stdout.write(`E2E2 result → ${file}\nBundle → ${bundleDir}\n`);
  if (!result.pass) process.exitCode = 1;
}
