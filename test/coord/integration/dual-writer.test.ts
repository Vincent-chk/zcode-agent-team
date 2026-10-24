// D（双写者保护）：两子进程绕过锁与 journal 交错追加（模拟双协调者竞态）→
// 重放必须 failure 保护而非静默合并。保护链论证：
//   O_APPEND 单写原子（行不撕裂）+ 行号 seq 连续性校验 + 追加前不变量
//   ⇒ 任一持有陈旧前缀的第二写者，其行号必与实际行位错位 → replay 连续性 fail-closed；
//   wrapper.writer 字段提供事后溯源（风险表「事件行带 writerId」落点）。
// 锁纪律（单写者）从源头防止该局面；本测试验证防线兜底。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { load } from "../../../src/coord/replay.js";
import { safeTeamId } from "../../../src/coord/paths.js";

const APPENDER = `const file = process.argv[2];
const payloadFile = process.argv[3];
const jitter = Number(process.argv[4] || 0);
const fs = require("node:fs");
const lines = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
const fd = fs.openSync(file, "a");
for (const line of lines) {
  if (jitter > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * jitter));
  fs.writeSync(fd, line + "\\n");
}
fs.closeSync(fd);
process.stdout.write("APPENDED " + lines.length + "\\n");
`;

let root: string;
let appenderScript: string;
const evidence: Array<Record<string, unknown>> = [];

function under(r: string, name: string): string {
  const p = path.join(r, name);
  if (!path.resolve(p).startsWith(path.resolve(r) + path.sep)) throw new Error("escape");
  return p;
}

function runAppender(target: string, payloadFile: string, jitterMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [appenderScript, target, payloadFile, String(jitterMs)], (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}; stderr=${stderr}`));
      else resolve(stdout);
    });
  });
}

function line(seq: number, writer: string, event: unknown): string {
  return JSON.stringify({ seq, ts: new Date().toISOString(), writer, event });
}

function memberEventLine(teamId: string, id: string, name: string, phase: string, seq: number, writer: string): string {
  return line(seq, writer, {
    type: "team/member",
    version: 2,
    teamId,
    member: { id, name, description: "d", provider: "spawn", context: "fresh", phase },
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-dual-"));
  appenderScript = path.join(root, "appender.cjs");
  fs.writeFileSync(appenderScript, APPENDER);
});
afterAll(() => {
  fs.writeFileSync(
    path.join(fs.realpathSync(os.tmpdir()), "at-stage2-evidence", "dual-writer.json"),
    JSON.stringify(evidence, null, 2),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

describe("双写者 · 交错追加 → 重放 fail-closed", () => {
  it("良性不相交事件交错（各持陈旧前缀编号）→ seq 连续性破坏 → failure 保护，不静默合并", { timeout: 20_000 }, async () => {
    const team = "sess_dual_benign";
    const teamDir = under(under(root, "teams"), safeTeamId(team));
    fs.mkdirSync(teamDir, { recursive: true });
    const eventsFile = path.join(teamDir, "events.jsonl");
    // 共享前缀（seq 1-2：member b provisioning/active）
    const prefix = [
      memberEventLine(team, "b", "wb", "provisioning", 1, "boot-a:1"),
      memberEventLine(team, "b", "wb", "active", 2, "boot-a:1"),
    ];
    fs.writeFileSync(eventsFile, prefix.join("\n") + "\n");
    // 写者 A 的后续（其视图 seq 从 3 起）：member c 生命周期
    const payloadA = under(root, "payload-a.json");
    fs.writeFileSync(
      payloadA,
      JSON.stringify([
        memberEventLine(team, "c", "wc", "provisioning", 3, "boot-a:1"),
        memberEventLine(team, "c", "wc", "active", 4, "boot-a:1"),
      ]),
    );
    // 写者 B 的后续（同样从其视图 seq 3 起）：member d 生命周期
    const payloadB = under(root, "payload-b.json");
    fs.writeFileSync(
      payloadB,
      JSON.stringify([
        memberEventLine(team, "d", "wd", "provisioning", 3, "boot-b:2"),
        memberEventLine(team, "d", "wd", "active", 4, "boot-b:2"),
      ]),
    );
    // 交错执行（抖动促成行级交错；无论次序如何结论一致）
    await Promise.all([runAppender(eventsFile, payloadA, 8), runAppender(eventsFile, payloadB, 8)]);

    const loaded = await load(teamDir, team);
    // 关键断言：绝不静默合并（第二写者行号与行位错位 → 连续性破坏 → failure）
    expect(loaded.corrupt).toBeDefined();
    expect(loaded.state.failure).toBeDefined();
    expect(loaded.writers).toEqual(["boot-a:1", "boot-b:2"]); // 溯源可见
    evidence.push({
      case: "benign-disjoint-interleave",
      corrupt: loaded.corrupt,
      failure: loaded.state.failure,
      writers: loaded.writers,
      verdict: "fail-closed (seq continuity), not silently merged",
    });
    console.log(`[dual-writer] benign: corrupt=${JSON.stringify(loaded.corrupt)} failure=${loaded.state.failure}`);
  });

  it("冲突事件交错（同成员重复 provisioning）→ 同样 fail-closed", { timeout: 20_000 }, async () => {
    const team = "sess_dual_conflict";
    const teamDir = under(under(root, "teams"), safeTeamId(team));
    fs.mkdirSync(teamDir, { recursive: true });
    const eventsFile = path.join(teamDir, "events.jsonl");
    fs.writeFileSync(eventsFile, memberEventLine(team, "b", "wb", "provisioning", 1, "boot-a:1") + "\n");
    const payloadA = under(root, "payload-c.json");
    fs.writeFileSync(payloadA, JSON.stringify([memberEventLine(team, "b", "wb", "active", 2, "boot-a:1")]));
    const payloadB = under(root, "payload-d.json");
    fs.writeFileSync(payloadB, JSON.stringify([memberEventLine(team, "b", "wb", "active", 2, "boot-b:2")]));
    await Promise.all([runAppender(eventsFile, payloadA, 5), runAppender(eventsFile, payloadB, 5)]);
    const loaded = await load(teamDir, team);
    expect(loaded.corrupt !== undefined || loaded.state.failure !== undefined).toBe(true);
    expect(loaded.state.failure).toBeDefined();
    evidence.push({
      case: "conflicting-same-member",
      corrupt: loaded.corrupt,
      failure: loaded.state.failure,
      verdict: "fail-closed",
    });
  });
});
