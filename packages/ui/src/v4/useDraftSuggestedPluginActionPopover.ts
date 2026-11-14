// INV-01 成功与失败时长不同：守住位置 两个常量；改错故障 错误提示一闪而过。
// INV-02 计时从 effect 开始：守住位置 第二个 effect；改错故障 异步渲染吞掉可见时长。
// INV-03 只有终态才计时：守住位置 success/error 判断；改错故障 确认态被自动关闭。
// INV-04 新操作先清旧计时：守住位置 show 内第一行；改错故障 旧计时器关掉新弹层。
// INV-05 清理按 operationId 校验：守住位置 clearTimer 的或链；改错故障 清理误伤并发操作。
// INV-06 隐藏同样校验 operationId：守住位置 函数式 setState；改错故障 旧回调隐藏新弹层。
// INV-07 计时器记归属操作：守住位置 OperationTimer；改错故障 无法判断计时器属于谁。
// INV-08 卸载清计时器：守住位置 第一个 effect 的返回；改错故障 卸载后晚到回调写状态。
// INV-09 弹层携带锚点与操作 id：守住位置 状态字段；改错故障 无法定位到具体条目。
// INV-10 action 可选：守住位置 展开三元；改错故障 无动作时也渲染空按钮。
// INV-11 onDismiss 再可选：守住位置 二次展开；改错故障 无关闭回调却显示关闭。
// INV-12 文案走 intl 并注入插件名：守住位置 formatMessage 第二参；改错故障 文案里缺插件名。
// INV-13 弹层变化重置计时：守住位置 effect 依赖；改错故障 阶段切换后仍按旧时刻关闭。
// INV-14 返回稳定引用：守住位置 四个 useCallback；改错故障 调用方每次渲染都拿到新函数。
//
// 模块职责：草稿建议插件的操作弹层状态，含成功/失败自动消失与按操作隔离的清理。
// 阅读顺序：先看时长常量与状态形状，再看清理与展示回调，最后看自动消失 effect。
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DraftSuggestedPluginFlow } from "@/v4/ConversationDraftSuggestedPluginFlow.js";

// 成功提示较短，失败提示留更久。
const PLUGIN_ACTION_SUCCESS_DURATION_MS = 2_000;
// 错误态用 PLUGIN_ACTION_ERROR_DURATION_MS = 3000，比成功态多留 1s 阅读时间。
const PLUGIN_ACTION_ERROR_DURATION_MS = 3_000;

export type DraftSuggestedPluginActionPopoverState = {
  anchorItemId: string;
  operationId: string;
  phase: "confirmation" | "progress" | "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
};

type OperationTimer = {
  operationId: string;
  timer: ReturnType<typeof setTimeout>;
};

export function useDraftSuggestedPluginActionPopover() {
  const { intl } = useZCodeIntl();
  const [pluginActionPopover, setPluginActionPopover] =
    useState<DraftSuggestedPluginActionPopoverState | null>(null);
  // resultTimerRef 同时存 operationId 与 timer，清理时据此只清匹配操作。
  const resultTimerRef = useRef<OperationTimer | null>(null);

  const clearTimer = useCallback(
    (timerRef: { current: OperationTimer | null }, operationId?: string) => {
      const current = timerRef.current;
      // 只清匹配的操作，避免清掉新计时器。
      if (!current || (operationId && current.operationId !== operationId)) return;
      clearTimeout(current.timer);
      timerRef.current = null;
    },
    [],
  );

  const clearPluginActionPopover = useCallback(
    (operationId?: string) => {
      clearTimer(resultTimerRef, operationId);
      // 隐藏同样按 operationId 校验。
      setPluginActionPopover((current) => {
        if (!current || (operationId && current.operationId !== operationId)) return current;
        return null;
      });
    },
    [clearTimer],
  );

  useEffect(() => {
    // 卸载时清计时器，防止晚到回调写状态。
    return () => {
      clearTimer(resultTimerRef);
    };
  }, [clearTimer]);

  const showPluginActionPopover = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      messageId: string,
      phase: DraftSuggestedPluginActionPopoverState["phase"],
      action?: { label: string; onAction: () => void; onDismiss?: () => void },
    ) => {
      // 展示新操作前先 clearTimer(resultTimerRef)，避免旧计时把新提示提前关掉。
      clearTimer(resultTimerRef);
      setPluginActionPopover({
        anchorItemId: flow.anchorItemId,
        operationId: flow.operationId,
        phase,
        // 消息文案注入插件名，位置由翻译模板决定。
        message: intl.formatMessage({ id: messageId }, { pluginLabel: flow.plugin.label }),
        ...(action
          ? {
              // 动作可选，仅有传参时才出现按钮。
              actionLabel: action.label,
              onAction: action.onAction,
              // onDismiss 可选，未传时按钮只执行 onAction 不回调关闭。
              ...(action.onDismiss ? { onDismiss: action.onDismiss } : {}),
            }
          : {}),
      });
    },
    [clearTimer, intl],
  );

  const showPluginActionResultPopover = useCallback(
    (flow: DraftSuggestedPluginFlow, messageId: string, succeeded: boolean) => {
      showPluginActionPopover(flow, messageId, succeeded ? "success" : "error");
    },
    [showPluginActionPopover],
  );

  useEffect(() => {
    const current = pluginActionPopover;
    // 只有终态才启动自动消失。
    if (!current || (current.phase !== "success" && current.phase !== "error")) return;
    // 成功反馈的 2000ms 从 DOM 已提交后的 effect 开始计时，避免异步 render 吞掉可见时长。
    // 时长按成功与失败分流。
    const durationMs =
      current.phase === "success"
        ? PLUGIN_ACTION_SUCCESS_DURATION_MS
        : PLUGIN_ACTION_ERROR_DURATION_MS;
    resultTimerRef.current = {
      operationId: current.operationId,
      timer: setTimeout(() => clearPluginActionPopover(current.operationId), durationMs),
    };
    return () => clearTimer(resultTimerRef, current.operationId);
  // 弹层变化会重置计时，阶段切换从头计时。
  }, [clearPluginActionPopover, clearTimer, pluginActionPopover]);

  return {
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  };
}
