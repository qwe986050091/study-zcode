// INV-01 只有执行过的 hook 才进入明细：守住位置 执行判断；改错故障：未执行项会显示成空状态。
// INV-02 执行按 hook 序号升序排列：守住位置 排序比较；改错故障：乱序会让同一次调用内部顺序错乱。
// INV-03 行键由实体标识与运行标识组成：守住位置 key 拼接；改错故障：重复运行会命中同一个列表项。
// INV-04 阻断原因只在阻断且非空时携带：守住位置 条件展开；改错故障：空原因会渲染多余冒号。
// INV-05 时长只对已结束执行记录：守住位置 状态判断；改错故障：运行中显示零毫秒会误导为瞬时完成。
// INV-06 状态映射优先级固定：守住位置 状态函数；改错故障：超时与取消会被失败覆盖。
// INV-07 时长小于一秒用毫秒表示：守住位置 格式化分支；改错故障：统一秒表示会让短调用显示为零。
// INV-08 十秒以上只保留一位小数：守住位置 小数位判断；改错故障：长时长两位小数噪音过大。
// INV-09 状态图标固定五类：守住位置 图标组件；改错故障：新增状态落到默认叉号会被误读为失败。
// INV-10 没有可展示执行时直接不渲染：守住位置 空列表返回；改错故障：空气泡会让用户以为明细加载失败。
// INV-11 明细行按项记忆化：守住位置 memo 包装；改错故障：父级重渲染会重建全部行。
// INV-12 打开时抑制气泡提示：守住位置 提示层开关；改错故障：弹层与气泡同时出现会互相遮挡。
// INV-13 弹层不抢焦点：守住位置 自动聚焦回调；改错故障：打开即聚焦会让键盘滚动跳位。
// INV-14 弹层高度受可用空间约束：守住位置 最大高度；改错故障：固定高度会在小窗口溢出屏幕。
// INV-15 侧向定位与碰撞留白固定：守住位置 弹层属性；改错故障：贴边弹出会被裁掉箭头。
// INV-16 触发器保留无障碍名称：守住位置 标签与屏读文本；改错故障：只有图标会让读屏无法识别。
// INV-17 状态与来源文案全部走国际化：守住位置 文案键；改错故障：硬编码会让英文环境出现中文。
// INV-18 触发与内容都带回合级标识：守住位置 测试标识拼接；改错故障：多回合会命中同一个节点。
//
// 模块职责：把一次回合内的 hook 执行投影渲染成可展开的明细气泡。
// 状态所有权：打开状态归本组件；执行数据由属性传入且不在本地改写。
// 阅读顺序：先看明细构建与状态映射，再看图标与行组件，最后看触发器与弹层结构。
import { memo, useMemo, useState } from "react";
import {
  AnchorIcon,
  CircleSlash2Icon,
  CircleXIcon,
  ClockAlertIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
} from "lucide-react";
import {
  TID_V4_HOOK_DETAILS_CONTENT,
  TID_V4_HOOK_DETAILS_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import type { HookExecutionProjection, HookInvocationRow } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type HookDetailStatus = "running" | "blocked" | "failed" | "cancelled" | "timedOut";

interface HookDetailItem {
  key: string;
  blockReason?: string;
  durationMs?: number;
  eventName: HookInvocationRow["hookEventName"];
  sourceKind: HookExecutionProjection["sourceKind"];
  status: HookDetailStatus | null;
}

// buildHookDetailItems 把 HookInvocationRow[] 摊平成 HookDetailItem[]：先按 execution.hookIndex 升序（toSorted 不改原数组），
// 跳过 didExecute === false 的执行体——没跑过的 hook 没有状态可展示，占位只会留下空白行；
// key 用 `${row.entityId}:${execution.hookRunId}`，同一实体多次运行才不会在列表里撞键。
// blockReason 仅在 outcome === "blocked" 且非空时展开，durationMs 仅在 state !== "running" 且已定义时展开，
// eventName/sourceKind 直接沿用协议字段，不做本地化。
function buildHookDetailItems(rows: readonly HookInvocationRow[]): HookDetailItem[] {
  const items: HookDetailItem[] = [];
  for (const row of rows) {
    for (const execution of row.executions.toSorted(
      (left, right) => left.hookIndex - right.hookIndex,
    )) {
      if (!execution.didExecute) continue;
      items.push({
        key: `${row.entityId}:${execution.hookRunId}`,
        ...(execution.outcome === "blocked" && execution.blockReason
          ? { blockReason: execution.blockReason }
          : {}),
        ...(execution.state !== "running" && execution.durationMs !== undefined
          ? { durationMs: execution.durationMs }
          : {}),
        eventName: row.hookEventName,
        sourceKind: execution.sourceKind,
        status: hookDetailStatus(execution),
      });
    }
  }
  return items;
}

// formatHookDuration 先把 durationMs 夹到 >= 0（时钟回拨会给出负数），再 Math.round 统一取整；
// < 1000 输出 `${ms}ms`，1000~9999 用 toFixed(2)，>= 10000 用 toFixed(1)——
// 两位小数只为让亚秒级 hook 的差值可读，十秒以上再保留两位只剩噪音。
function formatHookDuration(durationMs: number): string {
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  if (roundedDurationMs < 1000) return `${roundedDurationMs}ms`;
  return `${(roundedDurationMs / 1000).toFixed(roundedDurationMs < 10_000 ? 2 : 1)}s`;
}

// hookDetailStatus 的判定顺序是语义的一部分，不可重排：state === "running" 最先返回，保证未结束的执行
// 不会被上一次 outcome 抢先标成失败；随后依次判 outcome 的 timed_out/cancelled/blocked，
// 再判 state === "failed" || outcome === "failed"，最后返回 null 表示正常完成；
// 若把 failed 提前，timed_out 与 cancelled 都会被错误地显示成叉号。
function hookDetailStatus(execution: HookExecutionProjection): HookDetailStatus | null {
  if (execution.state === "running") return "running";
  if (execution.outcome === "timed_out") return "timedOut";
  if (execution.outcome === "cancelled") return "cancelled";
  if (execution.outcome === "blocked") return "blocked";
  if (execution.state === "failed" || execution.outcome === "failed") return "failed";
  return null;
}

// HookStatusIcon 只按 status 分派图标：running→LoaderCircleIcon（motion-reduce:animate-none 尊重减少动效）、
// blocked→ShieldAlertIcon、timedOut→ClockAlertIcon 共用 text-warning，cancelled→CircleSlash2Icon 用中性色，
// 末尾兜底 CircleXIcon + text-destructive；新增状态若忘记加分支会落到叉号，视觉上等同失败。
const HookStatusIcon = memo(function HookStatusIcon({ status }: { status: HookDetailStatus }) {
  if (status === "running") {
    return (
      <LoaderCircleIcon
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    );
  }
  if (status === "blocked") {
    return <ShieldAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />;
  }
  if (status === "timedOut") {
    return <ClockAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />;
  }
  if (status === "cancelled") {
    return <CircleSlash2Icon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />;
  }
  return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />;
});

// HookDetailItemRow 以 memo 包裹且 props 只有 item，父级重渲染不会重建整列 li；
// 事件名用 font-mono 对齐协议字段，sourceKind/durationMs/status 靠右排列，blockReason 只在 status 存在时
// 以 text-warning 接在状态文案后；durationLabel 由 formatHookDuration 预先算好，避免渲染期重复格式化。
const HookDetailItemRow = memo(function HookDetailItemRow({ item }: { item: HookDetailItem }) {
  const { intl } = useZCodeIntl();
  const sourceLabel = intl.formatMessage({ id: `chat.hooks.source.${item.sourceKind}` });
  const durationLabel = item.durationMs === undefined ? null : formatHookDuration(item.durationMs);
  return (
    <li className="min-w-0 px-3 py-1.5 text-ui-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 break-words font-mono text-foreground">
          {item.eventName}
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-ui-xs text-foreground-subtle">
          <span>{sourceLabel}</span>
          {durationLabel ? <span className="text-foreground-subtlest">{durationLabel}</span> : null}
          {item.status ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <HookStatusIcon status={item.status} />
              {intl.formatMessage({ id: `chat.hooks.state.${item.status}` })}
              {item.blockReason ? (
                <span className="min-w-0 break-words text-warning">：{item.blockReason}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
});

export const ConversationHookDetailsAction = memo(function ConversationHookDetailsAction({
  className,
  rows,
  turnId,
}: {
  className?: string;
  rows: readonly HookInvocationRow[];
  turnId: string;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => buildHookDetailItems(rows), [rows]);
  // items 为空时直接 return null：hooks 全部未执行的回合不渲染 Popover 触发器，避免留下一个点不开的空按钮；
  // 判断放在 useState/useMemo 之后，保证 Hook 调用顺序不随 rows 变化，违反会触发 React 渲染期错误。
  if (items.length === 0) return null;

  const label = intl.formatMessage({ id: "chat.hooks.label" });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn(className)}
              data-testid={testId(TID_V4_HOOK_DETAILS_TRIGGER, turnId)}
            >
              <AnchorIcon className="size-3.5" />
              <span className="sr-only">{label}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={16}
        sticky="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        style={{
          maxHeight: "min(20rem, var(--radix-popover-content-available-height))",
        }}
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border-popover-border p-0"
        data-testid={testId(TID_V4_HOOK_DETAILS_CONTENT, turnId)}
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <h3 className="text-ui-base font-medium text-foreground">{label}</h3>
        </div>
        <ul className="min-h-0 overflow-y-auto py-0.5">
          {items.map((item) => (
            <HookDetailItemRow key={item.key} item={item} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
});
