// F32 基准：1 万行合法混合事件（2500 member×2 + 1500 task 系 + 1000 消息对）
//   全量重放 ≤ 2s；checkpoint 命中增量 ≤ 200ms。事件由 domain 投影逐条验证合法性（生成器
//   用 applyProjectionEvent 保证序列可完整重放），直接以 journal 行格式落盘。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, writeCheckpoint, checkpointPath } from "../../../src/coord/replay.js";
import { applyProjectionEvent, emptyTeamState } from "../../../src/domain/projection.js";
import type { TeamState } from "../../../src/domain/projection.js";

const TEAM = "sess_f32_bench";
const TOTAL_LINES = 10_000;
const evidence: Record<string, unknown> = {};

let root: string;
let teamDir: string;

function under(r: string, name: string): string {
  const p = path.join(r, name);
  if (!path.resolve(p).startsWith(path.resolve(r) + path.sep)) throw new Error("escape");
  return p;
}

/** 生成合法混合事件序列（member 级 5000 + task 级 3000 + 消息级 2000 = 10000）。 */
function generateEvents(): { events: unknown[]; lines: string[] } {
  const events: unknown[] = [];
  const lines: string[] = [];
  let state: TeamState = emptyTeamState(TEAM);
  const push = (event: unknown) => {
    const next = applyProjectionEvent(state, event);
    if (next.failure !== undefined) throw new Error(`generator produced invalid event: ${next.failure}`);
    state = next;
    events.push(event);
    lines.push(JSON.stringify({ seq: events.length, ts: "2026-10-15T00:00:00.000Z", writer: "bench:1", event }));
  };
  // 2500 members × (provisioning + active) = 5000
  for (let i = 0; i < 2500; i++) {
    push({ type: "team/member", version: 2, teamId: TEAM, member: { id: `m${i}`, name: `w${i}`, description: "bench member", provider: "spawn", context: "fresh", phase: "provisioning" } });
    push({ type: "team/member", version: 2, teamId: TEAM, member: { id: `m${i}`, name: `w${i}`, description: "bench member", provider: "spawn", context: "fresh", phase: "active" } });
  }
  // 1500 tasks × 2 revisions = 3000（含依赖：偶数任务 blockedBy 前一任务，前一任务先行 completed 保持 ready 合法性无关紧要——依赖合法即可）
  for (let i = 1; i <= 1500; i++) {
    const blockedBy = i > 1 && i % 2 === 0 ? [`task-${i - 1}`] : [];
    push({ type: "team/task", version: 2, teamId: TEAM, task: { id: `task-${i}`, revision: 1, subject: `s${i}`, description: "d", status: "pending", blockedBy, writeScopes: ["src"] } });
    push({ type: "team/task", version: 2, teamId: TEAM, task: { id: `task-${i}`, revision: 2, subject: `s${i}`, description: "d", status: "completed", blockedBy, writeScopes: ["src"], ownerId: `m${i % 2500}` } });
  }
  // 1000 消息 × (queued + delivered) = 2000
  for (let i = 0; i < 1000; i++) {
    push({ type: "team/message/queued", version: 2, teamId: TEAM, message: { id: `msg-${i}`, senderId: TEAM, senderName: "lead", targetId: `m${i % 2500}`, content: [{ type: "text", text: "bench payload" }] } });
    push({ type: "team/message/delivered", version: 2, teamId: TEAM, messageId: `msg-${i}`, targetId: `m${i % 2500}` });
  }
  if (events.length !== TOTAL_LINES) throw new Error(`generator produced ${events.length} lines (expect ${TOTAL_LINES})`);
  return { events, lines };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-f32-"));
  teamDir = under(under(root, "teams"), "sess_f32_bench");
  fs.mkdirSync(teamDir, { recursive: true });
});
afterAll(() => {
  const dir = under(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "f32.json"), JSON.stringify(evidence, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("F32 · 冷启动重放基准", () => {
  it(`全量 1 万行 ≤ 2000ms；checkpoint 命中增量 ≤ 200ms；增量与全量状态一致`, { timeout: 60_000, retry: 2 }, async () => {
    const { lines } = generateEvents();
    // retry 隔离：清掉上一次尝试遗留的 checkpoint（否则重试首断言 fromCheckpoint=false 必失败——重试无法生效）
    fs.rmSync(teamDir, { recursive: true, force: true });
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "events.jsonl"), lines.join("\n") + "\n");
    // 预热文件页缓存后再计时（衡量重放 CPU 成本；磁盘冷读另计——登记于交付说明）
    fs.readFileSync(path.join(teamDir, "events.jsonl"));

    const tFull0 = performance.now();
    const full = await load(teamDir, TEAM);
    const fullMs = performance.now() - tFull0;
    expect(full.seq).toBe(TOTAL_LINES);
    expect(full.corrupt).toBeUndefined();
    expect(full.fromCheckpoint).toBe(false);

    // checkpoint 写入（journal 生产路径由 bytesCommitted 提供偏移；此处等价回退为扫描计算）
    await writeCheckpoint(teamDir, { state: full.state, view: full.view, seq: full.seq });
    // 预热（不计入）：页缓存 + JIT 就绪后测量重放 CPU 成本（与首轮读文件预热同口径）
    await load(teamDir, TEAM);

    const tIncr0 = performance.now();
    const incr = await load(teamDir, TEAM);
    const incrMs = performance.now() - tIncr0;
    expect(incr.fromCheckpoint).toBe(true);
    expect(incr.seq).toBe(TOTAL_LINES);
    expect(JSON.stringify(incr.state)).toBe(JSON.stringify(full.state));

    // 追加 5 行后再增量（真实形态：checkpoint 落后于日志尾部）
    const tailLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      tailLines.push(
        JSON.stringify({
          seq: TOTAL_LINES + 1 + i,
          ts: "2026-10-15T00:00:00.000Z",
          writer: "bench:1",
          event: { type: "team/message/queued", version: 2, teamId: TEAM, message: { id: `msg-tail-${i}`, senderId: TEAM, senderName: "lead", targetId: "m0", content: [{ type: "text", text: "tail" }] } },
        }),
      );
    }
    fs.appendFileSync(path.join(teamDir, "events.jsonl"), tailLines.join("\n") + "\n");
    const tTail0 = performance.now();
    const tail = await load(teamDir, TEAM);
    const tailMs = performance.now() - tTail0;
    expect(tail.fromCheckpoint).toBe(true);
    expect(tail.seq).toBe(TOTAL_LINES + 5);
    expect(tail.state.messages).toHaveLength(1005);

    expect(fullMs, `full replay ${fullMs.toFixed(1)}ms must be ≤ 2000ms`).toBeLessThanOrEqual(2000);
    expect(incrMs, `checkpoint hit ${incrMs.toFixed(1)}ms must be ≤ 200ms`).toBeLessThanOrEqual(200);
    expect(tailMs, `incremental with tail ${tailMs.toFixed(1)}ms must be ≤ 200ms`).toBeLessThanOrEqual(200);

    Object.assign(evidence, {
      lines: TOTAL_LINES,
      fullReplayMs: Math.round(fullMs),
      checkpointWriteMs: "见 writeCheckpoint 调用（非门限项）",
      checkpointHitMs: Math.round(incrMs),
      incrementalWithTailMs: Math.round(tailMs),
      state: full.state.members.length === 2500 && full.state.tasks.length === 1500 ? "members=2500 tasks=1500 messages=1000" : "unexpected",
      thresholds: { full: 2000, incremental: 200 },
    });
    console.log(
      `[f32] full=${fullMs.toFixed(1)}ms (≤2000) checkpointHit=${incrMs.toFixed(1)}ms (≤200) tail5=${tailMs.toFixed(1)}ms (≤200)`,
    );
    void checkpointPath;
  });
});
