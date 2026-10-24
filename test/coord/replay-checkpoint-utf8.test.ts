// checkpoint 字节偏移回归（含中文事件）：增量重放必须读到尾部事件。
// 修复前：lastOffset 是字节偏移，却被当作 UTF-8 字符串下标使用 → 多字节内容下尾部事件被静默丢弃。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, writeCheckpoint } from "../../src/coord/replay.js";

const TEAM = "sess_cp_utf8";

let root: string;
let teamDir: string;

function append(event: unknown, seq: number): void {
  const line = JSON.stringify({ seq, ts: new Date().toISOString(), writer: "w:1", event });
  fs.appendFileSync(path.join(teamDir, "events.jsonl"), `${line}\n`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-cp-utf8-"));
  teamDir = path.join(root, "teams", TEAM);
  fs.mkdirSync(teamDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("replay checkpoint · UTF-8 字节偏移", () => {
  it("中文事件后写 checkpoint，再追加两条事件 → 增量重放读到全部", async () => {
    append(
      {
        type: "team/member",
        version: 2,
        teamId: TEAM,
        member: { id: "m1", name: "成员甲", description: "中文描述：这是一个很长的说明", provider: "spawn", context: "fresh", phase: "provisioning" },
      },
      1,
    );
    append(
      {
        type: "team/member",
        version: 2,
        teamId: TEAM,
        member: { id: "m1", name: "成员甲", description: "中文描述：这是一个很长的说明", provider: "spawn", context: "fresh", phase: "active" },
      },
      2,
    );
    const before = await load(teamDir, TEAM);
    expect(before.seq).toBe(2);
    await writeCheckpoint(teamDir, { state: before.state, view: before.view, seq: before.seq });

    append(
      {
        type: "team/member",
        version: 2,
        teamId: TEAM,
        member: { id: "m2", name: "成员乙", description: "第二批成员", provider: "spawn", context: "fresh", phase: "provisioning" },
      },
      3,
    );
    append(
      {
        type: "team/member",
        version: 2,
        teamId: TEAM,
        member: { id: "m2", name: "成员乙", description: "第二批成员", provider: "spawn", context: "fresh", phase: "active" },
      },
      4,
    );

    const after = await load(teamDir, TEAM);
    expect(after.fromCheckpoint).toBe(true);
    expect(after.checkpointIgnored).toBeUndefined();
    expect(after.seq).toBe(4);
    expect(after.state.members.map((m) => `${m.name}:${m.phase}`)).toEqual(["成员甲:active", "成员乙:active"]);
    expect(after.writers).toEqual(["w:1"]);
  });

  it("checkpoint 的 lastOffset 精确等于前 N 行字节数（含中文）", async () => {
    append(
      {
        type: "team/member",
        version: 2,
        teamId: TEAM,
        member: { id: "m1", name: "中文名字", description: "中文", provider: "spawn", context: "fresh", phase: "active" },
      },
      1,
    );
    const loaded = await load(teamDir, TEAM);
    await writeCheckpoint(teamDir, { state: loaded.state, view: loaded.view, seq: loaded.seq });
    const doc = JSON.parse(fs.readFileSync(path.join(teamDir, "checkpoint.json"), "utf8")) as { lastOffset: number };
    const bytes = fs.readFileSync(path.join(teamDir, "events.jsonl"));
    expect(doc.lastOffset).toBe(bytes.length);
  });
});
