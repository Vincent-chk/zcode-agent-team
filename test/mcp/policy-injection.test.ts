// F08 · 策略三层注入（stage-3 T3.3 机制层）。〔对齐轮修订 2026-10-17〕文本换版 0.2.1-alpha.5（冻结包 06 §3.1）。
// ① 定版文本保真：POLICY_TEXT = 冻结包 06 §3.1 逐字全文（含 D5 门控句删除、D4 两句替换、D3 插值），
//   唯一 ZCode 适配 = D7 冻结替换句（断言：把替换句换回原句 → 与本文件独立转写的上游原文逐字节相等）；
// ② 主通道：dist/team-hooks.mjs 在 SessionStart(startup|resume) 输出
//   hookSpecificOutput.additionalContext === SESSION_START_CONTEXT（含 F08 暗号行），
//   并落 session-map hookRegistered=true（fail-loud 判定依据）；
// ③ 辅通道：SKILL.md 含同文；④ 兜底：关键口径在工具 description 中；
// ⑤ 截断安全：注入全文 < 24000 字符（H14 单条上限）。
// 真实会话暗号复述（startup/resume 两路）+ hook 禁用场景归 T3.5c 实机取证。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  teamPolicy,
  POLICY_TEXT,
  SESSION_START_CONTEXT,
  buildSessionStartContext,
  IDENTITY_LEAD_TEXT,
  identityTeammateText,
  POLICY_PROBE_MARKER,
  HOOK_POLICY_PREFIX,
  D7_ORIGINAL_SENTENCE,
  D7_REPLACEMENT_SENTENCE,
  FAIL_LOUD_WARNING,
  NO_PROGRESS_MESSAGE,
  ORCHESTRATOR_SECTION_TEXT,
} from "../../src/mcp/policy.js";
import { TEAM_TOOL_DEFINITIONS } from "../../src/mcp/tools.js";
import { readSessionRegistry, safeSessionKey, upsertSessionEntry } from "../../src/mcp/identity.js";
import { readHostLeadModeOverride } from "../../src/shared.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const HOOKS = path.join(PROJ, "dist", "team-hooks.mjs");

/** 上游 0.2.1-alpha.5 策略全文独立转写（冻结包 06 §3.1，含 D7 原句 FS_STALE_VERSION；用于保真断言）。 */
const SPEC_POLICY_VERBATIM =
  `Agent Teams is available in this session\n` +
  `\n` +
  `The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.\n` +
  `\n` +
  `Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.\n` +
  `\n` +
  `Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`;

describe("定版文本保真（三层同源）", () => {
  it("POLICY_TEXT = 冻结包 06 §3.1 逐字，唯一差异 = D7 冻结替换句", () => {
    // 把 D7 替换句换回原句 → 与上游原文逐字节相等（证明「其余段落逐字保留」）
    const restored = POLICY_TEXT.replace(D7_REPLACEMENT_SENTENCE, D7_ORIGINAL_SENTENCE);
    expect(restored).toBe(SPEC_POLICY_VERBATIM);
    // 替换句只出现一次；原句（FS_STALE_VERSION）不残留
    expect(POLICY_TEXT.split(D7_REPLACEMENT_SENTENCE)).toHaveLength(2);
    expect(POLICY_TEXT).not.toContain("FS_STALE_VERSION");
    expect(SPEC_POLICY_VERBATIM).toContain("FS_STALE_VERSION");
  });

  it("D5 门控句已删除、D4 两句替换生效（0.2.1 换版断言）", () => {
    expect(POLICY_TEXT.startsWith("Agent Teams is available in this session\n")).toBe(true);
    expect(POLICY_TEXT).not.toContain("but create teammates only when the user explicitly asks");
    expect(POLICY_TEXT).toContain("A peer message starts with its sender name.");
    expect(POLICY_TEXT).toContain("A successful send does not mean the recipient has processed it.");
    expect(POLICY_TEXT).not.toContain("A delivered peer item starts with its stable message id");
    expect(POLICY_TEXT).not.toContain("do not resend it");
  });

  it("D3 插值：interrupt=false → 策略去掉 ' and interrupt_agent'（其余逐字相同）", () => {
    const withInterrupt = teamPolicy(true);
    const without = teamPolicy(false);
    expect(withInterrupt).toBe(POLICY_TEXT);
    expect(withInterrupt).toContain("for send_message and interrupt_agent, or as owner");
    expect(without).toContain("for send_message, or as owner");
    expect(without).not.toContain("and interrupt_agent");
    // 除该插值点外逐字相同
    expect(withInterrupt.replace(" and interrupt_agent", "")).toBe(without);
  });

  it("noProgress 常量 = 02 §8 逐字（捷径文本单一来源）", () => {
    expect(NO_PROGRESS_MESSAGE).toBe(
      "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.",
    );
  });

  it("注入全文 < 24000 字符（H14 单条截断上限；策略约 2K）", () => {
    expect(SESSION_START_CONTEXT.length).toBeLessThan(24_000);
    expect(SESSION_START_CONTEXT.length).toBeGreaterThan(1_500);
    expect(SESSION_START_CONTEXT.startsWith(`${HOOK_POLICY_PREFIX} `)).toBe(true);
    expect(SESSION_START_CONTEXT).toContain(POLICY_TEXT);
    // 生产默认不注入探针；只有 TEAM_POLICY_PROBE=1 才追加（F08 取证时显式开启）。
    expect(SESSION_START_CONTEXT).not.toContain(POLICY_PROBE_MARKER);
    const prev = process.env.TEAM_POLICY_PROBE;
    process.env.TEAM_POLICY_PROBE = "1";
    try {
      expect(buildSessionStartContext(IDENTITY_LEAD_TEXT)).toContain(POLICY_PROBE_MARKER);
    } finally {
      if (prev === undefined) delete process.env.TEAM_POLICY_PROBE;
      else process.env.TEAM_POLICY_PROBE = prev;
    }
  });

  it("〔对齐轮 D2/F03〕team:identity 两分支逐字（冻结包 06 §3.2；无 system-reminder 包装、无前导/尾随换行）", () => {
    // Lead 分支（逐字转写自冻结包 06 §3.2）
    expect(IDENTITY_LEAD_TEXT).toBe(
      `You are the Team Lead named "lead".\n` +
        `Use list_agents({}) to find your teammates and their names.\n` +
        `To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`,
    );
    // teammate 分支（${name} 替换）
    expect(identityTeammateText("reviewer")).toBe(
      `You are teammate "reviewer".\n` +
        `Your Team Lead is named "lead".\n` +
        `To message your Team Lead, use send_message({ target: "lead", message: "..." }).\n` +
        `Use list_agents({}) to find your teammates and their names.\n` +
        `To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`,
    );
    // 字节级事实：两分支均无 <system-reminder> 包装、无前导/尾随换行
    for (const text of [IDENTITY_LEAD_TEXT, identityTeammateText("x")]) {
      expect(text).not.toContain("<system-reminder>");
      expect(text.startsWith("\n")).toBe(false);
      expect(text.endsWith("\n")).toBe(false);
    }
    // SESSION_START_CONTEXT = 策略 + Lead 身份 + 编排段（默认 orchestrator）+ 暗号（〔agent-team〕 前缀块）
    expect(SESSION_START_CONTEXT).toBe(buildSessionStartContext(IDENTITY_LEAD_TEXT, true, "orchestrator"));
    expect(SESSION_START_CONTEXT).toContain(IDENTITY_LEAD_TEXT);
  });

  it("辅通道 SKILL.md 含策略同文（逐字节包含）", () => {
    const skill = fs.readFileSync(path.join(PROJ, "skills", "team-coordination", "SKILL.md"), "utf8");
    for (const paragraph of POLICY_TEXT.split("\n\n")) {
      expect(skill, `SKILL.md 缺段落：${paragraph.slice(0, 60)}…`).toContain(paragraph);
    }
    expect(skill).toMatch(/^name: team-coordination$/m);
    // frontmatter description 触发词覆盖（T3.3）
    const description = skill.split("\n").find((l) => l.startsWith("description:"))!;
    for (const trigger of ["团队", "teammate", "协作", "任务"]) {
      expect(description, `description 缺触发词 ${trigger}`).toContain(trigger);
    }
  });

  it("兜底层：关键口径压缩进工具 description（不超必要）", () => {
    const byName = new Map(TEAM_TOOL_DEFINITIONS.map((t) => [t.name, t.description]));
    expect(byName.get("spawn_teammate")).toContain("Only the Team Lead may call this tool.");
    // 〔对齐轮〕0.2.1 send_message 描述（"durable" 已删）
    expect(byName.get("send_message")).toContain("Send one message to another Team member.");
    expect(byName.get("send_message")).toContain("nearest step boundary");
    expect(byName.get("list_agents")).toContain("inactive means no turn is executing");
    expect(byName.get("wait_agent")).toContain("never wakes inactive members");
    expect(byName.get("wait_agent")).toContain("noProgress immediately");
    expect(byName.get("wait_agent")).toContain("Re-list after wakeup or timeout");
    expect(byName.get("interrupt_agent")).toContain("preserving its pending inbox");
    expect(byName.get("interrupt_agent")).toContain("Team Lead only");
    expect(byName.get("team_task_update")).toContain("latest revision");
    // description 兜底总量不膨胀（与原版「固定政策 + schema」成本口径对齐）
    const total = [...byName.values()].reduce((sum, d) => sum + d!.length, 0);
    expect(total).toBeLessThan(2_000);
  });
});

describe("〔stage-6.5 D26〕Lead 编排模式附加段（分层注入）", () => {
  it("orchestrator：Lead 注入含编排段；定版常量 = 默认模式；禁词与长度红线", () => {
    const ctx = buildSessionStartContext(IDENTITY_LEAD_TEXT, true, "orchestrator");
    expect(ctx).toContain(ORCHESTRATOR_SECTION_TEXT);
    expect(SESSION_START_CONTEXT).toBe(ctx);
    // 红线：编排段不得引入 interrupt_agent / do not resend（text-audit #4 / audit-fixes 检查面）
    expect(ORCHESTRATOR_SECTION_TEXT).not.toContain("interrupt_agent");
    expect(ORCHESTRATOR_SECTION_TEXT).not.toContain("do not resend");
    expect(ctx.length).toBeLessThan(24_000);
  });

  it("collaborator / 未传 leadMode：不注入编排段，与扩展前逐字节一致（回归面为零）", () => {
    const legacy = `${HOOK_POLICY_PREFIX} ${POLICY_TEXT}\n${HOOK_POLICY_PREFIX} ${IDENTITY_LEAD_TEXT}`;
    expect(buildSessionStartContext(IDENTITY_LEAD_TEXT, true, "collaborator")).toBe(legacy);
    expect(buildSessionStartContext(IDENTITY_LEAD_TEXT, true)).toBe(legacy);
    expect(buildSessionStartContext(IDENTITY_LEAD_TEXT, true, "collaborator")).not.toContain(
      "Lead operating mode",
    );
  });

  it("编排段进 SKILL.md 辅通道（逐字包含）", () => {
    const skill = fs.readFileSync(path.join(PROJ, "skills", "team-coordination", "SKILL.md"), "utf8");
    expect(skill).toContain(ORCHESTRATOR_SECTION_TEXT);
  });

  it("编排段在身份段之后、探针之前（TEAM_POLICY_PROBE=1 时的顺序契约）", () => {
    const prev = process.env.TEAM_POLICY_PROBE;
    process.env.TEAM_POLICY_PROBE = "1";
    try {
      const ctx = buildSessionStartContext(IDENTITY_LEAD_TEXT, true, "orchestrator");
      const identityAt = ctx.indexOf(IDENTITY_LEAD_TEXT);
      const sectionAt = ctx.indexOf(ORCHESTRATOR_SECTION_TEXT);
      const probeAt = ctx.indexOf(POLICY_PROBE_MARKER);
      expect(identityAt).toBeLessThan(sectionAt);
      expect(sectionAt).toBeLessThan(probeAt);
    } finally {
      if (prev === undefined) delete process.env.TEAM_POLICY_PROBE;
      else process.env.TEAM_POLICY_PROBE = prev;
    }
  });
});

describe("主通道 · SessionStart hook 注入（startup/resume 双注入点）", () => {
  let dataRoot: string;

  beforeAll(() => {
    expect(fs.existsSync(HOOKS), "dist/team-hooks.mjs 缺失——先 npm run build").toBe(true);
    dataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-hook-"));
  });

  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  function runHook(
    input: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [HOOKS],
        {
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            TEAM_PLUGIN_DATA: dataRoot,
            ZCODE_SESSION_ID: typeof input.session_id === "string" ? input.session_id : "",
            ...extraEnv,
          },
        },
        (err, stdout, stderr) => {
          if (err !== null) return reject(err);
          resolve({ stdout, stderr });
        },
      );
      child.stdin!.write(JSON.stringify(input));
      child.stdin!.end();
    });
  }

  it("startup：additionalContext = 定版注入全文；session-map hookRegistered=true", async () => {
    const { stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "sess_hook_startup",
      source: "startup",
      cwd: dataRoot,
    });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(SESSION_START_CONTEXT);
    const entry = readSessionRegistry(dataRoot)[safeSessionKey("sess_hook_startup")]!;
    expect(entry.hookRegistered).toBe(true);
    expect(entry.session_id).toBe("sess_hook_startup");
    expect(typeof entry.firstSeen).toBe("string");
  });

  it("resume：同样注入（双注入点；firstSeen 不被刷新）", async () => {
    const { stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "sess_hook_startup",
      source: "resume",
      cwd: dataRoot,
    });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toBe(SESSION_START_CONTEXT);
    const entry = readSessionRegistry(dataRoot)[safeSessionKey("sess_hook_startup")]!;
    expect(entry.hookRegistered).toBe(true);
    expect(entry.event).toBe("sessionstart");
    expect(typeof entry.lastSeen).toBe("string");
  });

  it("hook 触发日志留证（logs/hooks.jsonl 含 session_id 与 env overlay）", async () => {
    const lines = fs
      .readFileSync(path.join(dataRoot, "logs", "hooks.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const last = lines[lines.length - 1]!;
    expect(last.event).toBe("sessionstart");
    expect(last.input_session_id).toBe("sess_hook_startup");
    expect(last.env_session_id).toBe("sess_hook_startup"); // env overlay 第二来源（H1）
  });

  it("fail-loud 警告行定版文本（D10；工具结果尾部附加，不改 schema）", () => {
    expect(FAIL_LOUD_WARNING).toContain("未检测到本会话的策略注入");
    expect(FAIL_LOUD_WARNING).toContain("[agent-team]");
    expect(FAIL_LOUD_WARNING.startsWith("[agent-team] 警告：")).toBe(true);
  });

  it("〔对齐轮 D2〕teammate 会话（session-map 有映射）→ 注入 teammate 身份分支；无映射 → Lead 分支", async () => {
    // 预置 teammate 映射（provider 于 spawn 落盘的等价形态）
    upsertSessionEntry(dataRoot, "sess_teammate_hook", {
      firstSeen: new Date().toISOString(),
      hookRegistered: true,
      teamId: "sess_lead_hook",
      role: "teammate",
      name: "reviewer",
      memberId: "member-abc",
    });
    const { stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "sess_teammate_hook",
      source: "resume",
      cwd: dataRoot,
    });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toBe(buildSessionStartContext(identityTeammateText("reviewer")));
    expect(ctx).toContain('You are teammate "reviewer".');
    expect(ctx).not.toContain('You are the Team Lead named "lead".');
    expect(ctx).not.toContain(POLICY_PROBE_MARKER); // 生产默认无探针
    expect(ctx).not.toContain(ORCHESTRATOR_SECTION_TEXT); // 〔D26〕teammate 恒不注入编排段
  });

  it("〔stage-6.5 D26〕TEAM_LEAD_MODE env 变体：orchestrator 注入 / collaborator 不注入 / 非法值回落默认", async () => {
    const cases = [
      ["orchestrator", true],
      ["collaborator", false],
      ["bogus-mode", true],
      ["", true],
    ] as const;
    for (const [envValue, expectSection] of cases) {
      const { stdout } = await runHook(
        {
          hook_event_name: "SessionStart",
          session_id: `sess_lead_mode_${envValue || "empty"}`,
          source: "startup",
          cwd: dataRoot,
        },
        { TEAM_LEAD_MODE: envValue },
      );
      const parsed = JSON.parse(stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      const ctx = parsed.hookSpecificOutput.additionalContext;
      if (expectSection) {
        expect(ctx, `TEAM_LEAD_MODE=${JSON.stringify(envValue)} 应含编排段`).toContain(
          ORCHESTRATOR_SECTION_TEXT,
        );
      } else {
        expect(ctx, `TEAM_LEAD_MODE=${JSON.stringify(envValue)} 不应含编排段`).not.toContain(
          ORCHESTRATOR_SECTION_TEXT,
        );
      }
    }
  });

  it("〔stage-6.5 D26〕teammate 会话即使 TEAM_LEAD_MODE=orchestrator 也不注入编排段（Lead-only 门控）", async () => {
    const { stdout } = await runHook(
      {
        hook_event_name: "SessionStart",
        session_id: "sess_teammate_hook",
        source: "resume",
        cwd: dataRoot,
      },
      { TEAM_LEAD_MODE: "orchestrator" },
    );
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(ORCHESTRATOR_SECTION_TEXT);
  });

  it("〔stage-6.5 D26〕runtime-config 文件兜底：leadMode=collaborator 落盘 → 无 env 时不注入；旧文件缺字段 → 回落 orchestrator", async () => {
    const metaDir = path.join(dataRoot, "meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const limits = { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 };
    // ① 新版文件（含 leadMode: collaborator）→ hook 无 env 时走文件 → 不注入编排段
    fs.writeFileSync(
      path.join(metaDir, "runtime-config.json"),
      JSON.stringify({ version: 1, interrupt: true, leadMode: "collaborator", limits, updatedAt: new Date().toISOString() }),
    );
    let { stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "sess_lead_file_collab",
      source: "startup",
      cwd: dataRoot,
    });
    let ctx = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain(ORCHESTRATOR_SECTION_TEXT);
    // ② 旧版文件（无 leadMode 字段，扩展前 daemon 写的形态）→ v1 兼容回落默认 → 注入编排段
    fs.writeFileSync(
      path.join(metaDir, "runtime-config.json"),
      JSON.stringify({ version: 1, interrupt: true, limits, updatedAt: new Date().toISOString() }),
    );
    ({ stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "sess_lead_file_legacy",
      source: "startup",
      cwd: dataRoot,
    }));
    ctx = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(ORCHESTRATOR_SECTION_TEXT);
  });

  // 〔stage-6.5 R2，2026-10-24〕宿主 config.json 直读回落层：消除首会话时序限制（撤销 D26 已知限制）。
  describe("R2 · host config 直读回落层", () => {
    const mkHome = (options: unknown): string => {
      const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-r2-home-"));
      fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
      fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), JSON.stringify({ plugins: { options } }));
      return home;
    };

    it("纯函数矩阵：单键合法 / 无值 / 垃圾值 / 多键一致 / 多键冲突 / 非本插件键 / 文件缺失", () => {
      expect(readHostLeadModeOverride(mkHome({ "agent-team@inline": { leadMode: "collaborator" } }))).toBe("collaborator");
      expect(readHostLeadModeOverride(mkHome({ "agent-team@inline": { leadMode: "orchestrator" } }))).toBe("orchestrator");
      expect(readHostLeadModeOverride(mkHome({}))).toBeUndefined();
      expect(readHostLeadModeOverride(mkHome({ "agent-team@inline": {} }))).toBeUndefined();
      expect(readHostLeadModeOverride(mkHome({ "agent-team@inline": { leadMode: "bogus" } }))).toBeUndefined();
      expect(
        readHostLeadModeOverride(
          mkHome({ "agent-team@inline": { leadMode: "collaborator" }, "agent-team@dirs:x": { leadMode: "collaborator" } }),
        ),
      ).toBe("collaborator");
      expect(
        readHostLeadModeOverride(
          mkHome({ "agent-team@inline": { leadMode: "collaborator" }, "agent-team@dirs:x": { leadMode: "orchestrator" } }),
        ),
      ).toBeUndefined();
      expect(readHostLeadModeOverride(mkHome({ "other-plugin": { leadMode: "collaborator" } }))).toBeUndefined();
      expect(readHostLeadModeOverride(path.join(fs.realpathSync(os.tmpdir()), `at-r2-missing-${Date.now()}`))).toBeUndefined();
    });

    it("hook 层优先级①：HOME 指向 collaborator 配置 → 无 env 无 runtime-config 也不注入编排段（优先于默认）", async () => {
      const home = mkHome({ "agent-team@inline": { leadMode: "collaborator" } });
      const metaDir = path.join(dataRoot, "meta");
      fs.rmSync(path.join(metaDir, "runtime-config.json"), { force: true });
      const { stdout } = await runHook(
        { hook_event_name: "SessionStart", session_id: "sess_r2_host_only", source: "startup", cwd: dataRoot },
        { HOME: home },
      );
      const ctx = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain(ORCHESTRATOR_SECTION_TEXT);
    });

    it("hook 层优先级②：host config（collaborator）优先于 runtime-config（orchestrator）", async () => {
      const home = mkHome({ "agent-team@inline": { leadMode: "collaborator" } });
      const metaDir = path.join(dataRoot, "meta");
      fs.mkdirSync(metaDir, { recursive: true });
      const limits = { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 };
      fs.writeFileSync(
        path.join(metaDir, "runtime-config.json"),
        JSON.stringify({ version: 1, interrupt: true, leadMode: "orchestrator", limits, updatedAt: new Date().toISOString() }),
      );
      const { stdout } = await runHook(
        { hook_event_name: "SessionStart", session_id: "sess_r2_host_over_file", source: "startup", cwd: dataRoot },
        { HOME: home },
      );
      const ctx = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain(ORCHESTRATOR_SECTION_TEXT);
    });

    it("hook 层优先级③：无 host 覆盖时 runtime-config（orchestrator）生效（注入编排段）", async () => {
      // HOME 指向干净 fixture（无 agent-team 选项）→ host 层 undefined → runtime-config 显式 orchestrator 生效
      const cleanHome = mkHome({});
      const metaDir = path.join(dataRoot, "meta");
      fs.mkdirSync(metaDir, { recursive: true });
      const limits = { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 };
      fs.writeFileSync(
        path.join(metaDir, "runtime-config.json"),
        JSON.stringify({ version: 1, interrupt: true, leadMode: "orchestrator", limits, updatedAt: new Date().toISOString() }),
      );
      const { stdout } = await runHook(
        { hook_event_name: "SessionStart", session_id: "sess_r2_file_orch", source: "startup", cwd: dataRoot },
        { HOME: cleanHome },
      );
      const ctx = (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(ORCHESTRATOR_SECTION_TEXT);
    });
  });
});
