import type { SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { applyRuntimeExecutionState, readRuntimeExecutionState } from "./execution-state.js";

/**
 * ============================================================================
 * runtime/session-mode-port.ts —— Plan Mode 工具访问 runtime 执行态的唯一端口
 * ============================================================================
 *
 * 【定位】
 *   EnterPlanMode / ExitPlanMode 的 handler 位于 tool/handlers,不能直接 import
 *   runtime。它们只依赖 contracts 的 SessionModePort,由本工厂把调用翻译成
 *   runtime 的 execution-state 写入(内存 config + session entry + 事件)。
 *
 * 【口径差异】本 runtime 的 Plan 是独立的 planEnabled 标志,不把 mode 改成 "plan":
 *   - getMode 永远返回实际协作模式(build/edit/yolo),缺省回溯 "build";
 *   - getPrePlanMode 因此没有"进入前的 mode"可报,恒为 undefined;
 *   - 进入/退出都只翻转 planEnabled,并在返回值里附带 previousMode /
 *     previousPlanEnabled 供 handler 组装提示与结果。
 *
 * 【副作用与失败】每次 enter/exit 都会持久化并发出 SessionModeChanged(见
 * execution-state.ts);持久化或互斥校验失败时异常原样抛给 handler,由工具层
 * 变成 tool error,不会留下半更新状态。
 * ============================================================================
 */
export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    // 能力探测:只有 store 提供一次性放行事务时,工具才允许暴露"完全访问"选项。
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    // 直接读内存 config;新建会话还没落任何模式时按 build 处理(不是 plan)。
    getMode: () => runtime.config.mode ?? "build",
    // 见文件头:本 runtime 不用 mode="plan" 表达计划态,故不存在"进入前的 mode"。
    getPrePlanMode: () => undefined,
    // planEnabled 的唯一读法走 execution-state,保证与持久化/事件同一口径。
    isPlanEnabled: () => readRuntimeExecutionState(runtime).planEnabled,
    /**
     * 进入计划模式:只翻转 planEnabled=true,source 固定为 "tool"。
     * 副作用:写 session entry + 发 SessionModeChanged + 置 plan 退出提醒。
     * 失败:Plan 与 active Goal 互斥校验会抛错(见 applyRuntimeExecutionState)。
     */
    async enterPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      const next = await applyRuntimeExecutionState(
        runtime,
        { planEnabled: true },
        { ...input, source: "tool" },
      );
      return { ...next, previousMode: previous.mode, previousPlanEnabled: previous.planEnabled };
    },
    /**
     * 退出计划模式:只允许在 planEnabled=true 时调用,翻转回 false。
     * previousPlanEnabled 固定回传 true(刚校验过),供 handler 生成"已退出"提示。
     * 失败:不在计划模式 → 抛固定文案的工具错误,提示继续实现而不是重复退出。
     */
    async exitPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      // 幂等性取舍:这里不做"已经在非计划态就当作成功"的宽松处理,因为该工具
      // 的语义是"写完计划后退出",误用时应当让模型看到明确错误并继续实现。
      if (!previous.planEnabled) {
        throw new Error(
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        );
      }

      const next = await applyRuntimeExecutionState(
        runtime,
        { planEnabled: false },
        { ...input, source: "tool" },
      );
      return { ...next, previousMode: previous.mode, previousPlanEnabled: true };
    },
  };
}
