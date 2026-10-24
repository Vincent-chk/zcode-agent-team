// team-ctl open-panel 单测（T5.5 入口；注册文件读取/校验/端口探活/指引文案）。
// 浏览器打开分支（launchBrowser）不在 node 单测面——noOpen 路径覆盖判定逻辑。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPanel } from "../../src/cli/open-panel.js";
import { COMPANION_REGISTRY_RELPATH } from "../../src/panel/companion-server.js";

let root: string;

/** 夹具路径边界（测试纪律：写入必须落在 root 内）。 */
function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-open-panel-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRegistry(body: unknown): void {
  const file = under(root, COMPANION_REGISTRY_RELPATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

describe("openPanel", () => {
  it("无注册文件 → ok:false + TEAM_COMPANION 指引", async () => {
    const r = await openPanel({ dataRoot: root, noOpen: true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("TEAM_COMPANION=1");
  });

  it("注册文件损坏 → ok:false（内容非法）", async () => {
    writeRegistry("{corrupt");
    const r = await openPanel({ dataRoot: root, noOpen: true });
    expect(r.ok).toBe(false);
  });

  it("port/token 类型或格式非法 → ok:false", async () => {
    writeRegistry({ port: "8080", token: "x" });
    expect((await openPanel({ dataRoot: root, noOpen: true })).ok).toBe(false);
    writeRegistry({ port: 99999, token: "0".repeat(32) });
    expect((await openPanel({ dataRoot: root, noOpen: true })).ok).toBe(false);
    writeRegistry({ port: 8080, token: "not-hex-zzzzzzzzzzzzzzzzzzzzzzzz" });
    expect((await openPanel({ dataRoot: root, noOpen: true })).ok).toBe(false);
  });

  it("端口未监听 → ok:false + 重启指引", async () => {
    // 取一个几乎必然空闲的端口（先 bind 后 release）
    const probe = http.createServer();
    await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((res) => probe.close(() => res()));
    writeRegistry({ port, token: "a".repeat(32), pid: process.pid });
    const r = await openPanel({ dataRoot: root, noOpen: true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("未监听");
  });

  it("端口监听中 → ok:true + 回环 URL（含 token）", async () => {
    const srv = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as { port: number }).port;
    writeRegistry({ port, token: "b".repeat(32), pid: process.pid });
    const r = await openPanel({ dataRoot: root, noOpen: true });
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`http://127.0.0.1:${port}/panel?token=${"b".repeat(32)}`);
    expect(r.port).toBe(port);
    await new Promise<void>((res) => srv.close(() => res()));
  });
});
