/**
 * ============================================================================
 * hooks/runner-helpers.ts —— Hook 执行器的判定与错误工具
 * ============================================================================
 *
 * 这里集中三类边界:admission 的 fail-closed 求值、取消/超时到 HookOutcome 的
 * 归一、descriptor 的默认形状;runner 只负责调度,不重复这些规则。
 *
 * admission gate 自身抛错时必须拒绝而不是放行,否则安全门失效就扩大执行面
 * （不变量 #10）;错误归一按 CoreErrorType 判定,不读 message 文本（链路 9）。
 * ============================================================================
 */
import {
  CoreErrorType,
  HookOutcome,
  createCoreError,
  isCoreError,
  type HookExecutionDescriptor,
  type HookInput,
  type Logger,
} from "@zcode/contracts";
import { matchesHookMatcher } from "./output.js";
import type { HookRegistration, HookRunOptions } from "./types.js";

// 用 Symbol 而不是字符串:超时原因要能与用户取消区分,也不会被序列化进事件。
export const HOOK_TIMEOUT_ABORT_REASON = Symbol("hook-timeout");

export function resolveHookRunAdmission(
  hook: HookRegistration,
  input: HookInput,
  logger?: Logger,
): { allowed: boolean; reasonCode?: string; skipLifecycle?: boolean } {
  // 没注入 admission 的是内置/配置来源 hook,默认允许;工作区 hook 必带 gate,
  // 因此这条默认分支不会成为绕过信任判定的通道。
  if (!hook.admission) return { allowed: true };
  try {
    // 每次都现场求值,绝不能复用上一次结果:撤销或策略收紧可能发生在两次
    // dispatch 之间（不变量 #10）。
    return hook.admission(input);
  } catch (error) {
    // 安全 gate 自身异常时不能继续创建进程或后台任务。
    // 失败一律按拒绝处理,并给出明确 reasonCode（不变量 #10）。
    logger?.warn("Hook admission gate failed closed", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.admission.failed_closed",
      hookEventName: input.hookEventName,
      module: "core.hooks",
      source: hook.source,
    });
    return { allowed: false, reasonCode: "workspace_hooks_blocked_untrusted" };
  }
}

export function matchesAnyHookMatcher(
  options: HookRunOptions,
  matcher: string | undefined,
): boolean {
  // 未配置 matcher 的注册对所有事件生效,不需要再比对匹配值。
  if (!matcher) return true;
  // 单值与多值同时兼容:同一事件可能带多个匹配目标(如工具名与事件名)。
  const matchValues = [
    ...(options.matchValues ?? []),
    ...(options.matchValue ? [options.matchValue] : []),
  ];

  // 有 matcher 但调用方没给任何匹配值:按"全匹配"处理,与未配置 matcher 同义。
  if (matchValues.length === 0) return true;
  // 先去重再逐个测试:重复值不改变结论,但会重复构造正则。
  return [...new Set(matchValues)].some((matchValue) => matchesHookMatcher(matchValue, matcher));
}

export function linkAbortSignal(
  parentSignal: AbortSignal | undefined,
  childController: AbortController,
): () => void {
  // 没有父信号则无需联动;返回空清理函数,让调用方可以无条件在 finally 里调用。
  if (!parentSignal) return () => {};
  const abortChild = () => {
    // 只在子域尚未结束时转发,避免覆盖更早发生的取消原因。
    if (!childController.signal.aborted) childController.abort(parentSignal.reason);
  };
  // 父信号已经取消:必须立即同步取消,否则本次 hook 会错过取消窗口。
  if (parentSignal.aborted) {
    abortChild();
    return () => {};
  }
  // 常规路径注册转发,并返回移除函数:调用方不清理就会在长生命周期 runner 上泄漏监听器。
  parentSignal.addEventListener("abort", abortChild);
  return () => parentSignal.removeEventListener("abort", abortChild);
}

export function createHookTimeoutError(timeoutMs: number): Error {
  // 用 ToolTimeout 类型而非普通 Error:resolveHookFailureOutcome 靠类型产出 TimedOut,
  // 事件与 UI 才能把"超时"和"失败"区分开。
  return createCoreError(CoreErrorType.ToolTimeout, `Hook timed out after ${timeoutMs}ms`, {
    recoverable: true,
  });
}

export function createHookCancelledError(): Error {
  // 取消同样用类型表达,与超时分开:用户主动停止不能记成超时,否则统计与重试策略会误判。
  return createCoreError(CoreErrorType.ToolCancelled, "Hook execution cancelled", {
    recoverable: true,
  });
}

export function resolveHookFailureOutcome(error: unknown): HookOutcome {
  // 非 CoreError(脚本崩溃、spawn 失败)一律记 Failed:没有类型证据就不猜超时或取消。
  if (!isCoreError(error)) return HookOutcome.Failed;
  // 按类型判定而不读错误文本:文案会变,错误类型是稳定契约。
  if (error.type === CoreErrorType.ToolTimeout) return HookOutcome.TimedOut;
  if (error.type === CoreErrorType.ToolCancelled) return HookOutcome.Cancelled;
  return HookOutcome.Failed;
}

export function readHookErrorMessage(error: unknown): string {
  // 优先取 cause 的消息:hook 处理器常把底层原因挂在 cause 上,
  // 只读外层 message 会丢掉真正的失败根因。
  if (isCoreError(error) && error.cause instanceof Error) {
    return error.cause.message || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function resolveHookDescriptor(
  hook: HookRegistration,
  defaultTimeoutMs: number,
  input: HookInput,
): HookExecutionDescriptor {
  // descriptor 允许是函数,以便按输入(如 matcher)动态计算展示信息。
  if (typeof hook.descriptor === "function") return hook.descriptor(input);
  // 未提供 descriptor 的内置 hook 用最小默认形状:不可见、internal、沿用默认超时。
  return (
    hook.descriptor ?? {
      clientVisible: false,
      commandDisplay: hook.source ?? "Internal hook",
      executionMode: hook.async === true ? "background" : "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: hook.timeoutMs ?? defaultTimeoutMs,
    }
  );
}
