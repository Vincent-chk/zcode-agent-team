// F01 期望 JSON 生成器（stage-3 T3.5a）。
// 独立转写 02 规格 §9.3–§9.13（name/description/参数描述/required/enum/additionalProperties:false
// 全字段逐字）——**不从 src/mcp/tools.ts 导入**，以便逐字节 diff 是真实的保真校验（捕获漂移），
// 而非自我比对。生成期望 JSON 时用与实际输出同一序列化器（JSON.stringify 无缩进）避免假阴性
// （键序/空白差异）。
//
// 顺序 = stage-3 任务书列举序 + stage-8 §9.13：spawn_teammate / send_message / list_agents /
// interrupt_agent / member_set_model / wait_agent / team_task_create / team_task_list /
// team_task_get / team_task_update。
//
// 〔F13〕spawn_teammate 携带 `_meta.ui`（resourceUri + surface）——宿主定义侧解析（见 tools.ts 注记）。
// 〔登记〕outputSchema 不声明（宿主 outputSchema 校验要求 object 型；list_agents 输出为数组无法原样
// 声明；F01 断言范围 = name/description/inputSchema，与验收标准一致）。输出契约由 F02 行为测试保证。

/** 期望的 10 工具（02 §9.3–§9.13 逐字转写）。 */
export const EXPECTED_TEAM_TOOLS: readonly Record<string, unknown>[] = [
  // §9.3 spawn_teammate
  {
    name: "spawn_teammate",
    description:
      "Create one named, durable teammate. Only the Team Lead may call this tool. In orchestrator mode, create teammates proactively when the goal benefits from delegation, within the member limit.",
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
        model: {
          type: "string",
          description:
            'Optional model as "providerId$modelId" or a bare modelId from the team://models resource. Defaults to inheriting the Lead model.',
        },
        thoughtLevel: {
          type: "string",
          description:
            'Optional reasoning level for the model (one of its variants from team://models, for example "high").',
        },
      },
      required: ["name", "description", "prompt"],
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: "ui://agent-team/team-panel.html", surface: "agent-team-panel" },
    },
  },
  // §9.5 send_message
  {
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
  // §9.6 list_agents
  {
    name: "list_agents",
    description:
      "List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  // §9.8 interrupt_agent
  {
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
  // §9.13 member_set_model（stage-8 Round C）
  {
    name: "member_set_model",
    description:
      'Change the model or reasoning level of one teammate. A running target applies it on its next turn; an idle target applies it immediately. Use "providerId$modelId" or a bare modelId; list models with the team://models resource. Team Lead only. Returns applied:"failed" with reason when the combination is rejected.',
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Teammate target returned by spawn_teammate or list_agents.",
        },
        model: {
          type: "string",
          description: 'Model as "providerId$modelId" or a bare modelId from team://models.',
        },
        thoughtLevel: {
          type: "string",
          description: "Reasoning level (one of the model's variants); omit to keep the model default.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  // §9.7 wait_agent（〔对齐轮〕0.2.1："mailbox"→"message"）
  {
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
  // §9.9 team_task_create
  {
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
  // §9.10 team_task_list
  {
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
  // §9.11 team_task_get
  {
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
  // §9.12 team_task_update
  {
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

/** 期望 tools/list 序列化（与实际输出同一序列化器：JSON.stringify 无缩进）。 */
export function expectedToolsListJson(): string {
  return JSON.stringify({ tools: EXPECTED_TEAM_TOOLS });
}
