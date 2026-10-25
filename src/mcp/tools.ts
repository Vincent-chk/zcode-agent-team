// 9 个模型工具的字面定义（stage-3 T3.2；02 规格 §9.3–§9.12 逐字；0.4.0 注销 §9.13 member_set_model，
// spawn 的 model/thoughtLevel 参数同步移除——成员模型唯一路线 = 每轮跟随 Lead 最新已确认选择）。
// name / description / 参数描述 / required / enum / additionalProperties:false 全量对齐规格原文；
// 本文件是 tools/list 快照（F01）与期望 JSON 生成器的唯一来源（同一序列化器口径）。
//
// 〔登记〕outputSchema 不在条目中声明：宿主对工具条目 outputSchema 的校验要求 object 型
// （list_agents 输出为 MEMBER_VIEW 数组，无法原样声明）；输出契约由 F02 行为契约测试保证
// （MEMBER_VIEW/TASK_VIEW 字段集与 02 §9.4 一致 + 紧凑 JSON）。F01 断言范围（验收标准）
// = name/description/inputSchema 全字段，与此一致。
//
// 〔F13〕spawn_teammate 条目携带 `_meta.ui`（resourceUri + surface）：宿主在 tools/list 时
// 解析该字段（bundle Wyn→AAr→sin 路径，2026-10-16 现场核实），调用结果按 MCP App widget
// 呈现并携 surface 定向打开提示（surface id = plugin.json ui.surfaces 声明的 agent-team-panel）。
// 不改变结果 JSON 契约（F02）；桌面实录归 T3.5/F13（受限按注记口径移交 stage-5 F11）。

/** 02 §9.4 MEMBER_VIEW（输出 schema 参考形状；契约测试用）。 */
export const MEMBER_VIEW_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string" },
    role: { type: "string", enum: ["lead", "teammate"] },
    status: { type: "string", enum: ["running", "inactive", "provisioning", "failed"] },
    description: { type: "string" },
    provider: { type: "string" },
    context: { type: "string", enum: ["fresh", "fork"] },
    model: { type: "string" },
    diagnostics: { type: "array", items: { type: "string" } },
  },
  required: ["target", "role", "status", "diagnostics"],
  additionalProperties: false,
} as const;

/** 02 §9.4 TASK_VIEW（输出 schema 参考形状；契约测试用）。 */
export const TASK_VIEW_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    revision: { type: "integer" },
    subject: { type: "string" },
    description: { type: "string" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
    ownerName: { type: "string" },
    blockedBy: { type: "array", items: { type: "string" } },
    writeScopes: { type: "array", items: { type: "string" } },
    ready: { type: "boolean" },
    writeScopeWarnings: { type: "array", items: { type: "string" } },
  },
  required: ["id", "revision", "subject", "description", "status", "blockedBy", "writeScopes", "ready", "writeScopeWarnings"],
  additionalProperties: false,
} as const;

/** F13 定向打开提示（接口草案 §5；宿主定义侧 _meta.ui 形态，bundle 现场核实）。 */
export const PANEL_RESOURCE_URI = "ui://agent-team/team-panel.html";
export const PANEL_SURFACE_ID = "agent-team-panel";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** 9 工具注册表（顺序 = stage-3 任务书列举序；0.4.0 注销 member_set_model；快照与 tools/list 同源）。 */
export const TEAM_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    // 02 §9.3
    name: "spawn_teammate",
    description:
      "Create one named, durable teammate. Only the Team Lead may call this tool. In orchestrator mode, create teammates proactively when the goal benefits from delegation, within the member limit. The teammate automatically follows the Lead's latest confirmed model and reasoning level on every turn; there is no per-member model option.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique lower-kebab-case teammate name." },
        description: { type: "string", description: "Short description of the delegated responsibility." },
        prompt: { type: "string", description: "Complete initial task for the teammate." },
        context: {
          type: "string",
          enum: ["fresh", "fork"],
          description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.",
        },
      },
      required: ["name", "description", "prompt"],
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: PANEL_RESOURCE_URI, surface: PANEL_SURFACE_ID },
    },
  },
  {
    // 02 §9.5（〔对齐轮〕0.2.1 描述：删 "durable"、"durable message"→"message"）
    name: "send_message",
    description:
      "Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Member target returned by spawn_teammate or list_agents, including lead.",
        },
        message: { type: "string", description: "Self-contained message for the target." },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
  },
  {
    // 02 §9.6
    name: "list_agents",
    description:
      "List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    // 02 §9.8
    name: "interrupt_agent",
    description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Teammate target returned by spawn_teammate or list_agents.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  // 0.4.0 注销 member_set_model（02 §9.13）：成员模型没有独立配置通道，唯一路线 = 每轮
  // 跟随 Lead 最新已确认选择；原规格条目见 traceability §18 与 git 历史。
  {
    // 02 §9.7（〔对齐轮〕0.2.1 描述："mailbox"→"message"）
    name: "wait_agent",
    description:
      "Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "integer",
          description: "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    // 02 §9.9
    name: "team_task_create",
    description: "Create one unowned pending task on the shared Team task board.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Concise task title." },
        description: { type: "string", description: "Complete task details and acceptance criteria." },
        blocked_by: { type: "array", items: { type: "string" }, description: "Task ids that must complete first." },
        write_scopes: {
          type: "array",
          items: { type: "string" },
          description: "Advisory workspace-relative file or directory prefixes this task expects to modify.",
        },
      },
      required: ["subject", "description"],
      additionalProperties: false,
    },
  },
  {
    // 02 §9.10
    name: "team_task_list",
    description: "List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "Optional exact status filter.",
        },
        owner: {
          type: "string",
          description:
            "Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.",
        },
        ready: { type: "boolean", description: "Optional readiness filter." },
        cursor: { type: "integer", description: "Zero-based result offset. Defaults to 0." },
        limit: { type: "integer", description: "Number of rows, 1 through 100. Defaults to 50." },
      },
      additionalProperties: false,
    },
  },
  {
    // 02 §9.11
    name: "team_task_get",
    description: "Read the complete latest value of one shared task before changing or executing it.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Shared task id." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    // 02 §9.12
    name: "team_task_update",
    description:
      "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list. In orchestrator mode, the Lead verifies a completed task and reopens it with concrete findings on failure.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Shared task id." },
        expected_revision: {
          type: "integer",
          description: "Current task revision used as the CAS precondition.",
        },
        action: {
          type: "string",
          enum: ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"],
          description: "Task transition to apply.",
        },
        subject: { type: "string", description: "Replacement title for edit." },
        description: {
          type: "string",
          description: "Replacement details for edit; for reopen, the concrete findings that failed verification.",
        },
        blocked_by: {
          type: "array",
          items: { type: "string" },
          description: "Complete blocker list for set_dependencies.",
        },
        write_scopes: {
          type: "array",
          items: { type: "string" },
          description: "Replacement advisory write scopes for edit.",
        },
        owner: {
          type: "string",
          description: "Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.",
        },
      },
      required: ["task_id", "expected_revision", "action"],
      additionalProperties: false,
    },
  },
];

/** 9 工具名集合（daemon 分派判定；含 interrupt_agent——分派校验用全集）。 */
export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(TEAM_TOOL_DEFINITIONS.map((t) => t.name));

/**
 * 工具表按 interrupt 开关裁剪（〔对齐轮〕0.2.1 D3：interrupt?: boolean 默认 true；
 * false 时 9 工具——interrupt_agent 不注册（策略插值同步变化，见 policy.ts teamPolicy））。
 */
export function teamToolDefinitions(options: { interrupt?: boolean } = {}): readonly ToolDefinition[] {
  const interrupt = options.interrupt ?? true;
  return interrupt
    ? TEAM_TOOL_DEFINITIONS
    : TEAM_TOOL_DEFINITIONS.filter((t) => t.name !== "interrupt_agent");
}

/** 工具名集合（按开关键裁；daemon tools/list 与分派使用）。 */
export function teamToolNames(options: { interrupt?: boolean } = {}): ReadonlySet<string> {
  return new Set(teamToolDefinitions(options).map((t) => t.name));
}

/** tools/list 条目序列化（期望 JSON 生成器与实际输出共用同一序列化器——F01 口径）。 */
export function serializeToolsList(tools: readonly unknown[]): string {
  return JSON.stringify({ tools });
}
