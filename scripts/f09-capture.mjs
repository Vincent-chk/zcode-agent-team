#!/usr/bin/env node
// F09/F10 取证驱动：跑一次真实 CLI 无头会话（zcode -p --json），会话结束后立即把
// rollout transcript 快照到证据目录（rollout 文件是瞬态的，会话结束后很快轮转消失）。
// 用法：node scripts/f09-capture.mjs <promptFile> <outPrefix> [extra zcode args...]
// 输出：<outPrefix>-result.json（--json 顶层）、<outPrefix>-transcript.jsonl（rollout 快照）、
//       <outPrefix>-f10.json（team/* 泄漏检索计数）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const ROLLOUT = path.join(os.homedir(), ".zcode", "cli", "rollout");

const [, , promptFile, outPrefix, ...extraArgs] = process.argv;
if (promptFile === undefined || outPrefix === undefined) {
  console.error("用法: node scripts/f09-capture.mjs <promptFile> <outPrefix> [extra zcode args...]");
  process.exit(2);
}
const prompt = fs.readFileSync(promptFile, "utf8");
const outDir = path.dirname(path.resolve(outPrefix));
fs.mkdirSync(outDir, { recursive: true });

const args = [ZCODE, "-p", prompt, "--json", "--mode", "yolo", ...extraArgs];
const child = execFile(process.execPath, args, { maxBuffer: 64 * 1024 * 1024 }, () => {});
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => (stdout += d));
child.stderr.resume();
child.on("exit", (code) => {
  fs.writeFileSync(`${outPrefix}-result.json`, stdout);
  let sessionId;
  try {
    sessionId = JSON.parse(stdout).sessionId;
  } catch (err) {
    console.error("无法解析 --json 输出 sessionId:", String(err));
    process.exit(code ?? 1);
  }
  // 立即快照 rollout transcript（瞬态；先于轮转）
  const src = path.join(ROLLOUT, `model-io-${sessionId}.jsonl`);
  let captured = false;
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, `${outPrefix}-transcript.jsonl`);
    captured = true;
  }
  // F10 泄漏检索（对快照计数）
  const leakPatterns = [
    '"team/member"',
    '"team/task"',
    '"team/message/queued"',
    '"team/message"',
    '"team/message/delivered"',
    "TeamMemberSnapshot",
    "nextTaskNumber",
    "events.jsonl",
  ];
  let transcriptText = "";
  if (captured) transcriptText = fs.readFileSync(`${outPrefix}-transcript.jsonl`, "utf8");
  const counts = {};
  for (const p of leakPatterns) {
    counts[p] = transcriptText.split(p).length - 1;
  }
  const approvedException = {
    hookPolicyText: transcriptText.split("Agent Teams is available in this session").length - 1,
    hookContextForm: transcriptText.split("SessionStart hook additional context").length - 1,
  };
  const f10 = { sessionId, captured, exitCode: code ?? 0, leakCounts: counts, approvedException };
  fs.writeFileSync(`${outPrefix}-f10.json`, JSON.stringify(f10, null, 2));
  console.log(JSON.stringify({ sessionId, exitCode: code ?? 0, captured, f10 }, null, 2));
  process.exit(0);
});
