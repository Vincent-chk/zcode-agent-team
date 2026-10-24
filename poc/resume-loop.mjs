// H2/H13 resume-loop PoC：`zcode -p --resume` 连续续跑 + 并发锁行为
// 用法：
//   node poc/resume-loop.mjs run     —— 会话 L 三轮（暗号累积断言）+ 会话 M 两轮（串扰断言）
//   node poc/resume-loop.mjs h13     —— 双进程并发 resume 同一会话 L（锁行为 + 完整性）
//   node poc/resume-loop.mjs check   —— 只跑 db.sqlite 完整性检查（会话 id 从 env L_SESS/M_SESS）
// 输出写入 /tmp/resume-loop-out/*.json
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const WS = process.env.ZCODE_WS ?? "/tmp";
const OUT = "/tmp/resume-loop-out";
fs.mkdirSync(OUT, { recursive: true });

function secret(tag) {
  return `${tag}-${crypto.randomBytes(3).toString("hex")}`;
}

function runP(prompt, extraArgs, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", [ZCODE, "-p", prompt, ...extraArgs, "--json", "--mode", "yolo", "--cwd", WS], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      const rec = { label, code, ms: Date.now() - t0, parsed, stderr: err.slice(0, 2000), raw: out.slice(0, 400) };
      fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(rec, null, 2));
      resolve(rec);
    });
  });
}

const action = process.argv[2];

if (action === "run") {
  const s1 = secret("amber");
  const s2 = secret("birch");
  const sm = secret("cedar");
  console.log(`[secrets] L 轮1=${s1} L 轮2=${s2} M 轮1=${sm}`);

  const r1 = await runP(`请只回复以下暗号并记住它，后续轮次会考：${s1}`, [], "L1");
  console.log(`[L1] exit=${r1.code} sessionId=${r1.parsed?.sessionId} 有type字段=${"type" in (r1.parsed ?? {})} 顶层键=${r1.parsed ? Object.keys(r1.parsed).join(",") : "parse失败"}`);
  const L = r1.parsed?.sessionId;
  if (!L) { console.error("FAIL: L1 未解析出 sessionId"); process.exit(1); }

  const r2 = await runP(`请只回复以下第二个暗号并记住，连同第一个暗号：${s2}`, ["--resume", L], "L2");
  console.log(`[L2] exit=${r2.code} sessionId=${r2.parsed?.sessionId} 与L一致=${r2.parsed?.sessionId === L}`);

  const r3 = await runP("请按顺序原样列出：第一个暗号、第二个暗号。不要解释。", ["--resume", L], "L3");
  const resp3 = r3.parsed?.response ?? "";
  const ok3 = resp3.includes(s1) && resp3.includes(s2);
  console.log(`[L3] exit=${r3.code} 历史累积断言=${ok3 ? "PASS（两暗号都答出）" : "FAIL"} resp="${resp3.slice(0, 120)}"`);

  const m1 = await runP(`请只回复以下暗号并记住它：${sm}`, [], "M1");
  const M = m1.parsed?.sessionId;
  console.log(`[M1] exit=${m1.code} sessionId=${M} 与L不同=${M !== L}`);
  const m2 = await runP("请原样列出你被要求记住的暗号（只有一个）。不要编造其他暗号。", ["--resume", M], "M2");
  const respm = m2.parsed?.response ?? "";
  const okM = respm.includes(sm) && !respm.includes(s1) && !respm.includes(s2);
  console.log(`[M2] exit=${m2.code} 串扰断言=${okM ? "PASS（知道自己的、不含 L 的）" : "FAIL"} resp="${respm.slice(0, 120)}"`);

  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ L, M, s1, s2, sm, ok3, okM }, null, 2));
  console.log(`[summary] L=${L} M=${M} → ${OUT}/summary.json`);
} else if (action === "h13") {
  const sum = JSON.parse(fs.readFileSync(path.join(OUT, "summary.json"), "utf8"));
  const L = process.env.L_SESS ?? sum.L;
  console.log(`[H13] 并发 resume 同一会话 ${L}`);
  const pA = runP("把数字 41 加 1，只回复结果数字。", ["--resume", L], "H13-A");
  const pB = runP("把数字 41 加 2，只回复结果数字。", ["--resume", L], "H13-B");
  const [A, B] = await Promise.all([pA, pB]);
  for (const r of [A, B]) {
    console.log(`[${r.label}] exit=${r.code} sessionId=${r.parsed?.sessionId ?? "(无)"} resp="${(r.parsed?.response ?? r.stderr.slice(0, 150)).slice(0, 100)}"`);
  }
  console.log("[H13] 结论待 db.sqlite 完整性检查（运行 check）");
} else if (action === "check") {
  // db.sqlite 完整性：node:sqlite 只读
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(process.env.HOME, ".zcode/cli/db/db.sqlite"), { readOnly: true });
  const sum = JSON.parse(fs.readFileSync(path.join(OUT, "summary.json"), "utf8"));
  const ids = { L: process.env.L_SESS ?? sum.L, M: process.env.M_SESS ?? sum.M };
  for (const [k, id] of Object.entries(ids)) {
    if (!id) continue;
    const sess = db.prepare("SELECT id, task_type, title FROM session WHERE id = ?").get(id);
    const msgs = db.prepare("SELECT COUNT(*) n FROM message WHERE session_id = ?").get(id);
    const parts = db.prepare("SELECT json_extract(m.data,'$.role') role, COUNT(*) n FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = ? GROUP BY role").all(id);
    console.log(`[db:${k}] session=${JSON.stringify(sess)} messages=${msgs.n} parts_by_role=${JSON.stringify(parts)}`);
  }
  // 完整性键：L 的最后几条 user 消息是否完整（H13 两个 prompt 都在）、无空 part 残骸
  const lastUser = db.prepare(
    "SELECT m.id, substr(COALESCE(json_extract(p.data,'$.text'),''),1,80) t FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(m.data,'$.role') = 'user' ORDER BY m.time_created DESC LIMIT 4",
  ).all(ids.L);
  console.log("[db:L 最近 user parts]", JSON.stringify(lastUser));
  const quickCheck = db.prepare("PRAGMA quick_check").get();
  console.log("[db:quick_check]", JSON.stringify(quickCheck));
  db.close();
} else {
  console.log("用法: node poc/resume-loop.mjs run|h13|check");
}
