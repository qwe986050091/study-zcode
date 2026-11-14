// ============================================================
// Goal Tool Handlers
// ============================================================
// 定位：Goal（target）的只读工具面。目标的生命周期（active/paused/complete、续跑与完成
// 验证）全部由 runtime 的 target 链路推进，这里只提供一个观察窗口。
// 职责：空入参校验 → 断言 SessionStorePort 在场 → 返回 `{ goal }`。
// 输入输出：入参当前无字段；输出是 store 里的目标快照，未设置时由 store 决定返回 null/空。
// 失败：SessionStorePort 缺席 → ConfigurationError（不可恢复装配错误）；读取失败向上冒泡。
// 不变量：绝不在这里写目标——只读是"模型不能自己给自己判完成"的结构性保证。

import {
  CoreErrorType,
  GoalReadInputJsonSchema,
  GoalReadInputSchema,
  GoalReadOutputJsonSchema,
  GoalReadOutputSchema,
  createCoreError,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolExecutionContext } from "../types.js";

// 模型可见结果字节上限（inline/model/preview 共用）。目标 JSON 通常很小，100KB 只是与
// 同类只读工具对齐的宽松上界。
const MAX_GOAL_MODEL_BYTES = 100_000;

/**
 * 读取当前会话目标。
 *
 * 输入：空对象（schema 仍要 parse，防止旧客户端塞入未知字段被静默接受）。
 * 输出：`{ goal }`——目标快照原样透传，本 handler 不做裁剪或派生。
 * 副作用：无（只读 store）；失败语义：store 缺席抛不可恢复配置错误，读取异常向上冒泡，
 * 由 executor 统一转成 error tool_result。
 */
export const targetReadHandler: ToolHandler = async (input, context) => {
  GoalReadInputSchema.parse(input);
  assertTargetStore(context, "GoalRead");

  return {
    goal: await context.sessionStore.readTarget({ sessionID: context.sessionId }),
  };
};

/**
 * GoalRead 的工具声明。
 *
 * 口径：`readOnly:true`、`sideEffectScope:"none"`、无需审批——读会话内目标不产生任何
 *   外部副作用，也不应被权限门反复打断。
 * 预算/超时：100KB + 30s，均不可由调用覆盖；`propagateToAdapters:false` 表示只读工具
 *   不必把 trace 透传给外部 adapter，但输入输出仍只记摘要（目标正文可能含用户私货）。
 */
export const targetReadToolEntry: ToolEntry = {
  capability: "Read the current session goal without modifying external state",
  metadata: {
    name: "GoalRead",
    description: "Read the current session goal and status.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: targetReadHandler,
  inputSchema: GoalReadInputJsonSchema,
  outputSchema: GoalReadOutputJsonSchema,
  runtimeInputSchema: GoalReadInputSchema,
  runtimeOutputSchema: GoalReadOutputSchema,
  permission: {
    permission: "target.read",
    reason: "GoalRead only reads session-local goal state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalRead was cancelled before goal state was returned",
  },
  trace: targetTracePolicy(),
};

/**
 * 断言 store 在场，并用 `asserts` 把类型收窄给调用方——后续 `context.sessionStore.readTarget`
 * 因此不需要非空断言。失败是配置错误（recoverable:false）：工具已声明却缺少依赖端口，
 * 重试不会自愈。
 */
function assertTargetStore(
  context: ToolExecutionContext,
  toolName: "GoalRead",
): asserts context is ToolExecutionContext & { sessionStore: NonNullable<ToolExecutionContext["sessionStore"]> } {
  if (context.sessionStore) return;

  throw createCoreError(CoreErrorType.ConfigurationError, `SessionStorePort is not configured for ${toolName}`, {
    context: {
      toolCallId: context.toolCallId,
      toolName,
    },
    recoverable: false,
  });
}

// 结果预算：inline 与 model 上限同值，策略 truncate + 头部预览。目标快照若异常膨胀，
// 宁可截断也不落 artifact——它是短状态，不应该产生可追踪的大文件引用。
function targetResultBudget() {
  return {
    maxInlineBytes: MAX_GOAL_MODEL_BYTES,
    maxModelBytes: MAX_GOAL_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_GOAL_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

// 墙钟 30s，禁止调用方覆盖：读 store 是本地操作，超时只可能意味着端口挂死，
// 放开覆盖会让模型用超时掩盖基础设施问题。
function targetTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

// trace 只记摘要、不向 adapter 传播：GoalRead 无外部调用，传播没有收益，
// 而目标内容可能包含用户未公开的意图，摘要记录已足够归因。
function targetTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
