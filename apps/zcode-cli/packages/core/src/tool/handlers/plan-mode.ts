/**
 * ============================================================================
 * tool/handlers/plan-mode.ts —— EnterPlanMode / ExitPlanMode
 * ============================================================================
 *
 * 【定位】计划模式的状态转换入口。两者都委托 SessionModePort，
 * 最终落到 runtime/execution-state.ts（持久化 → 改内存 → 发事件）。
 *
 * 【EnterPlanMode】只做转换与返回 previous/next 快照；
 *   进入后的只读约束由权限层按 planEnabled 生效，不在本文件实现。
 *
 * 【ExitPlanMode】两个前置条件：
 *   1) 当前必须处于 plan 模式，否则 InvalidStateTransition（recoverable）；
 *   2) 必须先把已批准的计划写盘（persistApprovedPlanFileBeforeExitPlanMode），
 *      保证退出后仍能找回计划文件；写入失败不退出，避免"计划丢了但模式已切换"。
 *
 * 【错误语义】InvalidStateTransition 标记 recoverable=true：模型可以自行纠正
 *   （例如先 Enter 再 Exit），而不是把整轮判失败。
 *
 * 【维护的不变量】
 *   - 模式切换的唯一写入口是 SessionModePort；本文件不直接改内存态或发事件，
 *     避免出现"工具返回了 next 快照、execution-state 却没更新"的第二真相源。
 *   - ExitPlanMode 的顺序不变量是"先落盘计划文件，再切模式"。若把顺序反过来，
 *     写盘失败时用户已离开 plan 模式，计划文本只剩在即将被压缩的上下文里。
 *   - 进入/退出都不是破坏性操作，且只影响 session 元状态，因此 sideEffectScope=session。
 *
 * 【反直觉取舍：计划文件写失败只吞非取消错误】
 *   `persistApprovedPlanFileBeforeExitPlanMode` 对 fileSystemPort 缺席直接跳过，对
 *   写盘抛出的非取消异常也不阻断退出。取舍是"用户已批准的退出不能因为一个辅助文件
 *   写失败而卡住"；代价是此次计划可能没有落盘，后续连续性只能依赖会话上下文。
 *   取消（abort / FileSystemPortError.code=cancelled）是例外：它必须转成 ToolCancelled
 *   上抛，否则 executor 会把"被取消"记成成功退出。
 * ============================================================================
 */

import {
  CoreErrorType,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EnterPlanModeInputJsonSchema,
  EnterPlanModeInputSchema,
  EnterPlanModeOutputJsonSchema,
  EnterPlanModeOutputSchema,
  ExitPlanModeInputJsonSchema,
  ExitPlanModeInputSchema,
  ExitPlanModeOutputJsonSchema,
  ExitPlanModeOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type EnterPlanModeOutput,
  type ExitPlanModeInput,
  type ExitPlanModeOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { writeApprovedPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
import {
  ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
  createEnterPlanModeProviderDescription,
  EXIT_PLAN_MODE_MODEL_INSTRUCTIONS,
} from "./plan-mode-prompts.js";

// 计划本身是长文（可能含文件清单、步骤与风险），100k 字节足以容纳而不触发预览/截断；
// 一旦调低，ExitPlanMode 的 plan 会先被 resultBudget 截断，模型与用户看到的计划不再一致。
const MAX_PLAN_MODE_MODEL_BYTES = 100_000;

// 数组常量取首元素作为 provider description；保持单一来源，避免与 prompts 文件漂移。
const EXIT_PLAN_MODE_DESCRIPTION = EXIT_PLAN_MODE_MODEL_INSTRUCTIONS[0];

/**
 * EnterPlanMode 的 handler。
 *
 * 输入：无业务字段（schema 只负责形状校验）；上下文必须带 sessionModePort，
 * 否则 fail closed 抛 ConfigurationError（recoverable=false，属于接线故障而非模型可纠正）。
 * 输出：previous/next 的 mode 与 planEnabled 四元组，供 UI/事件投影判断"从哪来到哪去"。
 * 副作用：切换 session 模式；不写文件、不发消息。只读约束由权限层在后续调用上生效。
 * 失败：端口缺失→ConfigurationError；端口自身抛错原样上抛（由 executor 归因）。
 */
export const enterPlanModeHandler: ToolHandler = async (input, context) => {
  EnterPlanModeInputSchema.parse(input);
  assertSessionModePort(context, ENTER_PLAN_MODE_TOOL_NAME);

  const transition = await context.sessionModePort.enterPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    message:
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
    mode: transition.mode,
    previousMode: transition.previousMode,
    planEnabled: transition.planEnabled,
    previousPlanEnabled: transition.previousPlanEnabled,
  } satisfies EnterPlanModeOutput;
};

/**
 * ExitPlanMode 的 handler：请求批准并退出计划模式。
 *
 * 输入：`plan` 是必填的完整计划正文；`allowedPrompts` 只是随批准一起回传给下游的
 * 预设授权范围（本文件不解析、不据此执行任何操作）。
 * 顺序：先判"确实在 plan 模式"，再持久化计划文件，最后才调用 exitPlanMode。
 * 输出：approved=true 与 previous/next 模式快照，加上原样回显的 plan/allowedPrompts。
 * 降级：fileSystemPort 缺席时不落盘但仍退出；非取消的写盘异常被吞掉（见文件头取舍）。
 * 失败：不在 plan 模式→InvalidStateTransition（recoverable=true）；
 *   写盘被取消→ToolCancelled（recoverable=true）；端口缺失→ConfigurationError。
 */
export const exitPlanModeHandler: ToolHandler = async (input, context) => {
  const parsed = ExitPlanModeInputSchema.parse(input) as ExitPlanModeInput;
  assertSessionModePort(context, EXIT_PLAN_MODE_TOOL_NAME);

  // 为什么用 isPlanEnabled 优先：mode 可能被别的开关临时覆盖，planEnabled 才是
  // "当前是否处于计划约束下"的权威口径；旧端口没有该方法时才退回 mode 比较。
  if (
    !(context.sessionModePort.isPlanEnabled?.() ?? context.sessionModePort.getMode() === "plan")
  ) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  await persistApprovedPlanFileBeforeExitPlanMode({
    context,
    plan: parsed.plan,
  });

  const transition = await context.sessionModePort.exitPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    allowedPrompts: parsed.allowedPrompts,
    approved: true,
    planEnabled: transition.planEnabled,
    previousPlanEnabled: transition.previousPlanEnabled,
    mode: transition.mode,
    plan: parsed.plan,
    previousMode: transition.previousMode,
  } satisfies ExitPlanModeOutput;
};

/**
 * EnterPlanMode 的注册声明。
 *
 * needsApproval=false 是刻意：进入计划模式只会收紧后续写操作，不产生外部副作用，
 * 再弹一次确认等于用一次交互换零安全收益。`requiresUserInteraction=false` 同理，
 * handler 不等用户输入；真正的"用户同意进入"由产品侧的模式切换语义承担。
 * `readOnly=false` 是因为它改变了 session 状态，不是纯读取；`shouldDefer=true`
 * 让该工具默认不占常驻工具位，按需由模型搜索/延迟加载。
 */
export const enterPlanModeToolEntry: ToolEntry = {
  capability: "Enter read-only planning mode before implementation",
  requiresUserInteraction: false,
  metadata: {
    shouldDefer: true,
    name: ENTER_PLAN_MODE_TOOL_NAME,
    searchHint: "switch to plan mode to design an approach before coding",
    description: ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: enterPlanModeHandler,
  formatModelContent: formatEnterPlanModeModelContent,
  inputSchema: EnterPlanModeInputJsonSchema,
  outputSchema: EnterPlanModeOutputJsonSchema,
  runtimeInputSchema: EnterPlanModeInputSchema,
  runtimeOutputSchema: EnterPlanModeOutputSchema,
  permission: planModePermission("plan.enter", "EnterPlanMode changes session mode to plan", false),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EnterPlanMode was cancelled before plan mode was entered",
  },
  trace: planModeTracePolicy(),
};

/**
 * 派生一份描述文案可变的 EnterPlanMode entry。
 *
 * 为什么不是直接改共享对象：`enterPlanModeToolEntry` 是模块级单例，按工具面动态覆盖
 * description 会污染其他会话。这里浅拷贝 entry 与 metadata，只替换 description，
 * 其余能力声明（权限、预算、超时、trace）继续与单例同源，避免两处漂移。
 */
export function createEnterPlanModeToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...enterPlanModeToolEntry,
    metadata: {
      ...enterPlanModeToolEntry.metadata,
      description: createEnterPlanModeProviderDescription(options),
    },
  };
}

/**
 * ExitPlanMode 的注册声明。
 *
 * needsApproval=true 与 `requiresUserInteraction=true`：该工具本身就是一次用户审批，
 * 不能被权限层静默放行（否则模型可以自行结束计划约束）。`shouldDefer=true` 同样成立，
 * 因为只有处于 plan 模式时才可能被调用。输出预算与 Enter 共用 100k，保证完整计划
 * 不经截断即可进入模型可见结果。
 */
export const exitPlanModeToolEntry: ToolEntry = {
  capability: "Request user approval for the plan and exit planning mode before coding",
  requiresUserInteraction: true,
  metadata: {
    shouldDefer: true,
    name: EXIT_PLAN_MODE_TOOL_NAME,
    searchHint: "present plan for approval and start coding (plan mode only)",
    description: EXIT_PLAN_MODE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: exitPlanModeHandler,
  formatModelContent: formatExitPlanModeModelContent,
  inputSchema: ExitPlanModeInputJsonSchema,
  outputSchema: ExitPlanModeOutputJsonSchema,
  runtimeInputSchema: ExitPlanModeInputSchema,
  runtimeOutputSchema: ExitPlanModeOutputSchema,
  permission: planModePermission(
    "plan.exit",
    "ExitPlanMode changes session mode after user plan approval",
  ),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ExitPlanMode was cancelled before plan mode was exited",
  },
  trace: planModeTracePolicy(),
};

/**
 * 断言 sessionModePort 存在并把 context 收窄为带该端口的类型。
 *
 * 端口缺席是宿主装配错误（不是模型输入错误），因此 fail closed 且 recoverable=false：
 * 让模型重试不会凭空出现一个端口，只会浪费一轮。
 */
function assertSessionModePort(
  context: ToolExecutionContext,
  toolName: typeof ENTER_PLAN_MODE_TOOL_NAME | typeof EXIT_PLAN_MODE_TOOL_NAME,
): asserts context is ToolExecutionContext & {
  sessionModePort: NonNullable<ToolExecutionContext["sessionModePort"]>;
} {
  if (context.sessionModePort) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionModePort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

/**
 * 在退出计划模式之前，把已批准计划写到工作区计划文件。
 *
 * 降级语义（重要）：
 *   - `fileSystemPort` 缺席 → 直接 return，模式仍会退出。这是可选端口契约，不是错误。
 *   - 写盘抛错但**不是取消** → 吞掉。取舍见文件头：不让辅助持久化失败阻断用户已批准的退出；
 *     代价是这一段计划可能没有落盘。
 *   - 取消（abortSignal 已中止，或 port 报 cancelled）→ 转成 ToolCancelled 上抛，
 *     保证取消不会伪装成"成功退出"。
 * 副作用：写一个工作区文件；不修改 session 模式（切换仍由调用方在之后执行）。
 */
async function persistApprovedPlanFileBeforeExitPlanMode(input: {
  context: ToolExecutionContext;
  plan: string;
}): Promise<void> {
  const { context } = input;
  if (!context.fileSystemPort) return;

  try {
    await writeApprovedPlanFile({
      abortSignal: context.abortSignal,
      fileSystemPort: context.fileSystemPort,
      plan: input.plan,
      sessionId: context.sessionId,
      traceContext: createPlanModeToolTraceContext(context),
      workspaceRoot: context.workspaceRoot,
    });
  } catch (error) {
    if (isPlanFilePersistenceCancellation(error, context.abortSignal)) {
      throw createCoreError(
        CoreErrorType.ToolCancelled,
        "ExitPlanMode was cancelled before plan mode was exited",
        {
          cause: error instanceof Error ? error : undefined,
          context: {
            toolCallId: context.toolCallId,
            toolName: EXIT_PLAN_MODE_TOOL_NAME,
          },
          recoverable: true,
        },
      );
    }
    // 注意：能走到这里说明不是取消，按文件头取舍静默降级——写入失败不阻断退出。
  }
}

function createPlanModeToolTraceContext(context: ToolExecutionContext) {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    turnId: context.turnId,
  };
}

/**
 * 判断写盘失败是否属于"取消"。
 *
 * 两个来源都要认：外层 abortSignal 已中止（executor/用户取消），或 FileSystemPort
 * 自身以 cancelled 错误码结束（runtime shutdown 等）。只认错误码会漏掉第一种，
 * 只认 signal 会漏掉端口内部先取消的情况。
 */
function isPlanFilePersistenceCancellation(error: unknown, abortSignal: AbortSignal): boolean {
  return abortSignal.aborted || (isFileSystemPortError(error) && error.code === "cancelled");
}

// 进入后的模型引导：把"只探索、不写文件"的约束写进 tool result，避免模型把
// EnterPlanMode 当成一次普通的状态查询后立刻开始编辑。
function formatEnterPlanModeModelContent(output: unknown): string {
  const result = output as EnterPlanModeOutput;
  return `${result.message}

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`;
}

/**
 * 退出后的模型引导：把已批准的计划原文回灌给模型。
 *
 * 为什么回灌：计划正文可能很长，而 ExitPlanMode 的内参在后续上下文中不一定完整保留；
 * 这里把"已批准"的事实与计划文本绑定在同一条 tool result 里，模型开始实现时无需回翻。
 * plan 为空（旧客户端/空计划）时退化为一句简短确认，不构造空标题。
 */
function formatExitPlanModeModelContent(output: unknown): string {
  const result = output as ExitPlanModeOutput;
  const plan = result.plan?.trim();
  if (!plan) {
    return "User has approved exiting plan mode. You can now proceed.";
  }

  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

## Approved Plan:
${plan}`;
}

/**
 * Plan Mode 两个工具的权限声明。
 *
 * @param needsApproval Enter 传 false（只能收紧权限），Exit 传 true（本身就是审批动作）。
 * patternSources 含 `input`：Exit 的 allowedPrompts 因而可进入规则匹配面；
 * alwaysAllowPatternSources 只含 toolName：持久化的"总是允许"应绑定工具本身，
 * 而不是某一次具体计划文本，否则每次计划内容变化都会让旧规则失效。
 */
function planModePermission(
  permission: string,
  reason: string,
  needsApproval = true,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

/**
 * 结果预算：内联与模型上限都取 100k，策略 truncate，预览从头部取。
 * 计划工具必须让完整计划进入模型可见结果；direction=head 是因为计划的开头通常是
 * 目标与步骤，尾部被截断比头部丢失更可接受（但正常计划不应触发截断）。
 */
function planModeResultBudget() {
  return {
    maxInlineBytes: MAX_PLAN_MODE_MODEL_BYTES,
    maxModelBytes: MAX_PLAN_MODE_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_PLAN_MODE_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

/**
 * 超时：固定 30s，不允许调用方覆盖。
 * handler 只做一次内存/持久化状态切换，30s 是给端口与计划文件写入的宽裕上限；
 * 禁止覆盖是为了避免模型用大 plan 反复把一次轻量状态转换拖成分钟级等待。
 */
function planModeTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

/**
 * trace 策略：必须携带 trace，但不下发到 adapter。
 * 为什么 propagateToAdapters=false：模式切换只发生在 core/session 内部，
 * 没有外部 I/O，适配层不需要该 span；保留 required 是为了会话事件仍可归因到 turn。
 */
function planModeTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
