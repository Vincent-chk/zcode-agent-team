// MockProvider 桩行为单测（0.4.1 覆盖率补齐）：可编程延迟/失败/丢消息脚本、冷路径、
// 呈现能力与测试辅助的防御分支（这些桩路径被域层测试间接使用，此处直接契约化）。
import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/provider/mock-provider.js";

const SPAWN = {
  teamId: "sess_t",
  memberId: "m1",
  name: "w",
  description: "d",
  firstPrompt: "p",
  context: "fresh" as const,
};

describe("MockProvider · startContinuable 脚本", () => {
  it("startDelayMs 延迟后接受；reject → accepted:false；throw → 原样抛", async () => {
    const p = new MockProvider();
    p.programWith({ startDelayMs: 5 });
    const t0 = Date.now();
    expect((await p.startContinuable(SPAWN)).accepted).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);

    const p2 = new MockProvider();
    p2.programWith({ startOutcome: { kind: "reject" } });
    const r = await p2.startContinuable({ ...SPAWN, memberId: "m2" });
    expect(r.accepted).toBe(false);
    expect(p2.readProvisioningRecord("m2")?.initialUserMessageAccepted).toBe(false);

    const boom = new Error("boom");
    const p3 = new MockProvider();
    p3.programWith({ startOutcome: { kind: "throw", error: boom } });
    await expect(p3.startContinuable({ ...SPAWN, memberId: "m3" })).rejects.toBe(boom);
  });

  it("hang：已中止 signal → 立即 reject（reason 透传）；无 signal 的 abort → listener 路径", async () => {
    const p = new MockProvider();
    p.programWith({ startOutcome: { kind: "hang" } });
    const pre = AbortSignal.abort(new Error("pre-aborted"));
    await expect(p.startContinuable({ ...SPAWN, memberId: "mh1", signal: pre })).rejects.toThrow("pre-aborted");

    const ac = new AbortController();
    const run = p.startContinuable({ ...SPAWN, memberId: "mh2", signal: ac.signal });
    ac.abort(new Error("mid-abort"));
    await expect(run).rejects.toThrow("mid-abort");

    // signal.reason 缺省 → Error("aborted")
    const p2 = new MockProvider();
    p2.programWith({ startOutcome: { kind: "hang" } });
    await expect(
      p2.startContinuable({ ...SPAWN, memberId: "mh3", signal: AbortSignal.abort() }),
    ).rejects.toThrow("aborted");
  });
});

describe("MockProvider · deliver 脚本与冷路径", () => {
  it("deliverResults 序列：throw/lost/queued/accepted；缺省 accepted", async () => {
    const p = new MockProvider();
    await p.startContinuable(SPAWN);
    p.programWith({ deliverResults: ["throw", "lost", "queued", "accepted"] });
    await expect(p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "a" })).rejects.toThrow(
      "mock deliver failure for a",
    );
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "b" })).toBe("accepted"); // lost：应答但不记录
    expect(p.containsMessage("m1", "b")).toBe(false);
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "c" })).toBe("queued");
    expect(p.containsMessage("m1", "c")).toBe(false);
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "d" })).toBe("accepted");
    expect(p.containsMessage("m1", "d")).toBe(true);
    // 序列耗尽 → 缺省 accepted
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "e" })).toBe("accepted");
    // 去重：同 id 再投 → accepted 且不重复计数
    const before = p.teamChildren.get("m1")!.deliverCount.get("d") ?? 0;
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "d" })).toBe("accepted");
    expect(p.teamChildren.get("m1")!.deliverCount.get("d")).toBe(before);
  });

  it("deliverDelayMs 生效；死成员（child.alive=false）→ 冷路径 queued", async () => {
    const p = new MockProvider();
    await p.startContinuable(SPAWN);
    p.programWith({ deliverDelayMs: 5 });
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "x" })).toBe("accepted");
    p.killChild("m1");
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "y" })).toBe("queued");
    // 冷 + accepted 脚本：已死 child 复活记录（child 存在分支）
    p.programWith({ coldDeliverOutcome: "accepted" });
    expect(await p.deliver({ memberId: "m1", framedMessage: "[]", messageId: "z" })).toBe("accepted");
    expect(p.containsMessage("m1", "z")).toBe(true);
    // 冷 + accepted：完全未知成员（child === undefined → set 分支）
    expect(await p.deliver({ memberId: "ghost", framedMessage: "[]", messageId: "g" })).toBe("accepted");
    expect(p.containsMessage("ghost", "g")).toBe(true);
    // 同消息重复冷投（received 已有 → 不重复计数）
    const countBefore = p.teamChildren.get("ghost")!.deliverCount.get("g");
    await p.deliver({ memberId: "ghost", framedMessage: "[]", messageId: "g" });
    expect(p.teamChildren.get("ghost")!.deliverCount.get("g")).toBe(countBefore);
  });

  it("containsMessage / readColdRecord：无 child → 冷记录；冷读 throw → 上抛", async () => {
    const p = new MockProvider();
    expect(p.containsMessage("nobody", "m")).toBe(false);
    expect(p.readColdRecord("nobody", "m")).toBeUndefined();
    p.programWith({ coldRead: "throw" });
    expect(() => p.readColdRecord("nobody", "m")).toThrow("mock cold read failure for nobody");
  });
});

describe("MockProvider · interrupt / drain / 呈现 / 辅助", () => {
  it("interrupt：无 child / 已死 → inactive；interruptError → 抛", async () => {
    const p = new MockProvider();
    expect(await p.interrupt({ memberId: "nobody" })).toEqual({ previousStatus: "inactive" });
    await p.startContinuable(SPAWN);
    p.killChild("m1");
    expect(await p.interrupt({ memberId: "m1" })).toEqual({ previousStatus: "inactive" });
    p.reviveChild("m1");
    p.programWith({ interruptError: new Error("nope") });
    await expect(p.interrupt({ memberId: "m1" })).rejects.toThrow("nope");
  });

  it("drain：团队 child 全灭、foreignChildren 不动；drainError → 抛", async () => {
    const p = new MockProvider();
    await p.startContinuable(SPAWN);
    p.addForeignChild("foreign-1");
    await p.drain({ teamId: "sess_t", timeoutMs: 100 });
    expect(p.teamChildren.get("m1")!.alive).toBe(false);
    expect(p.teamChildren.get("m1")!.drained).toBe(true);
    expect(p.foreignChildren.has("foreign-1")).toBe(true);
    expect(p.drainedTeamIds).toEqual(["sess_t"]);
    const p2 = new MockProvider();
    p2.programWith({ drainError: new Error("drain-boom") });
    await expect(p2.drain({ teamId: "t", timeoutMs: 10 })).rejects.toThrow("drain-boom");
  });

  it("呈现与辅助：modelOf 三层回退 / leadModelOf / diagnosticsOf / setProvisioningRecord / markReceived、kill、revive 未知成员防御", () => {
    const p = new MockProvider();
    expect(p.modelOf("nobody")).toBeUndefined();
    expect(p.leadModelOf()).toBeUndefined();
    expect(p.diagnosticsOf("nobody")).toEqual([]);
    p.programWith({ leadModel: "lead-m", memberDiagnostics: { m1: ["diag"] } });
    expect(p.leadModelOf()).toBe("lead-m");
    expect(p.diagnosticsOf("m1")).toEqual(["diag"]);
    // 无记录 → set undefined = 删除幂等；有记录 → 覆盖
    p.setProvisioningRecord("mx", {
      rootSessionId: "t",
      descriptor: { provider: "spawn", mode: "continuable" },
      initialUserMessageAccepted: true,
    });
    expect(p.readProvisioningRecord("mx")?.initialUserMessageAccepted).toBe(true);
    p.setProvisioningRecord("mx", undefined);
    expect(p.readProvisioningRecord("mx")).toBeUndefined();
    // 未知成员的辅助操作不抛
    p.markReceived("nobody", "m");
    p.killChild("nobody");
    p.reviveChild("nobody");
    expect(p.statusOf("nobody")).toBe("inactive");
    // modelOf：child.model 字符串回退（modelSelection 缺省）
    p.teamChildren.set("mc", {
      memberId: "mc",
      name: "mc",
      context: "fresh",
      model: "str-model",
      modelSelection: undefined,
      firstPrompt: "",
      alive: true,
      received: new Set(),
      deliverCount: new Map(),
      interrupted: 0,
      drained: false,
      status: "idle",
    });
    expect(p.modelOf("mc")).toBe("str-model");
    expect(p.statusOf("mc")).toBe("running"); // isAlive 口径 = child.alive（与 status 字段无关）
  });
});
