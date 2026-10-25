// CLI 进程内测试（补 v8 覆盖率：main/call/tail-follow 在子进程脚本测试中不计入）。
// stdout/stderr spy + in-process 协调者（TeamCoordinatorHost on tmpdir）。数据根 os.tmpdir()。
import { describe, expect, it, beforeAll, afterAll, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/main.js";
import { callTeam } from "../../src/cli/call.js";
import { followEvents, formatTailLine } from "../../src/cli/tail.js";
import { paintFor } from "../../src/cli/colors.js";
import { TeamCoordinatorHost } from "../../src/coord/host.js";

const TEAM = "sess_entry_team";
let root: string;
let teamDir: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

let host: TeamCoordinatorHost | null = null;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-entry-"));
  host = await TeamCoordinatorHost.open({ dataRoot: root, teamId: TEAM });
  await host.dispatch("member.spawn", { session_id: TEAM, name: "worker", description: "d", prompt: "p" });
  await host.dispatch("task.create", { session_id: TEAM, subject: "entry-task", description: "d" });
  await host.dispatch("message.send", { session_id: TEAM, targetName: "worker", content: [{ type: "text", text: "hi" }] });
  teamDir = under(under(root, "teams"), TEAM);
});

afterAll(async () => {
  await host?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function capture(): { out: string[]; err: string[]; restore(): void } {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err, restore: () => { so.mockRestore(); se.mockRestore(); } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main 入口（进程内）", () => {
  it("usage / 未知子命令 / 参数缺失 → 单行错误 + 退出码", async () => {
    const c1 = capture();
    expect(await main([])).toBe(2);
    c1.restore();
    const c2 = capture();
    expect(await main(["help"])).toBe(0);
    expect(c2.out.join("")).toContain("team-ctl state");
    c2.restore();
    const c3 = capture();
    expect(await main(["nope"])).toBe(2);
    expect(c3.err.join("").split("\n")[0]).toContain("未知子命令");
    c3.restore();
    const c4 = capture();
    expect(await main(["state"])).toBe(2);
    c4.restore();
  });

  it("state：渲染路径 + --json + --team 显式 + 空目录推断回退目录名", async () => {
    const c = capture();
    expect(await main(["state", teamDir])).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("Roster (2)");
    expect(text).toContain("entry-task");
    expect(text).toContain("[delivered]");
    c.restore();

    const cj = capture();
    expect(await main(["state", teamDir, "--json"])).toBe(0);
    expect(JSON.parse(cj.out.join("")).teamId).toBe(TEAM);
    cj.restore();

    const ct = capture();
    expect(await main(["state", teamDir, "--team", TEAM])).toBe(0);
    ct.restore();

    // 空目录：无事件行 → 目录名兜底（safeTeamId(TEAM) === TEAM）
    const empty = under(root, "empty-team");
    fs.mkdirSync(empty, { recursive: true });
    const ce = capture();
    expect(await main(["state", empty])).toBe(0);
    expect(ce.out.join("")).toContain(`Agent Team ${path.basename(empty)}`);
    ce.restore();
  });

  it("inject-event：显式 JSON 行 + 未知样例 + 缺参 + 非 JSON 可读错误", async () => {
    const injDir = under(root, "inj-cli");
    fs.mkdirSync(injDir, { recursive: true });
    const c = capture();
    const line = JSON.stringify({ event: { type: "team/task", version: 2, teamId: TEAM, task: { id: "task-9", revision: 1, subject: "inj", description: "d", status: "pending", blockedBy: [], writeScopes: [] } } });
    expect(await main(["inject-event", injDir, line])).toBe(0);
    expect(c.out.join("")).toContain("seq=1");
    c.restore();

    const c2 = capture();
    expect(await main(["inject-event", injDir, "--sample", "bogus"])).toBe(2);
    c2.restore();
    const c3 = capture();
    expect(await main(["inject-event", injDir])).toBe(2);
    c3.restore();
    const c4 = capture();
    expect(await main(["inject-event", injDir, "not-json"])).toBe(1);
    expect(c4.err.join("")).toContain("必须是合法 JSON 行");
    c4.restore();
  });

  it("call：真方法成功 + 坏 params + 无协调者可读错误", async () => {
    const c = capture();
    expect(await main(["call", teamDir, "member.claim", JSON.stringify({ session_id: TEAM })])).toBe(0);
    expect(c.out.join("")).toContain('"role": "lead"');
    c.restore();

    const c2 = capture();
    expect(await main(["call", teamDir, "member.claim", "{{"])).toBe(1);
    expect(c2.out.join("")).toContain("不是合法 JSON");
    c2.restore();

    const empty = under(root, "no-coord-team");
    fs.mkdirSync(empty, { recursive: true });
    const c3 = capture();
    expect(await main(["call", empty, "member.claim", "{}"])).toBe(1);
    expect(c3.out.join("")).toContain("Agent Teams coordinator is unavailable (between coordinators); retry the request shortly");
    c3.restore();
  });

  it("tail 参数校验（--n 非法 / 缺 teamDir）", async () => {
    const c = capture();
    expect(await main(["tail", teamDir, "--n", "-1"])).toBe(2);
    expect(c.err.join("")).toContain("--n 必须是非负整数");
    c.restore();
    const c2 = capture();
    expect(await main(["tail"])).toBe(2);
    c2.restore();
  });

  it("transcript 参数校验（缺参 / --cursor/--limit 非法 / 会话未落定单行错误）", async () => {
    const c1 = capture();
    expect(await main(["transcript", teamDir])).toBe(2);
    expect(c1.err.join("")).toContain("需要 <teamDir> <member>");
    c1.restore();
    const c2 = capture();
    expect(await main(["transcript", teamDir, "worker", "--cursor", "abc"])).toBe(2);
    expect(c2.err.join("")).toContain("--cursor 必须是安全整数");
    c2.restore();
    const c3 = capture();
    expect(await main(["transcript", teamDir, "worker", "--limit", "1.5"])).toBe(2);
    expect(c3.err.join("")).toContain("--limit 必须是安全整数");
    c3.restore();
    // MockProvider 成员无 origin.json → 会话未落定：TeamError 单行透传（main 错误面）
    const c4 = capture();
    expect(await main(["transcript", teamDir, "worker"])).toBe(1);
    expect(c4.err.join("").trimEnd().split("\n")).toHaveLength(1);
    expect(c4.err.join("")).toContain('active teammate "worker" not found');
    c4.restore();
  });

  it("widget：stdout 片段 + 非法 --theme/--lang + 缺参 + --out 落盘/穿越拒绝 + --standalone", async () => {
    const c1 = capture();
    expect(await main(["widget", teamDir])).toBe(0);
    expect(c1.out.join("")).toContain('id="agent-team-widget"');
    c1.restore();
    const c2 = capture();
    expect(await main(["widget", teamDir, "--theme", "neon"])).toBe(2);
    expect(c2.err.join("")).toContain("--theme 仅支持");
    c2.restore();
    const c3 = capture();
    expect(await main(["widget", teamDir, "--lang", "fr"])).toBe(2);
    expect(c3.err.join("")).toContain("--lang 仅支持");
    c3.restore();
    const c4 = capture();
    expect(await main(["widget"])).toBe(2);
    c4.restore();
    const outFile = under(root, "widget-out.html");
    const c5 = capture();
    expect(await main(["widget", teamDir, "--out", outFile])).toBe(0);
    expect(c5.out.join("").trim()).toBe(path.resolve(outFile));
    expect(fs.existsSync(outFile)).toBe(true);
    c5.restore();
    const c6 = capture();
    expect(await main(["widget", teamDir, "--out", "../escape.html"])).toBe(1);
    expect(c6.err.join("")).toContain("拒绝路径穿越段");
    c6.restore();
    const c7 = capture();
    expect(await main(["widget", teamDir, "--standalone"])).toBe(0);
    expect(c7.out.join("")).toMatch(/^<!doctype html>/i);
    c7.restore();
  });

  it("open-panel：无注册文件 → 指引（退出码 1；--no-open 不触发浏览器）", async () => {
    // dataDir() 锚定到本测试 root（无注册文件 → 确定性失败路径；不受开发环境残留影响）
    const prev = process.env.TEAM_PLUGIN_DATA;
    process.env.TEAM_PLUGIN_DATA = root;
    try {
      const c = capture();
      expect(await main(["open-panel", "--no-open"])).toBe(1);
      expect(c.out.join("")).toContain("TEAM_COMPANION=1");
      c.restore();
    } finally {
      if (prev === undefined) delete process.env.TEAM_PLUGIN_DATA;
      else process.env.TEAM_PLUGIN_DATA = prev;
    }
  });
});

describe("callTeam（进程内）", () => {
  it("成功 / 坏 JSON / 缺位窗口", async () => {
    const ok = await callTeam(teamDir, "coordinator.hello", "{}");
    expect(ok.ok).toBe(true);
    expect(JSON.parse(ok.output)).toMatchObject({ coordinatorBootId: expect.any(String) });

    const bad = await callTeam(teamDir, "coordinator.hello", "not-json");
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("不是合法 JSON");

    const none = await callTeam(under(root, "no-coord-team"), "member.claim", "{}");
    expect(none.ok).toBe(false);
    expect(none.output).toContain("coordinator is unavailable");
    expect(() => JSON.parse(none.audit)).not.toThrow();
  });

  it("TeamError → [code] message 摘要 + audit.code；非 TeamError → 首行摘要（call.ts 错误分类分支）", async () => {
    // 缺 session_id → 方法表 TEAM_INVALID_ARGUMENT（TeamError 透传路径）
    const team = await callTeam(teamDir, "member.claim", "{}");
    expect(team.ok).toBe(false);
    expect(team.output).toContain("[TEAM_INVALID_ARGUMENT]");
    expect(team.output).toContain('param "session_id" is required');
    expect(JSON.parse(team.audit)).toMatchObject({ ok: false, code: "TEAM_INVALID_ARGUMENT" });

    // 未注册方法 → RPC 层普通 Error（非 TeamError、非缺位消息）→ 首行摘要，audit 无 code
    const unknown = await callTeam(teamDir, "no.such.method", "{}");
    expect(unknown.ok).toBe(false);
    expect(unknown.output).not.toContain("[TEAM_");
    const audit = JSON.parse(unknown.audit) as { ok: boolean; code?: string };
    expect(audit.ok).toBe(false);
    expect(audit.code).toBeUndefined();

    // paramsJson 缺省（undefined）→ {} 路径照常成功
    const noParams = await callTeam(teamDir, "coordinator.hello", undefined);
    expect(noParams.ok).toBe(true);
  });
});

describe("followEvents（进程内跟随）", () => {
  it("历史回放 + 增量行 + 截断重置 + abort 退出 + 缺文件错误", async () => {
    const dir = under(root, "follow");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    const mk = (seq: number, type: string) =>
      JSON.stringify({ seq, ts: new Date().toISOString(), writer: "w:1", event: { type } });
    // 历史含多字节字符（UTF-8 字节数 ≠ 字符串长度——offset 必须按字节推进的回归样例）
    fs.writeFileSync(
      file,
      [mk(1, "team/member"), mk(2, "team/task")].join("\n") + "\n",
    );
    fs.appendFileSync(
      file,
      JSON.stringify({ seq: 3, ts: new Date().toISOString(), writer: "w:1", event: { type: "team/message", text: "整理数据源·写入批次·交叉校验·多字节回归" } }) + "\n",
    );

    const controller = new AbortController();
    const seen: string[] = [];
    const invalidSeen: string[] = [];
    const followPromise = followEvents(file, {
      fromLines: 2,
      pollMs: 30,
      signal: controller.signal,
      paint: paintFor({ isTTY: false }),
      onLine: (formatted, raw) => {
        seen.push(formatted);
        if (raw.kind === "invalid") invalidSeen.push(raw.raw);
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    fs.appendFileSync(file, mk(4, "team/message") + "\n");
    await new Promise((r) => setTimeout(r, 80));
    // 截断（轮转）→ offset 重置重读
    fs.writeFileSync(file, mk(1, "team/message/delivered") + "\n");
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await followPromise;

    expect(seen.some((l) => l.includes("team/task"))).toBe(true); // 历史 --n 2
    expect(seen.some((l) => l.includes("team/message"))).toBe(true); // 增量
    expect(seen.some((l) => l.includes("team/message/delivered"))).toBe(true); // 截断重读
    // 多字节回归：offset 按字节推进 → 增量读不得落半行（invalid 为空）
    expect(invalidSeen).toEqual([]);

    await expect(
      followEvents(path.join(dir, "missing.jsonl"), {
        paint: paintFor({ isTTY: false }),
        signal: AbortSignal.abort(),
        onLine: () => undefined,
      }),
    ).rejects.toThrow("events file not found");
  });

  it("formatTailLine 未知事件类型 → dim + JSON 摘要", () => {
    const out = formatTailLine(
      { kind: "line", line: { seq: 1, ts: "2026-10-15T00:00:00.000Z", writer: "w:1", event: { type: "team/other", x: 1 } } },
      paintFor({ isTTY: false }),
    );
    expect(out).toContain("team/other");
    expect(out).toContain('"x":1');
  });

  it("summarize 防御分支：task 事件缺 subject/status/revision → 占位符", () => {
    const out = formatTailLine(
      { kind: "line", line: { seq: 1, ts: "2026-10-15T00:00:00.000Z", writer: "w:1", event: { type: "team/task", task: { id: "task-1" } } } },
      paintFor({ isTTY: false }),
    );
    expect(out).toContain("task-1");
    expect(out).toContain("[? r?]"); // status/revision 缺省占位
  });

  it("followEvents 缺省 fromLines → 历史不回放（start=末尾）；增量空行跳过", async () => {
    const dir = under(root, "follow2");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    const mk = (seq: number, type: string) =>
      JSON.stringify({ seq, ts: new Date().toISOString(), writer: "w:1", event: { type } });
    fs.writeFileSync(file, mk(1, "team/member") + "\n");

    const controller = new AbortController();
    const seen: string[] = [];
    const followPromise = followEvents(file, {
      pollMs: 30,
      signal: controller.signal,
      paint: paintFor({ isTTY: false }),
      onLine: (formatted) => seen.push(formatted),
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual([]); // 缺省 fromLines：历史行不回放（tail -f 语义）
    // 增量：空行（连续换行）跳过 + 正常行 emit
    fs.appendFileSync(file, "\n" + mk(2, "team/task") + "\n");
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await followPromise;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("team/task");
  });
});
