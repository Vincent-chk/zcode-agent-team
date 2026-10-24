// T2.2 journal 单元：appendAndFlush（不变量前置/行格式/fsync 纪律）、transact 尾链串行、
// 崩溃注入点（5 点）、64KB 上限、onCommit 顺序、单写者纪律、checkpoint 联动。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamJournal, readAllLines, type CrashPoint } from "../../src/coord/journal.js";
import { CoordinatorLock } from "../../src/coord/lock.js";
import { load } from "../../src/coord/replay.js";
import { memberEvent, taskEvent, queuedEvent, TEAM_ID } from "../domain/helpers.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-journal-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function freshJournal(team: string, opts: Parameters<typeof TeamJournal.open>[2] = {}) {
  const teamDir = path.join(dir, team);
  fs.mkdirSync(teamDir, { recursive: true });
  const lock = new CoordinatorLock(path.join(teamDir, "coordinator.lock"));
  await lock.acquire();
  const journal = TeamJournal.open(teamDir, `${TEAM_ID}-${team}`, opts);
  await journal.openWriter();
  return { journal, lock, teamDir };
}

describe("journal · appendAndFlush 与行格式", () => {
  it("合法追加：行 = {seq 行号, ts ISO, writer, event}；committedSeq 推进", async () => {
    const { journal, lock, teamDir } = await freshJournal("fmt");
    const id = `${TEAM_ID}-fmt`;
    const r1 = await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id));
    expect(r1.seq).toBe(1);
    expect(r1.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const r2 = await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1", phase: "active" }, id));
    expect(r2.seq).toBe(2);
    const lines = await journal.readAll();
    expect(lines).toHaveLength(2);
    expect(lines[0].seq).toBe(1);
    expect(lines[0].writer).toMatch(/^.+:\d+$/);
    expect((lines[0].event as { type: string }).type).toBe("team/member");
    expect(lines[1].seq).toBe(2);
    void teamDir;
    await journal.close();
    await lock.release();
  });

  it("非法事件绝不落盘：逐字 `session event <seq> violates the Agent Teams stream: <failure>`", async () => {
    // F07 语义在 journal 层的落点（追加前不变量）
    const id = `${TEAM_ID}-reject`;
    const { journal, lock } = await freshJournal("reject");
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id));
    await expect(
      journal.appendAndFlush({ ...memberEvent({ id: "a9", name: "x" }, id), version: 3 }),
    ).rejects.toThrowError(
      "session event 2 violates the Agent Teams stream: unsupported Agent Teams event version 3",
    );
    await expect(
      journal.appendAndFlush(memberEvent({ id: "a1", name: "w1", phase: "active" }, id)),
    ).resolves.toBeDefined();
    await expect(
      journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id)),
    ).rejects.toThrowError(
      'session event 3 violates the Agent Teams stream: teammate "w1" has an invalid active -> provisioning transition',
    );
    expect(journal.committedSeq).toBe(2); // 仅前两条落盘
    expect((await readAllLines(path.join(dir, "reject", "events.jsonl")))).toHaveLength(2);
    await journal.close();
    await lock.release();
  });

  it("单行 ≤64KB 上限：超限拒绝且不落盘", async () => {
    const id = `${TEAM_ID}-big`;
    const { journal, lock } = await freshJournal("big");
    const huge = queuedEvent(
      { id: "m-big", targetId: id, content: [{ type: "text", text: "x".repeat(70_000) }] },
      id,
    );
    await expect(journal.appendAndFlush(huge)).rejects.toThrowError(/exceeds 65536 bytes/);
    expect((await readAllLines(path.join(dir, "big", "events.jsonl")))).toHaveLength(0);
    await journal.close();
    await lock.release();
  });

  it("onCommit 通知先于应答（listener 在 resolve 前收到已提交状态）", async () => {
    const id = `${TEAM_ID}-notify`;
    const { journal, lock } = await freshJournal("notify");
    const order: string[] = [];
    journal.onCommit((entry, state) => {
      order.push(`notified:${entry.seq}:${state.members.length}`);
    });
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id)).then(() =>
      order.push("resolved"),
    );
    expect(order).toEqual(["notified:1:1", "resolved"]);
    await journal.close();
    await lock.release();
  });

  it("单写者纪律：无锁 → openWriter 拒绝；enforceLock:false 放行（测试形态）；进程内单例", async () => {
    const teamDir = path.join(dir, "discipline");
    fs.mkdirSync(teamDir, { recursive: true });
    const j = TeamJournal.open(teamDir, `${TEAM_ID}-d`, { checkpointEvery: 0 });
    await expect(j.openWriter()).rejects.toThrowError(/requires the coordinator lock/);
    const j2 = TeamJournal.open(teamDir, `${TEAM_ID}-d2`, { checkpointEvery: 0, enforceLock: false });
    await expect(j2.openWriter()).resolves.toBeDefined();
    // 进程内单例：同 teamDir+teamId 返回同实例（close 前注册仍在）
    const j3 = TeamJournal.open(teamDir, `${TEAM_ID}-d2`, { checkpointEvery: 0 });
    expect(j3).toBe(j2);
    await j2.close();
    // close 后注册清除：下一次 open 是新实例
    const j4 = TeamJournal.open(teamDir, `${TEAM_ID}-d2`, { checkpointEvery: 0, enforceLock: false });
    expect(j4).not.toBe(j2);
    await j4.close();
  });
});

describe("journal · transact 尾链串行（应答序 = 提交序）", () => {
  it("慢事务不阻塞入队顺序；完成序严格串行", async () => {
    const id = `${TEAM_ID}-tx`;
    const { journal, lock } = await freshJournal("tx", { checkpointEvery: 0 });
    const done: number[] = [];
    const op = (n: number, ms: number) => () =>
      new Promise<number>((resolve) =>
        setTimeout(() => {
          done.push(n);
          resolve(n);
        }, ms),
      );
    await Promise.all([
      journal.transact(op(1, 60)),
      journal.transact(op(2, 10)),
      journal.transact(op(3, 30)),
    ]);
    expect(done).toEqual([1, 2, 3]);
    // 事务异常不阻断后续事务
    const saw: string[] = [];
    await Promise.all([
      journal.transact(async () => {
        throw new Error("boom");
      }).catch((e: Error) => saw.push(e.message)),
      journal.transact(() => {
        saw.push("next");
        return 1;
      }),
    ]);
    expect(saw).toEqual(["boom", "next"]);
    await journal.close();
    await lock.release();
  });

  it("append 与 transact 共用同一条尾链（追加串行）", async () => {
    const id = `${TEAM_ID}-mix`;
    const { journal, lock } = await freshJournal("mix", { checkpointEvery: 0 });
    const seqs: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        journal.appendAndFlush(taskEvent({ id: `task-${i}` }, id)).then((r) => seqs.push(r.seq)),
      ),
    );
    expect(seqs.sort()).toEqual([1, 2, 3, 4]);
    await journal.close();
    await lock.release();
  });
});

describe("journal · 崩溃注入点（5 点；进程内 throw 模拟，hook 挂在第 2 条事件）", () => {
  const cases: Array<[CrashPoint, number, string]> = [
    // [point, 崩溃后磁盘行数期望（第 1 条已提交 + 第 2 条视注入点而定）, 说明]
    ["append:before", 1, "第 2 条未写 → 仅第 1 条"],
    ["append:after", 2, "第 2 条已达页缓存（进程级死亡不丢；跨进程 fsync 语义见 fscheck/矩阵）"],
    ["fsync:before", 2, "同 append:after 语义位"],
    ["fsync:after", 2, "fsync 完成 → 第 2 条持久"],
    ["ack:before", 2, "已持久+内存态推进，应答未发出"],
  ];
  for (const [point, expectedLines] of cases) {
    it(`${point}：hook 抛出 → 磁盘 ${expectedLines} 行、无半行、重载可用`, async () => {
      const team = `crash-${point.replace(":", "-")}`;
      const id = `${TEAM_ID}-${team}`;
      const { journal, lock, teamDir } = await freshJournal(team, {
        checkpointEvery: 0,
        crashHook: (p, ctx) => {
          if (p === point && ctx.seq === 2) throw new Error(`injected:${point}`);
        },
      });
      await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id)); // seq 1
      await expect(
        journal.appendAndFlush(memberEvent({ id: "a1", name: "w1", phase: "active" }, id)), // seq 2
      ).rejects.toThrowError(`injected:${point}`);
      const lines = await readAllLines(path.join(teamDir, "events.jsonl"));
      expect(lines).toHaveLength(expectedLines);
      expect(lines.every((l) => Number.isInteger(l.seq))).toBe(true); // 无半行（JSON 完整可解析）
      // 抛出后实例视为中毒：close + 全新加载（接任者冷启动路径）
      await journal.close().catch(() => undefined);
      const loaded = await load(teamDir, id);
      expect(loaded.corrupt).toBeUndefined();
      expect(loaded.seq).toBe(expectedLines);
      await lock.release();
    });
  }
});

describe("journal · checkpoint 联动", () => {
  it("onCommit 可退订；committedSeq/cachedState 读数器", async () => {
    const id = `${TEAM_ID}-off`;
    const { journal, lock } = await freshJournal("off", { checkpointEvery: 0 });
    let called = 0;
    const off = journal.onCommit(() => {
      called += 1;
    });
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id));
    expect(called).toBe(1);
    off();
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1", phase: "active" }, id));
    expect(called).toBe(1);
    expect(journal.committedSeq).toBe(2);
    expect(journal.cachedState?.members).toHaveLength(1);
    await journal.close();
    await lock.release();
  });

  it("checkpointEvery=2：第 2/4 次提交后 checkpoint.json 出现且 lastSeq 正确；close 落盘", async () => {
    const id = `${TEAM_ID}-ckpt`;
    const { journal, lock, teamDir } = await freshJournal("ckpt", { checkpointEvery: 2 });
    const cp = path.join(teamDir, "checkpoint.json");
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1" }, id));
    expect(fs.existsSync(cp)).toBe(false);
    await journal.appendAndFlush(memberEvent({ id: "a1", name: "w1", phase: "active" }, id));
    await new Promise((r) => setTimeout(r, 30)); // 异步 checkpoint 落定
    expect(fs.existsSync(cp)).toBe(true);
    const loaded = await load(teamDir, id);
    expect(loaded.fromCheckpoint).toBe(true);
    expect(loaded.seq).toBe(2);
    expect(loaded.state.members).toHaveLength(1);
    await journal.close();
    await lock.release();
  });
});
