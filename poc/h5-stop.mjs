// H5：运行中轮次外部终止 → 会话仍可续（transcript 无半成品）
// ① -p 路径：起长任务进程，SIGTERM 中途 → db.sqlite 完整性 → --resume 续跑答暗号
// ② app-server 路径：session/send 长任务 → session/stop → 空闲后 session/send 复用
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const WS = process.env.ZCODE_WS ?? "/tmp";
const secret = "harbor-" + crypto.randomBytes(3).toString("hex");

function runP(prompt, extraArgs, label, { killAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", [ZCODE, "-p", prompt, ...extraArgs, "--json", "--mode", "yolo", "--cwd", WS], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (killAfterMs) {
      setTimeout(() => { killed = true; p.kill("SIGTERM"); }, killAfterMs);
    }
    p.on("exit", (code, signal) => {
      let parsed = null; try { parsed = JSON.parse(out); } catch {}
      resolve({ label, code, signal, killed, parsed, stderr: err.slice(0, 500) });
    });
  });
}

const db = new DatabaseSync(path.join(process.env.HOME, ".zcode/cli/db/db.sqlite"), { readOnly: true });
function sessionHealth(id) {
  const sess = db.prepare("SELECT id, task_type FROM session WHERE id=?").get(id);
  const msgs = db.prepare("SELECT COUNT(*) n FROM message WHERE session_id=?").get(id);
  // 半成品检测：text part 的 data JSON 可解析且非空
  const bad = db.prepare(
    `SELECT COUNT(*) n FROM part p JOIN message m ON p.message_id=m.id
     WHERE p.session_id=? AND json_extract(p.data,'$.type')='text'
       AND (length(COALESCE(json_extract(p.data,'$.text'),''))=0)`,
  ).get(id);
  return { exists: !!sess, messages: msgs.n, emptyTextParts: bad.n };
}

console.log(`[H5] 暗号=${secret}`);
// ① -p 路径
const r1 = await runP(`长任务：从 1 数到 300，每个数字单独一行输出（共 300 行，一行也不要省略），数完后另起一行原样输出暗号 ${secret}。`, [], "H5-long", { killAfterMs: 9000 });
console.log(`[H5①长任务] killed=${r1.killed} signal=${r1.signal} exit=${r1.code}（中途 SIGTERM）`);
const L = r1.parsed?.sessionId;
if (!L) { console.log("  sessionId 未解析（被杀早于输出）——从 db.sqlite 找最近会话兜底"); }
const sessId = L ?? db.prepare("SELECT id FROM session ORDER BY time_created DESC LIMIT 1").get().id;
console.log(`[H5①] 会话=${sessId} 健康度(杀后)=`, JSON.stringify(sessionHealth(sessId)));
const r2 = await runP("继续完成任务：如果你此前被中断，请从中断处继续数完，然后原样输出你被要求记住的暗号。只输出：最后的数字和暗号。", ["--resume", sessId], "H5-resume");
const resp = r2.parsed?.response ?? "";
console.log(`[H5①resume] exit=${r2.code} 含暗号=${resp.includes(secret)} 含最终数字(60)=${resp.includes("60")} resp="${resp.slice(0, 150)}"`);
console.log(`[H5①] 健康度(resume后)=`, JSON.stringify(sessionHealth(sessId)));
fs.writeFileSync("/tmp/h5-summary.json", JSON.stringify({ sessId, secret, resumeOk: resp.includes(secret) }, null, 2));
db.close();
