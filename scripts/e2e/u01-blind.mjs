// U-O1 真实盲测会话验收（stage-6.5 验收标准 B；核心阻断门）：
// 全新 zcode -p 真会话 + 单条自然目标 prompt（零插件触发词）+ **不设任何 TEAM_* env**
// （走生产 userConfig 默认链：leadMode=orchestrator）→ Lead 自主编排 → 证据束归档 + B.4 判定。
// 判定锚定证据账目（events / meta-log / db 工具调用序列），不依赖模型话术。
// 用法：node scripts/e2e/u01-blind.mjs [--out <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  Checks,
  PROJ,
  loadConfig,
  queryDb,
  readEvents,
  readJsonl,
  realDbPath,
  runZcode,
  waitFor,
  writeResult,
} from "./common.mjs";

const cfg = loadConfig();
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-u01-ws-"));
const dbPath = realDbPath();
const checks = new Checks("U-O1");
const verdict = {}; // B.4 逐项判定（归档用）
const evidence = { ws, dbPath };

// B.2 任务设计：两个互不依赖模块 + 测试 + README；可机器校验完成标准 + 隐蔽要求（// audit-ok）。
const PROMPT = `请在本目录交付一个小型 JS 工具库，包含两个互不依赖的模块和一份总览：
- 模块A string-util.js：导出 reverse(s) 与 isPalindrome(s)，配测试文件 string-util.test.js（node 原生 test runner，node --test 可运行）。
- 模块B math-util.js：导出 gcd(a,b) 与 lcm(a,b)，配测试文件 math-util.test.js（同上）。
- README.md：每个模块两行说明（用途、导出函数清单）。
交付硬性要求：1) node --test 运行两个测试文件全绿；2) 每个源文件与测试文件的第一行都是注释 // audit-ok；3) 三个交付物齐全。
为每个工作包写明验收标准。完成后给我一份简短的交付报告。`;

const FORBIDDEN = [
  "agent team", "agent-team", "团队", "teammate", "spawn", "成员", "任务板", "编排",
  "多代理", "子代理", "spawn_teammate", "send_message", "list_agents", "interrupt_agent",
  "wait_agent", "team_task_create", "team_task_list", "team_task_get", "team_task_update",
];

/** 会话的工具调用序列（真实 db：part.type="tool"，名称 $.tool，参数 $.state.input；兼容测试夹具 tool_use 形态）。 */
function toolCalls(sessionId) {
  return queryDb(
    dbPath,
    `SELECT p.data AS raw
     FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(m.data,'$.role')='assistant'
       AND json_extract(p.data,'$.type') IN ('tool','tool_use')
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  ).map((row) => {
    let name = null;
    let input = null;
    try {
      const d = JSON.parse(row.raw);
      name = d.tool ?? d.name ?? null;
      input = d.state?.input ?? d.input ?? null;
    } catch {
      /* 保留 null */
    }
    return { name, input };
  }).filter((c) => typeof c.name === "string");
}

/** 会话的工具结果文本（扫 TEAM_* 错误码用）。 */
function toolResultTexts(sessionId) {
  return queryDb(
    dbPath,
    `SELECT p.data AS raw FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(p.data,'$.type')='tool_result'
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  ).map((row) => {
    try {
      return JSON.stringify(JSON.parse(row.raw));
    } catch {
      return String(row.raw);
    }
  });
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

function latestTaskSnapshots(events) {
  const map = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type === "team/task") map.set(ev.task.id, ev.task);
  }
  return [...map.values()];
}
function latestMemberSnapshots(events) {
  const map = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type === "team/member") map.set(ev.member.id, ev.member);
  }
  return [...map.values()];
}

const bundleDir = path.join(cfg.out, "..", "stage-6.5-lead-orchestrator", "evidence", "U-O1");
fs.mkdirSync(bundleDir, { recursive: true });

try {
  // ── 【必须】判定 1：prompt 洁净（原始 prompt 全文零插件触发词）
  const dirty = FORBIDDEN.filter((w) => PROMPT.toLowerCase().includes(w.toLowerCase()));
  verdict["1-prompt-clean"] = { pass: dirty.length === 0, dirty };
  checks.check("B.4-1 prompt 洁净（零插件触发词）", dirty.length === 0, { dirty });

  // ── 旅程：生产默认链（无 TEAM_* env；插件 userConfig 默认 leadMode=orchestrator）
  const env = { ...process.env };
  delete env.TEAM_LEAD_MODE;
  const journey = await runZcode(cfg, { prompt: PROMPT, cwd: ws, timeoutMs: 1_800_000, env });
  const leadId = journey.parsed?.sessionId;
  const answer = String(journey.parsed?.response ?? "");
  evidence.leadId = leadId;
  evidence.journeyMs = journey.ms;
  checks.check("Lead 真会话完成单条目标回合", typeof leadId === "string" && leadId.length > 0 && answer.trim().length > 0, {
    ms: journey.ms,
    code: journey.code,
    stderr: journey.stderr.slice(-300),
  });
  if (typeof leadId !== "string" || leadId.length === 0) throw new Error("no leadId");
  const dbPrompt = (
    queryDb(
      dbPath,
      `SELECT json_extract(p.data,'$.text') AS t FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? AND json_extract(m.data,'$.role')='user'
         AND json_extract(m.data,'$.semantics.origin')='real_user' AND json_extract(p.data,'$.type')='text'
       ORDER BY m.sequence LIMIT 1`,
      [leadId],
    )[0]?.t ?? ""
  );
  const dbDirty = FORBIDDEN.filter((w) => dbPrompt.toLowerCase().includes(w.toLowerCase()));
  verdict["1-prompt-clean"].dbPromptHead = dbPrompt.slice(0, 120);
  checks.check("B.4-1b db 落账的原始 prompt 同样洁净", dbDirty.length === 0 && dbPrompt.length > 0, { dbDirty, len: dbPrompt.length });

  // ── 定位团队 + 等收敛
  const root = (await waitFor(() => findTeamRoot(leadId), { timeoutMs: 60_000, label: "team data root" })).value;
  const teamDir = path.join(root, "teams", leadId);
  evidence.dataRoot = root;
  evidence.teamDir = teamDir;
  const settled = await waitFor(
    () => {
      const tasks = latestTaskSnapshots(readEvents(teamDir));
      return tasks.length >= 2 && tasks.every((t) => t.status === "completed") ? tasks : null;
    },
    { timeoutMs: 300_000, label: "all tasks completed" },
  );
  const events = readEvents(teamDir);
  const tasks = latestTaskSnapshots(events);
  const members = latestMemberSnapshots(events);
  const leadTools = toolCalls(leadId);

  // ── 【必须】判定 2：自主建队
  const metaLog = readJsonl(path.join(root, "logs", "meta-log.jsonl"));
  const spawnCalls = metaLog.filter((l) => l.tool === "spawn_teammate" && l.params_meta?.session_id === leadId);
  verdict["2-autonomous-team"] = { pass: spawnCalls.length >= 2, spawns: spawnCalls.length, memberNames: members.map((m) => m.name) };
  checks.check("B.4-2 自主建队：spawn_teammate ≥2（meta-log，Lead 会话）", spawnCalls.length >= 2, {
    spawns: spawnCalls.length,
    members: members.map((m) => `${m.name}:${m.phase ?? "active"}`),
  });

  // ── 【必须】判定 3：任务编排（描述含验收标准；隐蔽要求被捕获进任务面）
  const withCriteria = tasks.filter((t) => /验收|acceptance/i.test(t.description));
  const descUnion = tasks.map((t) => t.description).join("\n");
  const hiddenCaptured = descUnion.includes("audit-ok");
  verdict["3-task-orchestration"] = {
    pass: tasks.length >= 2 && withCriteria.length >= 2 && hiddenCaptured,
    tasks: tasks.length,
    withCriteria: withCriteria.length,
    hiddenCaptured,
  };
  checks.check(
    "B.4-3 任务编排：≥2 任务、描述含验收标准、隐蔽要求（audit-ok）进任务面",
    tasks.length >= 2 && withCriteria.length >= 2 && hiddenCaptured,
    { tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, ownerId: t.ownerId ?? null, descHead: t.description.slice(0, 100) })) },
  );
  const ownedIds = new Set(events.filter((l) => l.event?.type === "team/task" && typeof l.event.task.ownerId === "string").map((l) => l.event.task.id));
  const allOwned = tasks.length > 0 && tasks.every((t) => ownedIds.has(t.id));
  checks.check("B.4-3b 分配：每个任务 owner 落账", allOwned, { owned: [...ownedIds] });

  // ── 【必须】判定 4：全链路闭环与无异常阻塞（五段链路 + 无 TEAM_* 未恢复错误/pending 清零/无滞留/无死等/≤30min）
  const completeEvents = events.filter((l) => {
    const ev = l.event;
    return ev?.type === "team/task" && tasks.some((t) => {
      // complete 事件 = 任务从非 completed → completed 的迁移（以事件序推断）
      return ev.task.id === t.id && ev.task.status === "completed";
    });
  });
  const deliveredToLead = events.filter((l) => l.event?.type === "team/message/delivered" && l.event.targetId === leadId);
  const queuedToLead = events.filter((l) => l.event?.type === "team/message/queued" && l.event.message.targetId === leadId);
  const pendingCleared = queuedToLead.length === deliveredToLead.length;
  const stuckMembers = members.filter((m) => m.phase === "provisioning" || m.phase === "failed");
  const deadWait = leadTools.filter((c) => c.name === "wait_agent" && (c.input?.timeout_ms ?? 0) > 3_600_000).length > 0;
  const withinBudget = journey.ms <= 30 * 60_000;
  // TEAM_* 错误扫描（Lead + 成员会话工具结果；可恢复 CAS 重试不计 —— 仅统计无后续成功同参调用的粗判：这里按“出现即登记、人工复核”口径输出）
  // 成员会话定位：members/<memberId>/origin.json 的 sessionId（真实形态；teamDir 无根级 origin.json）。
  const memberSessionIds = [];
  const membersDir = path.join(teamDir, "members");
  if (fs.existsSync(membersDir)) {
    for (const mid of fs.readdirSync(membersDir)) {
      const originFile = path.join(membersDir, mid, "origin.json");
      if (!fs.existsSync(originFile)) continue;
      try {
        const origin = JSON.parse(fs.readFileSync(originFile, "utf8"));
        if (typeof origin.sessionId === "string") memberSessionIds.push(origin.sessionId);
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  const teamErrorHits = [];
  for (const sid of [leadId, ...memberSessionIds]) {
    for (const text of toolResultTexts(sid)) {
      const m = text.match(/TEAM_[A-Z_]+/g);
      if (m) teamErrorHits.push({ sid, codes: [...new Set(m)] });
    }
  }
  const chain = {
    distributed: allOwned,
    executed: null, // 下方以成员工具调用证据填充
    // 返回通道口径：任务板 complete = 成员返回结果的权威账目（消息送达为辅助证据，不作硬门）
    returned: completeEvents.length >= 2,
    verified: null, // 下方以 Lead 复核动作填充
    completedFinal: settled.value.every((t) => t.status === "completed"),
  };
  // 成员执行：至少一名成员会话对工件有 Write/Edit
  const artifactFiles = ["string-util.js", "math-util.js", "string-util.test.js", "math-util.test.js"];
  const memberToolEvidence = {};
  for (const sid of memberSessionIds) {
    const calls = toolCalls(sid);
    memberToolEvidence[sid] = {
      writeEdit: calls.filter((c) => (c.name === "Write" || c.name === "Edit") && artifactFiles.some((f) => String(c.input?.file_path ?? "").endsWith(f))).length,
      total: calls.length,
    };
  }
  chain.executed = Object.values(memberToolEvidence).some((e) => e.writeEdit > 0);
  // Lead 验收：complete 之后 Lead 有复核动作（node --test / 读源文件）
  const leadBash = leadTools.filter((c) => c.name === "Bash");
  const leadRanTests = leadBash.some((c) => /--test|npm\s+test|vitest/.test(String(c.input?.command ?? "")));
  const leadReadSources =
    leadTools.filter((c) => c.name === "Read" && artifactFiles.some((f) => String(c.input?.file_path ?? "").endsWith(f))).length > 0 ||
    leadBash.some((c) => /head\s+-n\s+1|cat\s+.*util/.test(String(c.input?.command ?? "")));
  chain.verified = leadRanTests || leadReadSources;
  const chainOk = chain.distributed && chain.executed && chain.returned && chain.verified && chain.completedFinal;
  const noAnomaly = pendingCleared && stuckMembers.length === 0 && !deadWait && withinBudget && teamErrorHits.length === 0;
  verdict["4-chain-and-no-blocking"] = { pass: chainOk && noAnomaly, chain, pendingCleared, stuckMembers, deadWait, withinBudget, teamErrorHits, queuedToLead: queuedToLead.length, deliveredToLead: deliveredToLead.length };
  checks.check("B.4-4 全链路闭环（分发→执行→返回→验收→标记完成，五段有账）", chainOk, verdict["4-chain-and-no-blocking"].chain);
  checks.check(
    "B.4-4b 无调用异常或阻塞（无 TEAM_* 错误 / pending 清零 / 无滞留成员 / 无死等 / ≤30min）",
    noAnomaly,
    { pendingCleared, stuck: stuckMembers.length, deadWait, minutes: Math.round(journey.ms / 60000), teamErrorHits },
  );

  // ── 【必须】判定 5：Lead 不亲自实现（对 4 个源/测试文件的 Write/Edit = 0；README 豁免）
  const leadHandsOn = leadTools.filter(
    (c) => (c.name === "Write" || c.name === "Edit") && artifactFiles.some((f) => String(c.input?.file_path ?? "").endsWith(f)),
  );
  const leadReadmeTouches = leadTools.filter((c) => (c.name === "Write" || c.name === "Edit") && String(c.input?.file_path ?? "").endsWith("README.md"));
  verdict["5-lead-not-hands-on"] = { pass: leadHandsOn.length === 0, leadHandsOn: leadHandsOn.length, readmeTouches: leadReadmeTouches.length };
  checks.check("B.4-5 Lead 不亲自实现（源/测试文件 Write/Edit=0；README 豁免）", leadHandsOn.length === 0, {
    leadHandsOn: leadHandsOn.map((c) => c.name),
    readmeTouches: leadReadmeTouches.length,
    memberToolEvidence,
  });

  // ── 【必须】判定 6：验收环发生且判定正确（Lead 复核 + 执行者独立复跑全绿）
  const files = ["string-util.js", "math-util.js", "string-util.test.js", "math-util.test.js", "README.md"];
  const missing = files.filter((f) => !fs.existsSync(path.join(ws, f)));
  const okHeaders = artifactFiles.filter((f) => (fs.readFileSync(path.join(ws, f), "utf8").split("\n")[0] ?? "").includes("// audit-ok"));
  const testRun = await new Promise((resolve) => {
    execFile(process.execPath, ["--test", "string-util.test.js", "math-util.test.js"], { cwd: ws, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, tail: String(stdout).slice(-500), stderr: String(stderr).slice(-200) }),
    );
  });
  const productOk = missing.length === 0 && okHeaders.length === artifactFiles.length && testRun.ok;
  verdict["6-acceptance-loop-and-correct"] = { pass: chain.verified && productOk, leadRanTests, leadReadSources, missing, okHeaders: okHeaders.length, testOk: testRun.ok };
  checks.check("B.4-6 验收环发生（Lead 复核在案）且判定正确（独立复跑全绿）", chain.verified && productOk, {
    leadRanTests, leadReadSources, missing, okHeaders: `${okHeaders.length}/${artifactFiles.length}`, testOk: testRun.ok,
  });

  // ── 【加分非阻断】reopen 循环
  const statusSeq = new Map();
  for (const line of events) {
    const ev = line.event;
    if (ev?.type !== "team/task") continue;
    const seq = statusSeq.get(ev.task.id) ?? [];
    if (seq[seq.length - 1] !== ev.task.status) seq.push(ev.task.status);
    statusSeq.set(ev.task.id, seq);
  }
  const reopenIds = [...statusSeq.entries()].filter(([, seq]) => { const i = seq.lastIndexOf("completed"); return i >= 0 && seq.length > i + 1 && seq.includes("pending", i + 1); }).map(([id]) => id);
  checks.check("B.4-加分 reopen 循环（未发生不判失败）", true, { reopenIds });

  // ── 【必须】判定 7：最终汇总准确（答复提及产物；独立复跑与答复一致 → 无虚报）
  const summaryOk = /README|测试|全绿|通过|模块/.test(answer) && productOk;
  verdict["7-final-summary"] = { pass: summaryOk, answerHead: answer.slice(0, 200) };
  checks.check("B.4-7 最终汇总准确（提及产物且与独立复跑一致）", summaryOk, { answerHead: answer.slice(0, 300) });

  // ── 证据束归档（B.3 七件套）
  fs.writeFileSync(path.join(bundleDir, "prompt.txt"), PROMPT);
  fs.writeFileSync(path.join(bundleDir, "answer.txt"), answer);
  fs.copyFileSync(path.join(teamDir, "events.jsonl"), path.join(bundleDir, "events.jsonl"));
  const relevantMeta = metaLog.filter((l) => l.params_meta?.session_id === leadId || (l.tool === "team_task_update" && tasks.some((t) => t.id === l.arguments?.task_id)));
  fs.writeFileSync(path.join(bundleDir, "meta-log-filtered.jsonl"), relevantMeta.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const rc = path.join(root, "meta", "runtime-config.json");
  if (fs.existsSync(rc)) fs.copyFileSync(rc, path.join(bundleDir, "runtime-config.json"));
  fs.writeFileSync(path.join(bundleDir, "lead-tool-calls.json"), JSON.stringify({ leadId, calls: leadTools }, null, 2));
  fs.writeFileSync(path.join(bundleDir, "member-tool-evidence.json"), JSON.stringify({ memberSessionIds, memberToolEvidence }, null, 2));
  fs.writeFileSync(path.join(bundleDir, "verdict.json"), JSON.stringify({ verdict, evidence, at: new Date().toISOString() }, null, 2));
  // 成员 transcript 导出（team-ctl transcript）
  for (const m of members) {
    await new Promise((resolve) => {
      execFile(process.execPath, [path.join(PROJ, "dist", "team-ctl.mjs"), "transcript", teamDir, m.name], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, () => resolve(null));
    }).catch(() => null);
  }
  evidence.bundleDir = bundleDir;
} catch (err) {
  checks.check("U-O1 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ verdict, evidence, env: { ws, dbPath } });
  const file = writeResult(cfg.out, "U-O1", result);
  process.stdout.write(`U-O1 result → ${file}\nBundle → ${bundleDir}\n`);
  if (!result.pass) process.exitCode = 1;
}
