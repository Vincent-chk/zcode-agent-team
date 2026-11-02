// 〔issue #5 / D29〕Lead 套餐模型探针：三源取最新 + account:/builtin: 前缀 → blocked；
// 三源全空 / 第三方 / 读库失败 → 乐观 false（绝不误报）。夹具复用 test/provider/kit.ts。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeLeadPlanModel } from "../../src/provider/lead-model-probe.js";
import { createTestDb, insertSubmissionMessage, insertModelUsage } from "./kit.js";

let dir: string;
let dbPlan: string;
let dbThirdParty: string;
let dbEmpty: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d29-probe-"));
  dbPlan = path.join(dir, "plan.sqlite");
  dbThirdParty = path.join(dir, "third.sqlite");
  dbEmpty = path.join(dir, "empty.sqlite");
  createTestDb(dbPlan);
  createTestDb(dbThirdParty);
  createTestDb(dbEmpty);
  insertSubmissionMessage(dbPlan, {
    sessionId: "sess_probe_plan",
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3",
    timeCreated: 1_000,
  });
  insertSubmissionMessage(dbThirdParty, {
    sessionId: "sess_probe_third",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    timeCreated: 1_000,
  });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("〔D29〕probeLeadPlanModel", () => {
  it("官方套餐（account: 提交快照）→ blocked:true + model 展示串", () => {
    expect(probeLeadPlanModel("sess_probe_plan", dbPlan)).toEqual({
      blocked: true,
      model: "account:bigmodel-individual-coding-plan/GLM-5.3",
      evidence: "db",
    });
  });

  it("builtin: 前缀同样 blocked", () => {
    const db = path.join(dir, "builtin.sqlite");
    createTestDb(db);
    insertModelUsage(db, {
      sessionId: "sess_probe_builtin",
      providerId: "builtin:glm-free",
      modelId: "glm-4-flash",
      startedAt: 2_000,
    });
    expect(probeLeadPlanModel("sess_probe_builtin", db).blocked).toBe(true);
  });

  it("第三方模型 → blocked:false", () => {
    const r = probeLeadPlanModel("sess_probe_third", dbThirdParty);
    expect(r.blocked).toBe(false);
    expect(r.model).toBeUndefined();
  });

  it("三源全空（新会话首条消息前）→ 乐观 false", () => {
    expect(probeLeadPlanModel("sess_probe_nobody", dbEmpty).blocked).toBe(false);
  });

  it("库不存在 → 乐观 false（不抛错）", () => {
    expect(probeLeadPlanModel("sess_probe_any", path.join(dir, "missing.sqlite")).blocked).toBe(false);
  });

  it("三源取最新：老套餐 usage + 新第三方提交 → false；反向 → true", () => {
    const db = path.join(dir, "mix.sqlite");
    createTestDb(db);
    insertModelUsage(db, {
      sessionId: "sess_probe_mix",
      providerId: "account:plan",
      modelId: "old-model",
      startedAt: 1_000,
    });
    insertSubmissionMessage(db, {
      sessionId: "sess_probe_mix",
      providerId: "deepseek",
      modelId: "new-model",
      timeCreated: 2_000,
    });
    expect(probeLeadPlanModel("sess_probe_mix", db).blocked).toBe(false);

    const db2 = path.join(dir, "mix2.sqlite");
    createTestDb(db2);
    insertSubmissionMessage(db2, {
      sessionId: "sess_probe_mix2",
      providerId: "deepseek",
      modelId: "old-model",
      timeCreated: 1_000,
    });
    insertModelUsage(db2, {
      sessionId: "sess_probe_mix2",
      providerId: "account:plan",
      modelId: "new-model",
      startedAt: 2_000,
    });
    expect(probeLeadPlanModel("sess_probe_mix2", db2).blocked).toBe(true);
  });

  // 〔D30〕modelHint = 宿主 SessionStart 载荷 model 字段（"providerId/modelId" 扁平串）
  it("〔D30〕hint 套餐前缀 + 空库 → blocked:true（startup 全新会话路径，免 db）", () => {
    expect(probeLeadPlanModel("sess_probe_nobody", dbEmpty, "account:bigmodel-individual-coding-plan/GLM-5.3")).toEqual({
      blocked: true,
      model: "account:bigmodel-individual-coding-plan/GLM-5.3",
      evidence: "hint",
    });
    expect(probeLeadPlanModel("sess_probe_nobody", path.join(dir, "missing.sqlite"), "builtin:glm-free/glm-4-flash").blocked).toBe(true);
  });

  it("〔D30〕hint 第三方（含 db 套餐记录）→ hint 优先 → blocked:false（误报对账依据）", () => {
    const r = probeLeadPlanModel("sess_probe_plan", dbPlan, "custom:98331807/deepseek-flash");
    expect(r.blocked).toBe(false);
    expect(r.evidence).toBe("hint");
  });

  it("〔D30〕hint 空串/缺省 → 忽略，回落三源", () => {
    expect(probeLeadPlanModel("sess_probe_plan", dbPlan, "").evidence).toBe("db");
    expect(probeLeadPlanModel("sess_probe_plan", dbPlan, "   ").evidence).toBe("db");
    expect(probeLeadPlanModel("sess_probe_plan", dbPlan).evidence).toBe("db");
    // 三源全空 + 无 hint → evidence:none（撤回判定不得把「没证据」当「第三方」）
    expect(probeLeadPlanModel("sess_probe_nobody", dbEmpty)).toEqual({ blocked: false, evidence: "none" });
    // 读库失败（文件存在但非 sqlite）→ 同样 evidence:none、不抛错
    const corrupt = path.join(dir, "corrupt.sqlite");
    fs.writeFileSync(corrupt, "not a database");
    expect(probeLeadPlanModel("sess_probe_any", corrupt)).toEqual({ blocked: false, evidence: "none" });
  });
});
