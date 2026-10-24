// T2.2 rpc 单元：NDJSON 一请求一响应、TeamError code 透传、超时、示例方法桩、
// 缺位窗口临时错误（TEAM_DISPOSED 复用）、退避重试、长路径可读错误。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RpcServer,
  RpcClient,
  registerExampleMethods,
  coordinatorUnavailableError,
  COORDINATOR_UNAVAILABLE_MESSAGE,
  callCoordinator,
  callWithRetry,
  SUN_PATH_LIMIT,
} from "../../src/coord/rpc.js";
import { resolveSocketPath, writeSocketRegistry, discoverSocketPath, removeSocketRegistry } from "../../src/coord/paths.js";
import { TeamError } from "../../src/domain/errors.js";
import { bootId } from "../../src/coord/identity.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-rpc-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function under(root: string, name: string): string {
  const p = path.join(root, name);
  if (!path.resolve(p).startsWith(path.resolve(root) + path.sep)) throw new Error("escape");
  return p;
}

describe("rpc · 传输与方法注册", () => {
  it("一请求一响应 + 请求 id 关联（并发不串线）", async () => {
    const sock = under(dir, "s1.sock");
    const server = new RpcServer(sock);
    server.register("echo", (params) => params);
    await server.listen();
    const client = await RpcClient.connect(sock);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.call("echo", { i })),
    );
    expect(results.map((r) => (r as { i: number }).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    client.close();
    await server.close();
  });

  it("TeamError code 逐字透传；非 TeamError 保 name/message 不贴假 code", async () => {
    const sock = under(dir, "s2.sock");
    const server = new RpcServer(sock);
    server.register("teamErr", () => {
      throw new TeamError("TEAM_TASK_NOT_FOUND", 'team task "task-9" not found');
    });
    server.register("plainErr", () => {
      const e = new Error("plain boom");
      e.name = "PlainError";
      throw e;
    });
    await server.listen();
    const client = await RpcClient.connect(sock);
    await expect(client.call("teamErr")).rejects.toMatchObject({
      code: "TEAM_TASK_NOT_FOUND",
      message: 'team task "task-9" not found',
    });
    const plain = await client.call("plainErr").catch((e: Error) => e);
    expect(plain).toBeInstanceOf(Error);
    expect((plain as Error).message).toBe("plain boom");
    expect((plain as Error & { code?: string }).code).toBeUndefined();
    client.close();
    await server.close();
  });

  it("示例方法桩：coordinator.hello / admin.reconcile", async () => {
    const sock = under(dir, "s3.sock");
    const server = new RpcServer(sock);
    registerExampleMethods(server, {
      coordinatorBootId: () => bootId(),
      stateRevision: () => 42,
    });
    await server.listen();
    const client = await RpcClient.connect(sock);
    const hello = await client.call<{ coordinatorBootId: string; stateRevision: number }>("coordinator.hello");
    expect(hello.stateRevision).toBe(42);
    expect(hello.coordinatorBootId).toBe(bootId());
    // 第四轮去桩：示例面保留 example 标记，真 admin.reconcile 由 registerTeamMethods 注册（host.ts 装配）
    const reconcile = await client.call<{ example: boolean; note: string }>("admin.reconcile");
    expect(reconcile.example).toBe(true);
    expect(reconcile.note).toContain("registerTeamMethods");
    client.close();
    await server.close();
  });

  it("未知方法 / 调用超时 / 服务端方法超时", async () => {
    const sock = under(dir, "s4.sock");
    const server = new RpcServer(sock);
    server.register("slow", () => new Promise((r) => setTimeout(r, 300)));
    await server.listen({ callTimeoutMs: 50 });
    const client = await RpcClient.connect(sock);
    await expect(client.call("nope")).rejects.toThrowError(/unknown rpc method/);
    await expect(client.call("echo-fast", undefined, { timeoutMs: 20 })).rejects.toThrowError(/unknown rpc method/);
    await expect(client.call("slow", undefined, { timeoutMs: 20 })).rejects.toThrowError(/timed out/);
    client.close();
    await server.close();
  });

  it("客户端断线：pending 全部失败", async () => {
    const sock = under(dir, "s5.sock");
    const server = new RpcServer(sock);
    server.register("hang", () => new Promise(() => undefined));
    await server.listen();
    const client = await RpcClient.connect(sock);
    const pending = client.call("hang");
    client.close();
    await expect(pending).rejects.toThrowError(/closed|EPIPE|socket/i);
    await server.close();
  });

  it("方法注册表 has()；callWithRetry 首试成功不重试", async () => {
    const sock = under(dir, "s6.sock");
    const server = new RpcServer(sock);
    server.register("echo", (p) => p);
    expect(server.has("echo")).toBe(true);
    expect(server.has("nope")).toBe(false);
    await server.listen();
    const client = await RpcClient.connect(sock);
    let attempts = 0;
    const r = await callWithRetry(
      async () => {
        attempts += 1;
        return client.call("echo", { ok: 1 });
      },
      { deadlineMs: 1_000 },
    );
    expect(attempts).toBe(1);
    expect(r).toEqual({ ok: 1 });
    client.close();
    await server.close();
  });

  it("超长 socket 路径 → 可读错误（sun_path 提示 + resolveSocketPath 回退）", async () => {
    const deep = under(
      under(under(under(under(under(dir, "very-long-directory-name-0001"), "very-long-directory-name-0002"), "very-long-directory-name-0003"), "very-long-directory-name-0004"), "very-long-directory-name-0005"),
      "coordinator.sock",
    );
    expect(deep.length).toBeGreaterThan(SUN_PATH_LIMIT);
    expect(() => new RpcServer(deep)).toThrowError(/unix socket path too long/);
    // 回退路径：候选超长 → /tmp 短路径 + registry 发现
    const teamDir = path.dirname(deep);
    const resolution = resolveSocketPath(teamDir);
    expect(resolution.fallback).toBe(true);
    expect(resolution.socketPath.length).toBeLessThanOrEqual(SUN_PATH_LIMIT);
    writeSocketRegistry(teamDir, resolution.socketPath);
    expect(discoverSocketPath(teamDir)).toBe(resolution.socketPath);
    removeSocketRegistry(teamDir);
    // 正常短路径：非回退
    const normalDir = under(dir, "team-a");
    fs.mkdirSync(normalDir, { recursive: true });
    expect(resolveSocketPath(normalDir).fallback).toBe(false);
  });
});

describe("rpc · Round-2 B3（权限 fail-closed / token / 活动 socket / 帧上限）", () => {
  it("token 启用：无 token 拒绝；正确 token 通行", async () => {
    const sock = under(dir, "t1.sock");
    const server = new RpcServer(sock, { token: "secret-token-1" });
    server.register("echo", (p) => p);
    await server.listen();
    const bad = await RpcClient.connect(sock);
    await expect(bad.call("echo", { a: 1 })).rejects.toThrowError(/unauthorized rpc frame/);
    bad.close();
    const good = await RpcClient.connect(sock, { token: "secret-token-1" });
    expect(await good.call("echo", { a: 1 })).toEqual({ a: 1 });
    good.close();
    await server.close();
  });

  it("活动 socket 拒绝覆盖：第二个 server.listen 报错且不动原 socket", async () => {
    const sock = under(dir, "t2.sock");
    const a = new RpcServer(sock);
    a.register("echo", () => "a");
    await a.listen();
    const b = new RpcServer(sock);
    await expect(b.listen()).rejects.toThrowError(/already in use/);
    // 原 server 仍可用
    const client = await RpcClient.connect(sock);
    expect(await client.call("echo")).toBe("a");
    client.close();
    await a.close();
    // 关闭后新 server 可接管
    const c = new RpcServer(sock);
    c.register("echo", () => "c");
    await c.listen();
    const client2 = await RpcClient.connect(sock);
    expect(await client2.call("echo")).toBe("c");
    client2.close();
    await c.close();
  });

  it("残留死 socket 可被清理接管；close 不删他者 inode", async () => {
    const sock = under(dir, "t3.sock");
    fs.writeFileSync(sock, ""); // 普通文件冒充死 socket
    const server = new RpcServer(sock);
    server.register("echo", () => "ok");
    await server.listen();
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    // 把 socket 移走（模拟接任者替换）→ close 不得删除新文件
    const moved = `${sock}.moved`;
    fs.renameSync(sock, moved);
    fs.writeFileSync(sock, "replacement");
    await server.close();
    expect(fs.readFileSync(sock, "utf8")).toBe("replacement");
    fs.rmSync(sock, { force: true });
    fs.rmSync(moved, { force: true });
  });

  it("帧上限：server 拒绝无换行巨帧；client 拒绝超限响应", async () => {
    const sock = under(dir, "t4.sock");
    const server = new RpcServer(sock, { maxFrameBytes: 1024 });
    server.register("big", () => "x".repeat(4096));
    server.register("echo", (p) => p);
    await server.listen();
    const client = await RpcClient.connect(sock, { maxFrameBytes: 1024 });
    const tooBig = await client.call("big").catch((e: Error) => e);
    expect(tooBig).toBeInstanceOf(Error); // 连接被毁 → 显式失败，不静默
    client.close();
    // 服务端巨帧：原始 socket 写入超限后连接被毁
    const net = await import("node:net");
    const raw = net.connect(sock);
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    raw.write(JSON.stringify({ id: 1, method: "echo", params: "y".repeat(2048) }) + "\n");
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      raw.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
    await server.close();
  });
});

describe("rpc · 协调者缺位窗口（F29 场景 3 前置）", () => {
  it("code = TEAM_DISPOSED + 区分性消息；callCoordinator 连不上 → 临时错误（含重试指引语义）", async () => {
    const err = coordinatorUnavailableError("socket x: ECONNREFUSED");
    expect(err).toBeInstanceOf(TeamError);
    expect(err.code).toBe("TEAM_DISPOSED");
    expect(err.message).toBe(COORDINATOR_UNAVAILABLE_MESSAGE);
    expect(err.message).toContain("retry");

    const teamDir = under(dir, "dead-team");
    fs.mkdirSync(teamDir, { recursive: true });
    // socket.path 指向不存在的 socket → connect ENOENT → 缺位窗口错误
    writeSocketRegistry(teamDir, under(dir, "dead.sock"));
    const rejection = await callCoordinator(teamDir, "t", "team.append", {}).catch((e: Error) => e);
    expect(rejection).toBeInstanceOf(TeamError);
    expect((rejection as TeamError).code).toBe("TEAM_DISPOSED");
    expect((rejection as TeamError).message).toBe(COORDINATOR_UNAVAILABLE_MESSAGE);
  });

  it("callWithRetry：失败→退避→成功；deadline 耗尽抛最后错误", async () => {
    let attempts = 0;
    const attemptsSeen: number[] = [];
    const result = await callWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not yet");
        return "ok";
      },
      { deadlineMs: 5_000, baseMs: 5, onRetry: (n) => attemptsSeen.push(n) },
    );
    expect(result).toBe("ok");
    expect(attemptsSeen).toEqual([1, 2]);

    let failures = 0;
    const lastError = await callWithRetry(
      async () => {
        failures += 1;
        throw new Error(`always-${failures}`);
      },
      { deadlineMs: 60, baseMs: 10, maxMs: 20 },
    ).catch((e: Error) => e);
    expect((lastError as Error).message).toMatch(/^always-\d+$/);
    expect(failures).toBeGreaterThan(1);
  });
});
