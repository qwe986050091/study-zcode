// INV-01 剩余秒数不为负：守住位置 取最大值；改错故障 过期后显示负数倒计时。
// INV-02 无过期时间按零处理：守住位置 空值判断；改错故障 空值参与算术得非数字。
// INV-03 每秒刷新只在单机会时开启：守住位置 早退条件；改错故障 多机会也常驻定时器。
// INV-04 定时器随依赖变化重建：守住位置 清理函数；改错故障 旧闭包按旧过期时间计数。
// INV-05 初始值由惰性函数计算：守住位置 状态初始化；改错故障 首帧闪出错误倒计时。
// INV-06 受控与不受控共用同一开关：守住位置 空值合并；改错故障 两种用法行为分叉。
// INV-07 多机会与单机会文案分流：守住位置 比较表达式；改错故障 单机会缺少倒计时。
// INV-08 按钮文案与无障碍名称同源：守住位置 变量复用；改错故障 视觉与朗读内容不一致。
// INV-09 弹框存活期间徽标不收起：守住位置 可见性合并；改错故障 入口在按钮位置塌缩。
// INV-10 隐藏时不可聚焦：守住位置 制表位取值；改错故障 键盘仍能落到透明按钮。
// INV-11 点击先阻止默认与冒泡：守住位置 事件处理；改错故障 触发外层行点击。
// INV-12 只有可见时才打开弹框：守住位置 条件判断；改错故障 隐藏态被程序打开。
// INV-13 有弹框配置才升级为按钮：守住位置 分支入口；改错故障 无配置时渲染空按钮。
// INV-14 内联形态才显示倒计时文本：守住位置 双条件；改错故障 浮层形态重复占宽。
// INV-15 浮层形态包一层提示：守住位置 条件渲染；改错故障 倒计时无处可看。
// INV-16 徽标内容在两种形态复用：守住位置 片段变量；改错故障 图标与文案各写一份。
// INV-17 宽度动画可被减弱动效关闭：守住位置 类名列表；改错故障 前庭敏感用户仍见位移。
// INV-18 无弹框配置时保持只读徽标：守住位置 提前分支；改错故障 只读场景出现可点元素。
//
// 模块职责：编码计划配额重置机会的徽标、倒计时与弹框入口。
// 状态所有权：剩余秒数与不受控弹框开关由组件内部持有。
// 阅读顺序：先看倒计时与状态，再看文案派生，最后看两种形态的返回分支。
import { GiftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  CodingPlanQuotaResetDialog,
  formatCodingPlanQuotaResetCountdown,
  type CodingPlanQuotaResetDialogConfig,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type { CodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";

function getRemainingSeconds(expiresAt: number | null): number {
  if (expiresAt == null) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

// remainingSeconds 由 useState 的惰性初始化器调用 getRemainingSeconds 得到。
// dialogOpen 与 uncontrolledDialogOpen 共用 resolvedDialogOpen 一个开关。
// hasMultipleOpportunities 与单机会分支共用 effectiveVisible 可见性。
// resolvedDialogOpen 为真时 effectiveVisible 保持徽标在场。
export function CodingPlanQuotaResetOpportunity({
  count,
  dialog,
  dialogOpen,
  expiresAt,
  onDialogOpenChange,
  placement = "tooltip",
  visible,
}: {
  count: number;
  dialog?: CodingPlanQuotaResetDialogConfig;
  dialogOpen?: boolean;
  expiresAt: number | null;
  onDialogOpenChange?: (open: boolean) => void;
  placement?: "inline" | "tooltip";
  visible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [remainingSeconds, setRemainingSeconds] = useState(() => getRemainingSeconds(expiresAt));
  const [uncontrolledDialogOpen, setUncontrolledDialogOpen] = useState(false);
  const resolvedDialogOpen = dialogOpen ?? uncontrolledDialogOpen;
  const setDialogOpen = onDialogOpenChange ?? setUncontrolledDialogOpen;
  // 弹框在 dialog 分支内常驻挂载，机会数从多降到单/零都不会提前卸载成功动画中的 Dialog；
  // 这里只决定文案与倒计时形态：多机会显示「获得 N 次」，单机会保留原文案 + 倒计时。
  const hasMultipleOpportunities = count > 1;

  useEffect(() => {
    setRemainingSeconds(getRemainingSeconds(expiresAt));
    if (!visible || hasMultipleOpportunities) {
      return;
    }
    const timer = window.setInterval(() => {
      setRemainingSeconds(getRemainingSeconds(expiresAt));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, hasMultipleOpportunities, visible]);

  // openDialogLabel 的文案随 count 变化。
  // countdownLabel 由 formatCodingPlanQuotaResetCountdown 单独格式化。
  // label 与 aria-label 同源，避免视觉与读屏不一致。
  const opportunityLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.opportunity" },
    { count },
  );
  const countdownLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.expiresIn" },
    { time: formatCodingPlanQuotaResetCountdown(remainingSeconds, intl.formatMessage) },
  );
  // 多机会入口复用了不带参数的固定文案，用户无法直接确认当前可用次数。
  // 这里让可见文案与 aria-label 共用同一个动态结果，避免视觉和无障碍名称再次不一致。
  const openDialogLabel = intl.formatMessage({ id: "codingPlan.quotaReset.openDialog" }, { count });
  const label = hasMultipleOpportunities ? openDialogLabel : opportunityLabel;
  // 弹框存活期间徽标不收起：单机会在弹框打开后过期时，入口不能从按钮位置塌缩。
  const effectiveVisible =
    visible && (hasMultipleOpportunities || resolvedDialogOpen || remainingSeconds > 0);
  const commonClassName = [
    "inline-flex h-5 shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm font-medium text-interaction-confirmation-foreground",
    "transition-[max-width,opacity,padding,background-color] duration-200 motion-reduce:transition-none",
    effectiveVisible ? "max-w-64 opacity-100" : "pointer-events-none max-w-0 px-0 opacity-0",
  ].join(" ");
  const badgeBody = (
    <>
      <span className="inline-flex min-w-0 items-center gap-1">
        <GiftIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {placement === "inline" && !hasMultipleOpportunities ? (
        <span className="ml-2 shrink-0 font-normal text-interaction-confirmation-foreground/80 tabular-nums">
          {countdownLabel}
        </span>
      ) : null}
    </>
  );

  // 只有 dialog 存在时才渲染可点入口。
  // onClick 先调 event.preventDefault 与 stopPropagation 阻断默认行为与冒泡。
  // 两处开关都复用 setDialogOpen 这一个设置函数。
  if (dialog) {
    // 单机会同样可以点开重置弹框；文案与倒计时保持单机会形态，仅交互升级为按钮。
    const button = (
      <button
        type="button"
        aria-label={label}
        aria-hidden={!effectiveVisible}
        className={`${commonClassName} hover:bg-interaction-confirmation-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
        data-reset-opportunity="true"
        tabIndex={effectiveVisible ? 0 : -1}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (effectiveVisible) setDialogOpen(true);
        }}
      >
        {badgeBody}
      </button>
    );
    return (
      <>
        {placement === "tooltip" && !hasMultipleOpportunities ? (
          <ControlHintTooltip title={countdownLabel}>{button}</ControlHintTooltip>
        ) : (
          button
        )}
        <CodingPlanQuotaResetDialog
          config={dialog}
          open={resolvedDialogOpen}
          onOpenChange={setDialogOpen}
        />
      </>
    );
  }

  const content = (
    <span aria-hidden={!effectiveVisible} data-reset-opportunity="true" className={commonClassName}>
      {badgeBody}
    </span>
  );

  if (placement === "inline") {
    return content;
  }

  return <ControlHintTooltip title={countdownLabel}>{content}</ControlHintTooltip>;
}
