// Phase 0 回归：真实 spawn env 不被脱敏；spec 不落明文 secret；落盘模式；meta 路径白名单。
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnDetached } from "../../src/provider/procgroup.js";
import { writeJsonAtomic } from "../../src/provider/member-files.js";
import { ensurePrivateDir, metaFilePath, redactToolArguments, sanitizeToolName } from "../../src/shared.js";
import { PanelViewService, snapshotFile } from "../../src/panel/view-service.js";
import { emptyViewFrame } from "../../src/ui-core/view.js";
import { teamPaths } from "../../src/coord/paths.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-phase0-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timeout");
}

describe("Phase 0 spawn env", () => {
  it("子进程收到真实 env；spec 不含明文 secret 且读后删除；stdout 文件 0600", async () => {
    const dir = tmpDir();
    const stdoutFile = path.join(dir, "env.out");
    const secret = "sk-phase0-test-secret-9f1";
    const spawned = await spawnDetached({
      command: process.execPath,
      argv: ["-e", "process.stdout.write(process.env.AT_SPAWN_SECRET ?? 'missing')"],
      env: { ...process.env, AT_SPAWN_SECRET: secret },
      cwd: dir,
      stdoutFile,
    });

    await waitFor(() => fs.existsSync(stdoutFile) && fs.readFileSync(stdoutFile, "utf8").includes(secret));
    expect(fs.readFileSync(stdoutFile, "utf8")).toBe(secret);
    expect(fs.statSync(stdoutFile).mode & 0o777).toBe(0o600);

    // helper 读后立即删除 spec；若崩溃残留，也不得出现明文 secret。
    const specText = fs.existsSync(spawned.specFile) ? fs.readFileSync(spawned.specFile, "utf8") : "";
    expect(specText.includes(secret)).toBe(false);
  });

  it("persistEnv 默认 false 不写 env；true 时按调用方给定（脱敏后）内容落盘", async () => {
    const dir = tmpDir();
    const captured = path.join(dir, "captured.json");
    const helper = path.join(dir, "capture-helper.mjs");
    fs.writeFileSync(
      helper,
      [
        'import fs from "node:fs";',
        "const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
        "fs.writeFileSync(process.env.CAPTURE_TO, JSON.stringify(spec), { mode: 0o600 });",
        "fs.writeFileSync(spec.resultFile, JSON.stringify({ pid: null }), { mode: 0o600 });",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const previousHelper = process.env.TEAM_DETACH_HELPER;
    process.env.TEAM_DETACH_HELPER = helper;
    try {
      await spawnDetached({
        command: process.execPath,
        argv: ["-e", ""],
        env: { ...process.env, CAPTURE_TO: captured, AT_SECRET: "sk-live-secret" },
        cwd: dir,
        stdoutFile: path.join(dir, "a.out"),
      });
      const first = JSON.parse(fs.readFileSync(captured, "utf8")) as { env?: unknown };
      expect(first.env).toBeUndefined();

      fs.rmSync(captured, { force: true });
      await spawnDetached({
        command: process.execPath,
        argv: ["-e", ""],
        env: { ...process.env, CAPTURE_TO: captured, AT_SECRET: "<redacted>" },
        cwd: dir,
        stdoutFile: path.join(dir, "b.out"),
        persistEnv: true,
      });
      const second = JSON.parse(fs.readFileSync(captured, "utf8")) as { env?: Record<string, string> };
      expect(second.env?.AT_SECRET).toBe("<redacted>");
    } finally {
      if (previousHelper === undefined) delete process.env.TEAM_DETACH_HELPER;
      else process.env.TEAM_DETACH_HELPER = previousHelper;
    }
  });
});

describe("Phase 0 meta 落盘白名单", () => {
  it("非法工具名不落盘；合法名限制在 meta/ 目录内", () => {
    const root = tmpDir();
    expect(sanitizeToolName("../evil")).toBe("unknown-tool");
    expect(sanitizeToolName("a/b")).toBe("unknown-tool");
    expect(sanitizeToolName("team_ping")).toBe("team_ping");
    expect(metaFilePath(root, "../evil")).toBeNull();
    expect(metaFilePath(root, "/tmp/evil")).toBeNull();

    const file = metaFilePath(root, "team_ping", 123);
    expect(file).not.toBeNull();
    expect(path.dirname(file!)).toBe(path.resolve(root, "meta"));
    expect(path.basename(file!)).toMatch(/^team_ping-123-[a-z0-9]+\.json$/);
  });

  it("arguments 脱敏：正文只留长度、敏感键替换、长串截断", () => {
    const redacted = redactToolArguments({
      message: "secret body",
      apiKey: "k-123",
      note: "x".repeat(300),
      nested: { token: "t-1" },
    }) as Record<string, unknown>;
    expect(redacted.message).toEqual({ redacted: true, chars: 11 });
    expect(redacted.apiKey).toBe("<redacted>");
    expect((redacted.note as string).length).toBeLessThan(300);
    expect((redacted.nested as Record<string, unknown>).token).toBe("<redacted>");
  });
});

describe("Phase 0 落盘模式", () => {
  it("私有目录 0700；JSON 与面板快照 0600", () => {
    const root = tmpDir();
    const data = path.join(root, "data");
    ensurePrivateDir(data);
    expect(fs.statSync(data).mode & 0o777).toBe(0o700);

    const file = path.join(data, "x.json");
    writeJsonAtomic(file, { ok: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const service = new PanelViewService({
      backend: {} as never,
      dataRoot: data,
      bootTimeMs: 0,
    });
    const teamId = "team-mode";
    service.writeSnapshot(teamId, emptyViewFrame("2026-10-20T00:00:00.000Z"));
    const snapshot = snapshotFile(teamPaths(data, teamId).teamDir);
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(snapshot)).mode & 0o777).toBe(0o700);
  });
});
