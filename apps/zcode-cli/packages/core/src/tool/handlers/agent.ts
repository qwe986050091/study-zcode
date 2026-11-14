// INV-01 描述由门控构造：守住位置 函数；改错故障 关闭后仍宣传工作流。
// INV-02 缺省视为开启：守住位置 严格相等判断；改错故障 既有调用方行为变化。
// INV-03 工作流句式仅一条：守住位置 数组末尾；改错故障 多代理编排被误导向工作流。
// INV-04 描述烘焙一次：守住位置 模块常量；改错故障 每次调用重建长字符串。
// INV-05 子代理端口缺失报配置错：守住位置 空值判断；改错故障 运行期空指针。
// INV-06 错误带稳定码：守住位置 错误码字段；改错故障 界面无法区分禁用与失败。
// INV-07 缺省代理类型：守住位置 空值合并；改错故障 派发无类型。
// INV-08 父工具调用带下去：守住位置 请求字段；改错故障 子代理无法回链。
// INV-09 可读输出文件只影响文案：守住位置 布尔字段；改错故障 权限被文案左右。
// INV-10 后台模式透传：守住位置 布尔转换；改错故障 显式 false 被当未传。
// INV-11 模型覆盖优先：守住位置 展开顺序；改错故障 覆盖被父模型盖住。
// INV-12 同步结果附用量：守住位置 格式化分支；改错故障 模型不知道子代理成本。
// INV-13 后台提醒不要读文件：守住位置 文案；改错故障 模型反复读取输出。
// INV-14 输出结构非法原样回退：守住位置 schema 判断；改错故障 结果丢失。
// INV-15 工具只读但副作用在子会话：守住位置 元数据；改错故障 据此认为派发无副作用。
// INV-16 超时设为无：守住位置 声明；改错故障 长跑子代理被误杀。
// INV-17 权限只匹配输入：守住位置 模式来源；改错故障 规则误命中工具名。
// INV-18 Task 复用 Agent 实现：守住位置 同一实现；改错故障 两套逻辑漂移。
//
// 模块职责：Agent 工具入口，把输入转译成子代理派发请求。
// 状态所有权：子运行时归端口，本文件只构造请求与声明契约。
// 阅读顺序：先看描述构造，再看处理器，最后看入口声明与别名。
/**
 * ============================================================================
 * tool/handlers/agent.ts —— Agent 工具（子代理派发）
 * ============================================================================
 *
 * 【定位】本文件只做"意图转译"：把 Agent 输入变成 SubagentPort.launch 请求。
 * 真正的 child runtime 创建、权限/模型/MCP 继承在 runtime/methods/subagent.ts。
 *
 * 【两种结果形态】同步模式返回完整 AgentOutput（status=completed，含 usage 与
 * 工具计数）；后台模式返回 async_launched（只给 agentId/outputFile），
 * 完成结果之后通过后台任务通知回灌——因此这里的 formatModelContent
 * 会提醒模型"不要再 Read/tail outputFile，等通知即可"。
 *
 * 【modelOverride】来自 Core Server 的显式覆盖，优先级高于 profile 与父模型
 * 继承；仍只是标准 ModelSelection，不会绕过权限/准入。
 *
 * 【Task 名称复用】taskToolEntry 与 agentToolEntry 共用同一实现，
 * 仅为兼容旧 provider 暴露的 Task 工具名。
 * ============================================================================
 */

import {
  AgentErrorCode,
  AgentInputJsonSchema,
  AgentInputSchema,
  AgentOutputSchema,
  AgentType,
  CoreErrorType,
  createCoreError,
  type AgentInput,
  type AgentOutput,
  type TraceContext,
} from "@zcode/contracts";
import { TASK_TOOL_NAME } from "../compat.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

const AGENT_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed", type: "string" },
        agentId: { type: "string" },
        agentType: { type: "string" },
        prompt: { type: "string" },
        content: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { const: "text", type: "string" },
              text: { type: "string" },
            },
            required: ["type", "text"],
            additionalProperties: false,
          },
        },
        totalToolUseCount: { type: "integer", minimum: 0 },
        totalDurationMs: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 },
        usage: { type: "object", additionalProperties: true },
      },
      required: ["status", "agentId", "prompt", "content", "totalToolUseCount", "totalDurationMs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "async_launched", type: "string" },
        agentId: {
          type: "string",
          description: "The ID of the async agent",
        },
        description: {
          type: "string",
          description: "The description of the task",
        },
        prompt: {
          type: "string",
          description: "The prompt for the agent",
        },
        outputFile: {
          type: "string",
          description: "Path to the output file for checking agent progress",
        },
        canReadOutputFile: {
          type: "boolean",
          description: "Whether the calling agent has Read/Bash tools to check progress",
        },
      },
      required: ["status", "agentId", "description", "prompt", "outputFile"],
      additionalProperties: false,
    },
  ],
};

/**
 * 动态工作流灰度门也管**工具描述**：
 * 关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着「CreateWorkflow
 * 是强制的」，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found。
 * 缺省 true：TUI、headless 与既有调用方（包括模块加载期烘焙的 AGENT_PROVIDER_DESCRIPTION）
 * 行为不变，只有显式 false 才抹掉这一行。
 */
// buildAgentProviderDescription 只拼两段固定文案：基础描述 + 可选工作流句。
// 工作流句只在 dynamicWorkflowEnabled 为真时出现，缺省由 options 默认值给 true。
// 缺省保留该句，因为 TUI 与 headless 都依赖 AGENT_PROVIDER_DESCRIPTION 的既有行为。
// 只有显式传 false 才抹掉这一行，模块加载期烘焙时也一样。
// 两段用换行拼接成单个字符串，调用方不需要再 join。
// 纯函数不读 Date 也不读环境变量或运行时状态：同一入参永远返回同一字符串。
function buildAgentProviderDescription(
  options: {
    dynamicWorkflowEnabled?: boolean;
  } = {},
): string {
  return [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "",
    "Available agent types are listed in <system-reminder> messages in the conversation.",
    "",
    "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
    "",
    "## When to use",
    "",
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
    "- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.",
    "- Each agent type's model, reasoning effort, and tools come from its definition (`.zcode/agents/*.md` frontmatter).",
    "- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes.",
    // 只保留「用户点名工作流」这一种情形：工作流一律由用户显式请求触发，与系统提示词其余
    // 部分一致。不能把「结果层层喂给下一步的多代理编排」也划给 CreateWorkflow，
    // 那等于让模型在用户没开口时自行选择工作流。
    ...(options.dynamicWorkflowEnabled === false
      ? []
      : [
          '- If the user explicitly asks for a workflow ("use a workflow", "使用 workflow", "用工作流", or any phrasing naming workflow/工作流 as the means), the CreateWorkflow tool is mandatory: do not use this tool instead, however small the task.',
        ]),
  ].join("\n");
}

const AGENT_PROVIDER_DESCRIPTION = buildAgentProviderDescription();

// AgentOutputSchema.safeParse 失败时原样返回入参，字符串直接给，其余 JSON 化。
// 解析成功时按 AgentOutputSchema 的字段拼文本，并在末尾附 usage。
// output 为空串时给占位符，避免模型收到空工具结果。
// 后台任务的 outputFile 写成「等通知」提示，不把路径透给模型。
// 只有 canReadBackgroundOutputFile 为真才给出可读路径。
function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }

  const data = parsed.data as AgentOutput;
  if (data.status !== "async_launched") {
    const childText = data.content.map((block) => block.text).join("\n");
    const childContent =
      childText.trim().length > 0 ? [childText] : ["(Subagent completed but returned no output.)"];
    const usageLines = [
      ...(data.totalTokens === undefined ? [] : [`subagent_tokens: ${data.totalTokens}`]),
      `tool_uses: ${data.totalToolUseCount}`,
      `duration_ms: ${data.totalDurationMs}`,
    ];
    return [
      ...childContent,
      `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`,
      `<usage>${usageLines.join("\n")}</usage>`,
    ].join("\n");
  }

  const launchLines = [
    "Async agent launched successfully.",
    `agentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ];

  if (data.canReadOutputFile) {
    return [
      ...launchLines,
      "Do not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      `output_file: ${data.outputFile}`,
      "Do NOT Read or tail this file via the shell tool. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
    ].join("\n");
  }

  return [
    ...launchLines,
    "Briefly tell the user what you launched and end your response. Do not generate any other text - agent results will arrive in a subsequent message.",
  ].join("\n");
}

/**
 * 派发子代理。
 *
 * 缺 SubagentPort（子代理被禁用/精简 runtime）时抛 ConfigurationError，
 * 并带 AgentErrorCode.SUBAGENT_UNAVAILABLE，让 UI 能区分"配置禁用"与"运行失败"。
 *
 * canReadBackgroundOutputFile：根据父会话可见工具里是否有 Read/Bash 决定
 * 结果文案（能不能读 outputFile）；这只是提示差异，不影响调度。
 */
// 入口先过 AgentInputSchema.parse，非法 subagent_type 在这一步就抛。
// subagent_type 缺省填 AgentType.GeneralPurpose。
// 父调用链没有端口时按配置错误返回，不静默降级。
// 请求里带上父会话的调用链，便于把子代理挂回同一棵 trace。
// options 里的覆盖优先于继承来的默认值。
const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentInputSchema.parse(input) as AgentInput;
  const agentType = parsed.subagent_type ?? AgentType.GeneralPurpose;

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for Agent tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: false,
      },
    );
  }

  const request = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    parentToolCallId: context.toolCallId,
    agentType,
    description: parsed.description,
    prompt: parsed.prompt,
    // 只决定后台模式下的结果文案（能不能读 outputFile），不影响调度或权限。
    callerCanReadOutputFile: canReadBackgroundOutputFile(context.providerVisibleToolNames),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
  };
  return context.subagentPort.launch(
    {
      ...request,
      runInBackground: parsed.run_in_background === true,
    },
    {
      signal: context.abortSignal,
      ...(context.model ? { model: context.model } : {}),
      ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
    },
  );
};

/**
 * 入口声明口径（executor 读这些字段决定校验/权限/超时，不是文档装饰）：
 * - inputSchema：subagent_type 缺省 general-purpose；description 是 3~5 词摘要，用于后台任务
 *   通知与 UI；prompt 是子代理唯一任务输入，必须自包含（子会话看不到父会话历史）；
 *   run_in_background=true 时结果只回 agentId/outputFile，正文由后台通知补上。
 * - readOnly:true + sideEffectScope:"session"：本工具自身不写文件；真正的写副作用发生在
 *   子 runtime，由子会话自己的权限链逐次审批。因此这里不需要审批，但不能据此认为派发无副作用。
 * - timeout:{kind:"none"}：子代理可能长跑，终止只由 abortSignal（用户取消 / 回合收口）承担。
 * - permission.patternSources:["input"]：规则只匹配 input（prompt 前缀），不看工具名。
 */
export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent; background execution is runtime-configured",
  metadata: {
    name: "Agent",
    description: AGENT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentHandler,
  formatModelContent: formatAgentOutputForModel,
  inputSchema: AgentInputJsonSchema,
  outputSchema: AGENT_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: AgentInputSchema,
  runtimeOutputSchema: AgentOutputSchema,
  permission: {
    permission: "subagent",
    reason:
      "Agent launches a child runtime; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_AGENT_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_AGENT_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage:
      "Agent was cancelled before the subagent returned findings or background launch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function canReadBackgroundOutputFile(toolNames: readonly string[] | undefined): boolean {
  const names = new Set(toolNames ?? []);
  return names.has("Read") || names.has("Bash");
}

export const taskToolEntry: ToolEntry = {
  ...agentToolEntry,
  capability: "Claude Code-compatible alias for launching a ZCode subagent",
  metadata: {
    ...agentToolEntry.metadata,
    shouldDefer: true,
    name: TASK_TOOL_NAME,
    providerVisible: false,
    description: [
      "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
      "",
      agentToolEntry.metadata.description ?? "",
    ].join("\n"),
  },
};

function createTaskToolEntryFromAgent(entry: ToolEntry): ToolEntry {
  return {
    ...entry,
    capability: "Claude Code-compatible alias for launching a ZCode subagent",
    metadata: {
      ...entry.metadata,
      shouldDefer: true,
      name: TASK_TOOL_NAME,
      providerVisible: false,
      description: [
        "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
        "",
        entry.metadata.description ?? "",
      ].join("\n"),
    },
  };
}

// createAgentToolEntry 复用 agentToolBase 的条目结构，只换 description。
// description 用 buildAgentProviderDescription(options) 现算，不共享模块级常量。
// dynamicWorkflowEnabled 原样透传，不在这一层解释门控语义。
// 每次调用返回新对象，避免调用方改到共享条目。
// 条目里没有可变字段被复用，两个返回值互不影响。
export function createAgentToolEntry(
  options: {
    /** 见 buildAgentProviderDescription：缺省 true，只有灰度显式关闭时才去掉工作流那一行。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...agentToolEntry,
    metadata: {
      ...agentToolEntry.metadata,
      description: buildAgentProviderDescription(options),
    },
  };
}

export function createTaskToolEntry(
  options: {
    /** Task 是 Agent 的兼容别名，描述整段内嵌 Agent 的，因此同一道门一起传下去。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return createTaskToolEntryFromAgent(createAgentToolEntry(options));
}
