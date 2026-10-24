// B：环境自检探针——tmpdir 必须全绿（自动化断言）；另对工程卷 /Volumes/Lexar 跑一次并记录
//（不阻塞；探针目录自建自清，不留垃圾）。
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProbes, startupFsCheck } from "../../../src/coord/fscheck.js";

const evidence: Record<string, unknown> = {};
const projectRoot = "/Volumes/Lexar/deepseek扩展开发/agent-team";

afterAll(() => {
  const dir = path.join(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fscheck.json"), JSON.stringify(evidence, null, 2));
});

describe("fscheck · 三探针", () => {
  it("tmpdir 探针全绿（原子追加 / 独占锁 / fsync-kill 完整性）", { timeout: 60_000 }, async () => {
    const report = await runProbes(fs.realpathSync(os.tmpdir()));
    for (const r of report.results) {
      expect(r.ok, `${r.probe}: ${r.detail}`).toBe(true);
    }
    expect(report.ok).toBe(true);
    evidence.tmpdir = report.results.map((r) => ({ probe: r.probe, ok: r.ok, ms: r.ms, detail: r.detail }));
    console.log(`[fscheck] tmpdir: ${report.results.map((r) => `${r.probe}=${r.ok}(${r.ms}ms)`).join(" ")}`);
  });

  it("工程卷 /Volumes/Lexar 同一探针（记录，不阻塞）", { timeout: 60_000 }, async () => {
    const report = await runProbes(projectRoot);
    evidence.projectVolume = {
      root: projectRoot,
      ok: report.ok,
      results: report.results.map((r) => ({ probe: r.probe, ok: r.ok, ms: r.ms, detail: r.detail })),
    };
    console.log(
      `[fscheck] ${projectRoot}: ${report.ok ? "ALL GREEN" : "LIMITED"} — ${report.results
        .map((r) => `${r.probe}=${r.ok ? "ok" : "FAIL"}(${r.ms}ms)`)
        .join(" ")}`,
    );
    // 不断言（登记口径）；但必须确无残留
    expect(fs.readdirSync(projectRoot).some((f) => f.startsWith(".fscheck-"))).toBe(false);
  });

  it("startupFsCheck：健康根 → null；异常根 → 可读告警（daemon 启动告警路径）", { timeout: 60_000 }, async () => {
    expect(await startupFsCheck(fs.realpathSync(os.tmpdir()))).toBeNull();
    // 指向一个文件（mkdir 探针目录会失败）→ errored 可读告警
    const notADir = path.join(fs.realpathSync(os.tmpdir()), "at-fscheck-notadir.txt");
    fs.writeFileSync(notADir, "x");
    const warning = await startupFsCheck(notADir);
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/fs self-check/);
    fs.unlinkSync(notADir);
  });
});
