/**
 * ============================================================================
 * workflow/expert/failures.ts —— 失败归因与恢复动作构造
 * ============================================================================
 *
 * 【定位】把任意错误（CoreError、provider 错误、普通 Error）归一化成快照里的
 * WorkflowFailure：kind 决定用户看到的失败类别，recoverable/retryable 决定
 * 恢复 UI 给什么按钮，activity/node/phase/session 决定失败作用范围。
 *
 * 【不变量】recoverable=false 只给 cancelled（取消不是"可修复故障"）；
 * retryable=false 只给 auth/cancelled/configuration（换参数或再跑都没意义）。
 * 这两项写入快照后被 retry 命令与 UI 直接消费，不能由调用点临时改写。
 * ============================================================================
 */

import {
  CoreErrorType,
  isCoreError,
  type ExpertWorkflowRunSnapshot,
  type WorkflowActivitySnapshot,
  type WorkflowFailure,
  type WorkflowFailureKind,
  type WorkflowRecoveryAction,
} from "@zcode/contracts";

/**
 * 选出"最该归因"的 activity。
 *
 * 从 activities 末尾向前找第一个满足：status=failed、status=active，或
 * activity.phase 等于快照 currentPhase。倒序保证同类情况取最新一次尝试；
 * 全都不满足时返回 undefined（失败归因会退化为 run 级，不带 activity 字段）。
 * 只读，不修改快照（先复制数组再 reverse）。
 */
export function latestWorkflowActivity(
  snapshot: ExpertWorkflowRunSnapshot,
): WorkflowActivitySnapshot | undefined {
  return [...snapshot.activities]
    .reverse()
    .find(
      (activity) =>
        activity.status === "failed" ||
        activity.status === "active" ||
        activity.phase === snapshot.currentPhase,
    );
}

/**
 * 构造快照里的 WorkflowFailure。
 *
 * 输入：原始 error、面向用户的 message（调用方通常传 error.message）与可选的
 * 归因 activity。输出字段全部来自 error/activity 的推导，不做 I/O；只把有值的
 * 可选字段写进去（undefined 不落库，避免快照里出现空键噪声）。
 *
 * 失败语义：本函数不抛错——无法识别的 error 归为 unknown，保证错误处理路径
 * 本身不会二次失败。recoverable/retryable 的口径见文件头不变量。
 */
export function workflowFailureFromError(
  error: unknown,
  message: string,
  activity?: WorkflowActivitySnapshot,
): WorkflowFailure {
  const kind = workflowFailureKind(error);
  const code = workflowFailureCode(error);
  return {
    ...(activity?.activityId ? { activityId: activity.activityId } : {}),
    ...(code ? { code } : {}),
    kind,
    message,
    ...(activity?.nodeId ? { nodeId: activity.nodeId } : {}),
    ...(activity?.phase ? { phase: activity.phase } : {}),
    recoverable: kind !== "cancelled",
    retryable: workflowFailureRetryable(kind, error),
    ...(activity?.sessionId ? { sessionId: activity.sessionId } : {}),
    ...(activity?.traceId ? { traceId: activity.traceId } : {}),
    ...(activity?.turnId ? { turnId: activity.turnId } : {}),
  };
}

/**
 * 生成恢复 UI 的动作候选列表（只是候选，不代表已经执行）。
 *
 * 固定三项：retry（原模型重跑）、retry_with_current_model（模型切换后重跑）、
 * cancel（终止，标 destructive 因为会丢弃未完成工作）。作用范围取自 failure
 * 的 activityId/nodeId/phase，缺失则退化为 run 级操作。
 * 纯函数，无副作用，顺序即 UI 展示顺序。
 */
export function workflowRecoveryActions(failure: WorkflowFailure): WorkflowRecoveryAction[] {
  const scoped = {
    ...(failure.activityId ? { activityId: failure.activityId } : {}),
    ...(failure.nodeId ? { nodeId: failure.nodeId } : {}),
    ...(failure.phase ? { phase: failure.phase } : {}),
  };
  return [
    {
      action: "retry",
      label: "Retry",
      ...scoped,
    },
    {
      action: "retry_with_current_model",
      label: "Retry with current model",
      ...scoped,
    },
    {
      action: "cancel",
      destructive: true,
      label: "Cancel workflow",
      ...scoped,
    },
  ];
}

/**
 * 错误 → 失败类别（WorkflowFailureKind）。
 *
 * 判定顺序：沿 error.cause 链（最多 8 层、WeakSet 防环）逐层，先看结构化 CoreError
 * 的 type（稳定契约），再用 code/type/reason 的文本做兜底匹配。结构化命中优先，
 * 避免包一层 wrapper 后文本变化导致分类漂移。
 * 全部未命中返回 unknown；本函数不抛错，链断裂只提前结束。
 */
function workflowFailureKind(error: unknown): WorkflowFailureKind {
  for (const entry of errorChain(error)) {
    if (isCoreError(entry)) {
      // CoreError 是内部稳定错误类型：直接映射，避免依赖 message 文案。
      switch (entry.type) {
        case CoreErrorType.ModelContextExceeded:
          return "model_context";
        case CoreErrorType.ModelRateLimited:
          return "rate_limit";
        case CoreErrorType.ModelTimeout:
          return "timeout";
        case CoreErrorType.PermissionDenied:
        case CoreErrorType.PermissionTimeout:
          return "permission";
        case CoreErrorType.ToolExecutionFailed:
        case CoreErrorType.ToolTimeout:
        case CoreErrorType.ToolMaxCalls:
          return "tool";
        case CoreErrorType.ConfigurationError:
          return "configuration";
        case CoreErrorType.TurnCancelled:
          return "cancelled";
        default:
          break;
      }
    }
    const record = asRecord(entry);
    // 文本兜底：只处理非结构化错误（provider/网络/透传错误），按关键字归并。
    const code = rawStringValue(record.code).toLowerCase();
    const type = rawStringValue(record.type).toLowerCase();
    const reason = rawStringValue(record.reason ?? asRecord(record.context).reason).toLowerCase();
    const combined = `${code} ${type} ${reason}`;
    if (combined.includes("rate")) return "rate_limit";
    if (combined.includes("timeout")) return "timeout";
    if (combined.includes("context")) return "model_context";
    if (combined.includes("auth") || combined.includes("not_configured")) return "auth";
    if (combined.includes("permission")) return "permission";
    if (combined.includes("tool")) return "tool";
    if (combined.includes("network") || combined.includes("proxy") || combined.includes("tls")) {
      return "network";
    }
    if (combined.includes("provider") || combined.includes("model_request_failed")) {
      return "provider";
    }
  }
  return "unknown";
}

/**
 * 提取稳定错误码（优先 code，其次 type）。
 *
 * 只取链上第一个非空字符串；用于 UI/日志展示，不参与流程判断（流程判断走 kind）。
 * 找不到时返回 undefined，调用方据此省略该字段。
 */
function workflowFailureCode(error: unknown): string | undefined {
  for (const entry of errorChain(error)) {
    const record = asRecord(entry);
    const code = rawStringValue(record.code || record.type);
    if (code) return code;
  }
  return undefined;
}

/**
 * 是否允许"再跑一次"。
 *
 * 硬性不可重试：auth（需要重新登录/配置）、cancelled（用户主动终止）、
 * configuration（宿主装配缺失）。其余优先采用错误自身声明的 retryable
 * （record.retryable 或 record.context.retryable），没有声明则默认 true。
 * 注意这是"建议值"，真正是否重跑仍由 retry 命令与用户决定。
 */
function workflowFailureRetryable(kind: WorkflowFailureKind, error: unknown): boolean {
  if (kind === "auth" || kind === "cancelled" || kind === "configuration") return false;
  for (const entry of errorChain(error)) {
    const record = asRecord(entry);
    if (typeof record.retryable === "boolean") return record.retryable;
    const context = asRecord(record.context);
    if (typeof context.retryable === "boolean") return context.retryable;
  }
  return true;
}

/**
 * 展开 error.cause 链。
 *
 * 约束：最多 8 层（防止异常嵌套无限展开），WeakSet 防环（cause 自引用或共享对象）。
 * 非对象值会被收进链后立即停止；返回顺序是"外层 → 最内层"。
 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new WeakSet<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    if (typeof current !== "object") break;
    if (seen.has(current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

// 任意值转成可索引对象；非对象返回空对象，调用方无需反复判空。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// 只接受字符串，其他类型一律当空串，避免把 number/boolean 拼进分类关键字。
function rawStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
