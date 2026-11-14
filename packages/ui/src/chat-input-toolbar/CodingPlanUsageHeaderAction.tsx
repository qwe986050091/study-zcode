// INV-01 loading 期间只显示刷新态：守住位置 第一个早退分支；改错故障 刷新时同时出现成功勾与转圈。
// INV-02 只把 true 到 false 视为一次刷新结束：守住位置 wasLoading === true；改错故障 首次挂载就闪一下成功。
// INV-03 有错误则不给成功反馈：守住位置 !error 条件；改错故障 刷新失败仍显示勾。
// INV-04 成功态自动回落：守住位置 1000ms 定时器；改错故障 勾一直挂着，看不出后续刷新。
// INV-05 定时器必须清理：守住位置 return 的 clearTimeout；改错故障 卸载后仍写状态。
// INV-06 每次 loading 变化都同步 ref：守住位置 ref 赋值早于判断；改错故障 下一次比较用的是陈旧值。
// INV-07 loading 开始时重置为 idle：守住位置 setRefreshActionState 的 idle 分支；改错故障 上一轮的成功勾延续到新一轮。
// INV-08 无点击回调就不渲染按钮：守住位置 onUsageClick 条件；改错故障 出现点了没反应的入口。
// INV-09 点击必须阻断冒泡与默认行为：守住位置 preventDefault 与 stopPropagation；改错故障 触发外层菜单或表单提交。
// INV-10 警告图标独立于按钮：守住位置 warningLabel 条件；改错故障 无入口时警告也被隐藏。
// INV-11 三个状态都带角色：守住位置 两处 status 与一处 img；改错故障 读屏软件读不到刷新结果。
// INV-12 动画尊重减少动态偏好：守住位置 motion-reduce 变体；改错故障 前庭敏感用户仍看到旋转。
// INV-13 文案全部由 props 注入：守住位置 组件内无硬编码文案；改错故障 多语言环境出现混排。
// INV-14 常量集中定义：守住位置 CONTEXT_USAGE_REFRESH_SUCCESS_MS；改错故障 各处时长不一致。
//
// 模块职责：套餐用量入口按钮的加载、成功与警告三态渲染。
// 阅读顺序：先看刷新状态机，再看三个早退渲染分支，最后看警告与入口的组装。
import { CheckIcon, ChevronRightIcon, InfoIcon, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

// 成功提示的停留时长集中在此，便于统一调整。
const CONTEXT_USAGE_REFRESH_SUCCESS_MS = 1_000;

export function CodingPlanUsageHeaderAction({
  error,
  loading,
  onUsageClick,
  openLabel,
  refreshingLabel,
  updatedLabel,
  warningLabel,
}: {
  error: string | null | undefined;
  loading: boolean;
  onUsageClick?: () => void;
  openLabel: string;
  refreshingLabel: string;
  updatedLabel: string;
  warningLabel?: string;
}) {
  // 只有 idle 与 success 两态，加载态由 props 决定。
  const [refreshActionState, setRefreshActionState] = useState<"idle" | "success">("idle");
  // 记录上一次的 loading，用于识别真正的下降沿。
  const previousLoadingRef = useRef<boolean | null>(null);

  useEffect(() => {
    // 先取值再写入，否则下降沿永远检测不到。
    const wasLoading = previousLoadingRef.current;
    previousLoadingRef.current = loading;
    if (loading) {
      setRefreshActionState("idle");
      return;
    }
    // 只有从加载中落到无错，才算刷新成功。
    if (wasLoading === true && !error) {
      setRefreshActionState("success");
      const timeout = window.setTimeout(
        // refreshActionState 的 success 只保留 CONTEXT_USAGE_REFRESH_SUCCESS_MS，超时后 setRefreshActionState("idle")。
        () => setRefreshActionState("idle"),
        CONTEXT_USAGE_REFRESH_SUCCESS_MS,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [error, loading]);

  // 加载中优先于其它状态，成功勾不会与转圈并存。
  if (loading) {
    return (
      <span
        role="status"
        aria-label={refreshingLabel}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-foreground-subtle"
      >
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    );
  }

  // 成功态同样只占图标位，避免按钮宽度跳动。
  if (refreshActionState === "success") {
    return (
      <span
        role="status"
        aria-label={updatedLabel}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-success"
      >
        <CheckIcon className="size-3.5" />
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {warningLabel ? (
        <TooltipProvider>
          <ControlHintTooltip title={warningLabel}>
            <span
              role="img"
              aria-label={warningLabel}
              className="inline-flex h-6 w-5 items-center justify-center text-warning"
            >
              <InfoIcon className="size-3.5" aria-hidden="true" />
            </span>
          </ControlHintTooltip>
        </TooltipProvider>
      ) : null}
      {onUsageClick ? (
        <button
          type="button"
          aria-label={openLabel}
          className="inline-flex h-6 shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtle hover:text-foreground hover:underline"
          // onClick 里 stopPropagation，阻断冒泡到外层菜单，防止点按钮时连带关闭菜单。
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onUsageClick();
          }}
        >
          <span>{openLabel}</span>
          <ChevronRightIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}
