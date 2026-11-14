// INV-01 禁用原因三类且可空：守住位置 类型别名；改错故障 未知原因让按钮永久禁用。
// INV-02 灰度关闭不参与禁用：守住位置 首个早退；改错故障 未灰度用户看不到按钮。
// INV-03 加载与错误都视为暂不可用：守住位置 状态判断；改错故障 请求失败仍可点。
// INV-04 无套餐优先于不可用：守住位置 判断顺序；改错故障 付费引导被错误遮住。
// INV-05 非就绪态一律不可用：守住位置 兜底判断；改错故障 未知状态被放行。
// INV-06 可号必须为 true：守住位置 严格相等；改错故障 未定义被当成可取号。
// INV-07 剩余为非正时显示不足一分钟：守住位置 边界比较；改错故障 显示负数分钟。
// INV-08 分钟向上取整：守住位置 取整函数；改错故障 低估等待时间。
// INV-09 小时与分钟拆算：守住位置 除法与取模；改错故障 分钟超过六十。
// INV-10 三种文案按组合选择：守住位置 分支顺序；改错故障 出现零分钟或零小时。
// INV-11 文案全部走本地化：守住位置 格式化调用；改错故障 界面出现硬编码。
// INV-12 提示允许换行：守住位置 样式类；改错故障 长原因被截断。
// INV-13 标题仅在自动默认时跟随语言：守住位置 四条件早退；改错故障 覆盖用户输入。
// INV-14 编辑中永不改写标题：守住位置 编辑判断；改错故障 输入被重置。
// INV-15 草稿或已保存标题优先：守住位置 初始标题判断；改错故障 已保存任务被改名。
// INV-16 状态映射唯一来源：守住位置 单一函数；改错故障 图标与文案不一致。
// INV-17 带位次的排队与暂停用位次文案：守住位置 位次判断；改错故障 暂停显示成排队。
// INV-18 终态不提示模型选择问题：守住位置 状态白名单；改错故障 历史任务长期报错。
//
// 模块职责：闲时任务的创建禁用原因、剩余时长、标题与状态展示映射。
// 状态所有权：无状态；任务数据与本地化实例全部由调用方注入。
// 阅读顺序：先看禁用原因，再看剩余时长与标题，最后看状态页脚与选择问题。
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { OffPeakTakeNumberAvailabilityStatus } from "@/store/offPeakTaskStore.js";

export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable";

/** 闲时创建禁用原因属于长提示，不能沿用通用短 Tooltip 的单行布局。 */
// Tailwind 提示框允许换行，避免长句被截断。
// max-w-[220px] 限制宽度，防止提示横跨面板。
// [&>span] 只作用于提示内部的文本节点。
// 该值不随 theme 变化，保持常量。
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =
  "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty";

/** 只有服务端成功确认可取号才放行创建，其余资格与依赖状态全部 fail-closed。 */
// grayEnabled 为假时不参与禁用判断。
// availabilityStatus 为 loading 或 error 都视为暂不可用。
// 只有 canTakeNumber === true 才放行创建。
export function resolveOffPeakCreateBlockReason({
  availabilityStatus,
  canTakeNumber,
  grayEnabled,
  noPlan,
}: {
  availabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  canTakeNumber: boolean | undefined;
  grayEnabled: boolean;
  noPlan: boolean;
}): OffPeakCreateBlockReason | null {
  if (!grayEnabled) return null;
  if (availabilityStatus === "loading" || availabilityStatus === "error") {
    return "unavailable";
  }
  if (noPlan) return "plan";
  if (availabilityStatus !== "ready") return "unavailable";
  return canTakeNumber === true ? null : "quota";
}

/** 将服务端绝对恢复点转换成只包含小时/分钟的本地化剩余时长。 */
// remainingMs <= 0 时显示 lessThanMinute 文案。
// Math.ceil() 对分钟向上取整，避免低估等待。
// hours 与 minutes 组合出三种 formatMessage 文案。
export function formatOffPeakRemainingWait(
  nextTakeAt: number,
  now: number,
  intl: IntlInstance,
): string {
  const remainingMs = nextTakeAt - now;
  if (remainingMs <= 0) {
    return intl.formatMessage({
      id: "offPeak.create.remaining.lessThanMinute",
    });
  }

  // 旧 Tooltip 直接展示年月日，文案过长且用户还要自行换算等待时间。
  // 向上取整分钟，避免在仍需等待几十秒时显示 0 分钟或低估服务端恢复点。
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return intl.formatMessage(
      { id: "offPeak.create.remaining.hoursMinutes" },
      { hours, minutes },
    );
  }
  if (hours > 0) {
    return intl.formatMessage(
      { id: "offPeak.create.remaining.hours" },
      { hours },
    );
  }
  return intl.formatMessage(
    { id: "offPeak.create.remaining.minutes" },
    { minutes },
  );
}

export type OffPeakStatusIconKind =
  | "moon"
  | "pause"
  | "spinner"
  | "success"
  | "warning"
  | "stopped";

export interface OffPeakStatusFooterPresentation {
  icon: OffPeakStatusIconKind;
  className: string;
  labelId: string;
  labelValues?: Record<string, string>;
}

/**
 * 只同步仍保持自动默认值的创建态标题。
 * locale 切换后不能覆盖用户输入、模板草稿或已保存任务标题。
 */
export function resolveLocalizedOffPeakCreateTitle({
  currentTitle,
  hasInitialTitle,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialTitle: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (
    isEditing ||
    hasInitialTitle ||
    titleTouched ||
    currentTitle !== previousDefaultTitle
  ) {
    return currentTitle;
  }
  return nextDefaultTitle;
}

/** 闲时卡片状态图标与文案的唯一映射，避免带位次的 paused 被误画成 queued 月亮。 */
// resolveOffPeakStatusFooter() 是状态映射的唯一来源。
// queuePosition 决定排队与暂停使用带位次的 labelId。
// completed 与 cancelled 的 className 统一用弱化色。
export function resolveOffPeakStatusFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation {
  switch (task.status) {
    case "queued":
      return task.queuePosition
        ? {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.badge.queuePosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.status.queued",
          };
    case "paused":
      return task.queuePosition
        ? {
            icon: "pause",
            // Paused 与 Queued 都是仍需关注的排队状态，设计稿使用同一品牌弱强调胶囊。
            className: "text-idle-task",
            labelId: "offPeak.badge.pausedPosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "pause",
            className: "text-idle-task",
            labelId: "offPeak.status.paused",
          };
    case "running":
      return {
        icon: "spinner",
        className: "text-success",
        labelId: "offPeak.status.running",
      };
    case "completed":
      return {
        icon: "success",
        // 完成是无需继续关注的静态终态，success 高亮会让它比活跃任务更抢眼。
        className: "text-foreground-subtle",
        labelId: "offPeak.status.completed",
      };
    case "failed":
      return {
        icon: "warning",
        className: "text-destructive",
        labelId: "offPeak.status.failed",
      };
    case "cancelled":
      return {
        icon: "stopped",
        className: "text-foreground-subtle",
        labelId: "offPeak.status.cancelled",
      };
  }
}

/** 终态任务不会再被调度，不能把历史选择失效显示成当前待修复错误。 */
export function shouldShowOffPeakModelSelectionIssue(
  status: Pick<ZCodeOffPeakTask, "status">["status"],
): boolean {
  return status === "queued" || status === "paused" || status === "running";
}

/**
 * 失败任务仍保留服务端返回的排队位次时，单独渲染弱化位次。
 * 主状态映射只能返回一个 footer；失败状态需额外保留队列上下文，避免被 Failure 覆盖。
 */
export function resolveFailedOffPeakQueueFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation | null {
  if (task.status !== "failed" || task.queuePosition === undefined) return null;
  return {
    icon: "moon",
    className: "text-idle-task",
    labelId: "offPeak.badge.queuePosition",
    labelValues: { position: String(task.queuePosition) },
  };
}
