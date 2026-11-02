// U-O1 真实盲测会话验收（stage-6.5 验收标准 B；〔issue #9 三档化 D28，2026-11-02〕重写为 auto 默认链口径）：
// 全新 zcode -p 真会话 + 单条自然目标 prompt（零插件触发词）+ **不设任何 TEAM_* env**
// （走生产 userConfig 默认链：leadMode=**auto**）→ 判定：
//   ① prompt 洁净（含 db 落账复核）② 会话完成有实质回复
//   ③ 注入面无任何模式段（db 会话用户侧消息无 "Lead operating mode"——auto·未建队语义）
//   ④ runtime-config 生产链落 auto ⑤ 按需行为登记（spawn 计数不设硬门——auto 允许模型对
//      高价值目标自行建队；激进编排硬判定已迁移至 S7/e2e2 的 always 显式注入旅程）
//   ⑥ 无 TEAM_* 未恢复错误。证据束归档。
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
const verdict = {}; // 逐项判定（归档用）
const evidence = { ws, dbPath };

// 任务设计沿用原复杂目标（两个互不依赖模块 + 测试 + README + 隐蔽要求 // audit-ok）：
// auto 档下无论模型选择单 agent 直做还是按需建队，判定 ③④⑥ 都必须成立。
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

/** 会话的用户侧全部文本（判注入面：hook additionalContext 以用户侧消息落 db，D10 口径）。 */
function userTexts(sessionId) {
  return queryDb(
    dbPath,
    `SELECT json_extract(p.data,'$.text') AS t FROM message m JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ? AND json_extract(m.data,'$.role')='user'
       AND json_extract(p.data,'$.type')='text'
     ORDER BY m.sequence, p.sequence`,
    [sessionId],
  ).map((row) => String(row.t ?? "")).filter((t) => t.length > 0);
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

const bundleDir = path.join(cfg.out, "..", "stage-6.5-lead-orchestrator", "evidence", "U-O1");
fs.mkdirSync(bundleDir, { recursive: true });

try {
  // ── 判定 1：prompt 洁净（原始 prompt 全文零插件触发词）
  const dirty = FORBIDDEN.filter((w) => PROMPT.toLowerCase().includes(w.toLowerCase()));
  verdict["1-prompt-clean"] = { pass: dirty.length === 0, dirty };
  checks.check("1 prompt 洁净（零插件触发词）", dirty.length === 0, { dirty });

  // ── 旅程：生产默认链（无 TEAM_* env；插件 userConfig 默认 leadMode=auto）
  const env = { ...process.env };
  delete env.TEAM_LEAD_MODE;
  const journey = await runZcode(cfg, { prompt: PROMPT, cwd: ws, timeoutMs: 1_800_000, env });
  const leadId = journey.parsed?.sessionId;
  const answer = String(journey.parsed?.response ?? "");
  evidence.leadId = leadId;
  evidence.journeyMs = journey.ms;
  checks.check("2 真会话完成单条目标回合（有实质回复）", typeof leadId === "string" && leadId.length > 0 && answer.trim().length > 0, {
    ms: journey.ms,
    code: journey.code,
    stderr: journey.stderr.slice(-300),
  });
  if (typeof leadId !== "string" || leadId.length === 0) throw new Error("no leadId");

  const dbPrompt = userTexts(leadId).find((t) => t.includes("string-util")) ?? "";
  const dbDirty = FORBIDDEN.filter((w) => dbPrompt.toLowerCase().includes(w.toLowerCase()));
  verdict["1-prompt-clean"].dbPromptHead = dbPrompt.slice(0, 120);
  checks.check("1b db 落账的原始 prompt 同样洁净", dbDirty.length === 0 && dbPrompt.length > 0, { dbDirty, len: dbPrompt.length });

  // ── 定位数据根（判定 3/4 共用，先解析）
  const root = (await waitFor(() => findTeamRoot(leadId), { timeoutMs: 60_000, label: "team data root" })).value;
  evidence.dataRoot = root;

  // ── 判定 3：注入面无任何模式段。〔D10〕注入文本不落 transcript —— 取证改两路：
  //   3a. hooks.jsonl 有该 SID 的 sessionstart 行（hook 真实执行）；
  //   3b. 以同 bundle/同数据根/同 env（无 TEAM_LEAD_MODE）复跑 runtime/team-hooks.mjs，读其 stdout
  //       注入断言无 'Lead operating mode'（auto·未建队语义的确定性复算）。
  const hooksLog = readJsonl(path.join(root, "logs", "hooks.jsonl"));
  const hookRan = hooksLog.some((l) => l.event === "sessionstart" && (l.input_session_id === leadId || l.env_session_id === leadId));
  const probeId = `sess_u01_probe_${Date.now()}`;
  // 净化 TEAM_*：本进程可能身处 Lead/teammate 会话，继承变量会改判角色/注入来源。
  const replayEnv = { ...process.env, TEAM_PLUGIN_DATA: root, ZCODE_SESSION_ID: probeId };
  for (const key of Object.keys(replayEnv)) if (key.startsWith("TEAM_") && key !== "TEAM_PLUGIN_DATA") delete replayEnv[key];
  const hookReplay = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(PROJ, "runtime", "team-hooks.mjs")],
      {
        maxBuffer: 8 * 1024 * 1024,
        env: replayEnv,
      },
      (err, stdout) => resolve({ err, stdout: String(stdout) }),
    );
    child.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: probeId, source: "startup", cwd: ws }));
    child.stdin.end();
  });
  const injected = hookReplay.stdout;
  const modeSectionHits = injected.includes("Lead operating mode");
  verdict["3-no-mode-section"] = { pass: hookRan && !modeSectionHits, hookRan, modeSectionHits, injectedHead: injected.slice(0, 120) };
  checks.check(
    "3 注入面无模式段（hook 已执行 + 复跑产物注入无 'Lead operating mode'）",
    hookRan && !modeSectionHits && injected.includes("Agent Teams is available in this session"),
    { hookRan, modeSectionHits, injectedChars: injected.length },
  );

  // ── 判定 3c〔issue #5 D29/D30〕无误报面：headless 默认第三方模型的真会话不得注入单 agent 兜底
  //   提示（lead state 无 soloNotifiedAt 锚），复跑注入亦无 'Teammates unavailable'。
  //   防假通过：state 文件必须存在且形状合法（否则「读不到」也被当成「无锚」）；复跑必须正常退出
  //   且策略正文在（崩溃/坏产物不能算「无兜底提示」）。
  const leadStateFile = path.join(root, "teams", leadId, "lead", "state.json");
  const leadStateJson = fs.existsSync(leadStateFile) ? JSON.parse(fs.readFileSync(leadStateFile, "utf8")) : undefined;
  const stateShapeOk = typeof leadStateJson?.active === "boolean" && typeof leadStateJson?.updatedAt === "string";
  const replayOk = hookReplay.err === undefined && injected.includes("Agent Teams is available in this session");
  const soloHits = injected.includes("Teammates unavailable");
  verdict["3c-no-solo-false-positive"] = {
    pass: stateShapeOk && leadStateJson?.soloNotifiedAt === undefined && replayOk && !soloHits,
    stateShapeOk,
    soloNotifiedAt: leadStateJson?.soloNotifiedAt ?? null,
    replayOk,
    soloHits,
  };
  checks.check(
    "3c 第三方模型真会话无单 agent 兜底误报（state 形状合法且无 soloNotifiedAt + 复跑正常退出且注入无 'Teammates unavailable'）",
    stateShapeOk && leadStateJson?.soloNotifiedAt === undefined && replayOk && !soloHits,
    { stateShapeOk, soloNotifiedAt: leadStateJson?.soloNotifiedAt ?? null, replayOk, soloHits },
  );

  // ── 判定 4：runtime-config 生产链落 auto（daemon 落盘）
  const rc = JSON.parse(fs.readFileSync(path.join(root, "meta", "runtime-config.json"), "utf8"));
  evidence.runtimeConfig = rc;
  verdict["4-default-auto"] = { pass: rc.leadMode === "auto", leadMode: rc.leadMode };
  checks.check("4 生产默认链生效（runtime-config.leadMode=auto）", rc.leadMode === "auto", { leadMode: rc.leadMode });

  // ── 判定 5：按需行为登记（不设硬门：auto 下模型可自行决定是否建队；登记 spawn 数与交付物）
  const metaLog = readJsonl(path.join(root, "logs", "meta-log.jsonl"));
  const spawnCalls = metaLog.filter((l) => l.tool === "spawn_teammate" && l.params_meta?.session_id === leadId);
  const artifactFiles = ["string-util.js", "math-util.js", "string-util.test.js", "math-util.test.js"];
  const delivered = artifactFiles.filter((f) => fs.existsSync(path.join(ws, f)));
  verdict["5-on-demand-register"] = { spawns: spawnCalls.length, delivered: delivered.length, pass: true };
  checks.check("5 按需行为登记（spawn 计数与交付物，不判失败）", true, {
    spawns: spawnCalls.length,
    delivered: `${delivered.length}/${artifactFiles.length}`,
  });

  // ── 判定 6：无 TEAM_* 未恢复错误（Lead + 成员会话工具结果扫描）
  const teamDir = path.join(root, "teams", leadId);
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
  verdict["6-no-team-errors"] = { pass: teamErrorHits.length === 0, teamErrorHits };
  checks.check("6 无 TEAM_* 未恢复错误（Lead+成员工具结果扫描）", teamErrorHits.length === 0, { teamErrorHits });

  // ── 证据束归档
  fs.writeFileSync(path.join(bundleDir, "prompt.txt"), PROMPT);
  fs.writeFileSync(path.join(bundleDir, "answer.txt"), answer);
  const rcFile = path.join(root, "meta", "runtime-config.json");
  if (fs.existsSync(rcFile)) fs.copyFileSync(rcFile, path.join(bundleDir, "runtime-config.json"));
  const relevantMeta = metaLog.filter((l) => l.params_meta?.session_id === leadId);
  fs.writeFileSync(path.join(bundleDir, "meta-log-filtered.jsonl"), relevantMeta.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(bundleDir, "verdict.json"), JSON.stringify({ verdict, evidence, at: new Date().toISOString() }, null, 2));
  evidence.bundleDir = bundleDir;
} catch (err) {
  checks.check("U-O1 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ verdict, evidence, env: { ws, dbPath } });
  const file = writeResult(cfg.out, "U-O1", result);
  process.stdout.write(`U-O1 result → ${file}\nBundle → ${bundleDir}\n`);
  if (!result.pass) process.exitCode = 1;
}
