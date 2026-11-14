// INV-01 单实例：守住位置 模块级 store 常量；改错故障：跨窗口共享状态，关一次所有窗口都不再提醒。
// INV-02 阶段合并：守住位置 dismiss 的 sameOpportunity 分支；改错故障：同一机会重复关闭时把另一阶段标志清零。
// INV-03 阈值换算：守住位置 紧急阈值判断的乘 1000；改错故障：秒与毫秒混用，紧急态永不触发或立刻触发。
// INV-04 键稳定：守住位置 opportunityKey 的拼接；改错故障：键随渲染变化，已读状态对不上而反复弹窗。
// INV-05 空值优先：守住位置 提醒解析的前置守卫；改错故障：缺来源或过期时间时仍然渲染空提醒。
// INV-06 上取整：守住位置 remainingSeconds 的计算；改错故障：倒计时跳秒或出现负数。
// INV-07 阶段单一来源：守住位置 phase 的推导；改错故障：触发器与提醒对紧急的判断不一致。
// INV-08 引用稳定：守住位置 getSnapshot 返回值；改错故障：每次返回新对象导致订阅方无限重渲染。
// INV-09 退订完整：守住位置 subscribe 返回的清理函数；改错故障：监听集合只增不减。
// INV-10 图标语义：守住位置 关闭按钮的 aria-label；改错故障：读屏与自动化都无法定位关闭动作。
// INV-11 冒泡隔离：守住位置 关闭按钮的 pointerdown 与 click；改错故障：点击关闭同时触发外部点击处理器。
// INV-12 外部判定：守住位置 shouldDismiss 的 contains 检查；改错故障：点击触发器自身就关掉提醒。
// INV-13 非节点容错：守住位置 目标类型守卫；改错故障：事件目标不是节点时抛错。
// INV-14 文案集中：守住位置 两条 intl 消息 id；改错故障：硬编码文案绕过本地化。
// INV-15 倒计时来源：守住位置 紧急阶段倒计时格式化；改错故障：与配额弹窗的倒计时算法分叉。
// INV-16 阶段数据标记：守住位置 data-context-reset-reminder 属性；改错故障：外部点击判定找不到提醒自身。
// INV-17 纯函数约束：守住位置 触发器与提醒解析；改错故障：在解析里写状态导致同输入不同输出。
// INV-18 数量守卫：守住位置 count 的正数判断；改错故障：数量为零时仍提示存在可重置额度。
//
// 模块职责：解析上下文配额重置机会的提醒阶段、已读状态与触发器配色，并渲染提醒内容。
// 状态所有权：已读快照归模块级 store，组件只订阅；提醒阶段由入参与当前时间纯推导。
// 阅读顺序：常量与类型 → 已读 store → 触发器与提醒解析 → 内容组件 → 关闭按钮。
import { AlarmClock, GiftIcon, XIcon } from "lucide-react";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCodingPlanQuotaResetCountdown } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { Button } from "@/components/ui/button.js";

// 紧急阈值：剩余秒数进入 180s 才把提醒从 initial 升到 urgent，改大改小会改变提醒出现的时机。
// 只有一处来源：触发器配色与提醒阶段都读它，任何一侧硬编码常量都会让两处判断漂移。
// 该值是秒，比较前必须乘 1000 换算成毫秒，漏乘会让紧急态永不触发。
//
export const CONTEXT_QUOTA_RESET_URGENT_SECONDS = 180;

export type ContextQuotaResetOpportunityReminderPhase = "initial" | "urgent";

// 已读快照：记录哪个重置机会被哪一阶段关掉，避免关掉后同一次机会反复弹出。
// opportunityKey 换值即视为新机会，initial 与 urgent 两阶段各自独立记忆，互不覆盖。
// 对象不可变，每次关闭都整体替换快照，订阅方靠引用变化感知更新。
//
export interface ContextQuotaResetOpportunityDismissal {
  opportunityKey: string | null;
  initial: boolean;
  urgent: boolean;
}

export interface ContextQuotaResetOpportunity {
  count: number;
  expiresAt: number | null;
  sourceKey: string | null;
  visible: boolean;
}

export interface ContextQuotaResetOpportunityReminder {
  count: number;
  opportunityKey: string;
  phase: ContextQuotaResetOpportunityReminderPhase;
  remainingSeconds: number;
}

// 工厂：为每个 renderer 窗口生成独立的已读状态容器，不依赖持久化存储。
// 关闭动作做阶段合并：同一机会重复关闭只累加阶段标志，换机会则整体重置。
// getSnapshot 必须返回稳定引用，否则订阅方会陷入无限重渲染。
// subscribe 返回退订函数，组件卸载时必须调用，防止监听集合泄漏。
// [并发] 监听回调同步逐个执行，回调内不得再次触发关闭，否则会递归通知。
//
export function createContextQuotaResetOpportunityDismissalStore() {
  let snapshot: ContextQuotaResetOpportunityDismissal = {
    opportunityKey: null,
    initial: false,
    urgent: false,
  };
  const listeners = new Set<() => void>();

  return {
    dismiss(reminder: ContextQuotaResetOpportunityReminder) {
      const sameOpportunity = snapshot.opportunityKey === reminder.opportunityKey;
      snapshot = {
        initial: sameOpportunity
          ? snapshot.initial || reminder.phase === "initial"
          : reminder.phase === "initial",
        opportunityKey: reminder.opportunityKey,
        urgent: sameOpportunity
          ? snapshot.urgent || reminder.phase === "urgent"
          : reminder.phase === "urgent",
      };
      listeners.forEach((listener) => listener());
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// 会话切换会重新挂载 composer；已读状态必须归当前 renderer 窗口所有，
// 否则同一个重置机会会在每次切换会话后重新弹出。模块实例天然按窗口隔离且不落盘。
export const contextQuotaResetOpportunityDismissalStore =
  createContextQuotaResetOpportunityDismissalStore();

export type ContextQuotaResetOpportunityTriggerTone = "available" | "urgent";

// 触发器配色：可用回 available（常规高亮），临近过期回 urgent（警示色）。
// 返回 null 表示这次机会不该渲染触发器，调用方据此彻底隐藏入口。
// 判定顺序固定：不可见、数量为零、无过期时间、无来源键、已过期，任一成立即退出。
//
export function resolveContextQuotaResetOpportunityTriggerTone({
  now,
  opportunity,
}: {
  now: number;
  opportunity: ContextQuotaResetOpportunity;
}): ContextQuotaResetOpportunityTriggerTone | null {
  const { count, expiresAt, sourceKey, visible } = opportunity;
  if (!visible || count <= 0 || expiresAt === null || !sourceKey || expiresAt <= now) {
    return null;
  }
  return expiresAt - now <= CONTEXT_QUOTA_RESET_URGENT_SECONDS * 1_000 ? "urgent" : "available";
}

// 提醒解析：把机会与已读快照合成当前该显示的提醒，已读阶段直接返回 null。
// 机会键由来源与过期时间拼成，两者不变即同一次机会，换值即重新提醒。
// 剩余秒数向上取整并夹到零，避免倒计时出现负数或跳过整秒。
// 阶段只取决于剩余秒数：低于紧急阈值转 urgent，其余按 initial 处理。
// [权衡] 同一机会的 initial 与 urgent 分别记忆，用户关掉初始提醒后仍会收到紧急提醒。
//
export function resolveContextQuotaResetOpportunityReminder({
  dismissal,
  now,
  opportunity,
}: {
  dismissal: ContextQuotaResetOpportunityDismissal;
  now: number;
  opportunity: ContextQuotaResetOpportunity;
}): ContextQuotaResetOpportunityReminder | null {
  const { count, expiresAt, sourceKey, visible } = opportunity;
  if (!visible || count <= 0 || expiresAt === null || !sourceKey || expiresAt <= now) {
    return null;
  }

  const opportunityKey = `${sourceKey}:${expiresAt}`;
  const sameOpportunity = dismissal.opportunityKey === opportunityKey;
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const phase: ContextQuotaResetOpportunityReminderPhase =
    remainingSeconds <= CONTEXT_QUOTA_RESET_URGENT_SECONDS ? "urgent" : "initial";
  if (sameOpportunity && dismissal[phase]) {
    return null;
  }

  return { count, opportunityKey, phase, remainingSeconds };
}

export function resolveContextTriggerTooltipKind(
  resetStatus: "processing" | "completed" | null,
  opportunityPhase: ContextQuotaResetOpportunityReminderPhase | null,
): "reset-status" | ContextQuotaResetOpportunityReminderPhase | null {
  return resetStatus ? "reset-status" : opportunityPhase;
}

// 外部点击判定：`trigger.contains(target)` 为真时直接返回 false，保留提醒。
// 触发器等节点缺失时返回 false，宁可少关一次也不误关提醒。
// 目标落回提醒自身（用数据属性标记）同样不算外部点击，避免点关闭按钮前先被关。
//
export function shouldDismissContextQuotaResetOpportunityReminder(
  target: EventTarget | null,
  trigger: HTMLElement | null,
): boolean {
  if (!(target instanceof Node) || trigger?.contains(target)) {
    return false;
  }
  const targetElement = target instanceof Element ? target : target.parentElement;
  return !targetElement?.closest("[data-context-reset-reminder]");
}

export function ContextQuotaResetOpportunityReminderContent({
  count,
  intl,
  onDismiss,
  phase,
  remainingSeconds,
}: {
  count: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDismiss: () => void;
  phase: ContextQuotaResetOpportunityReminderPhase;
  remainingSeconds: number;
}) {
  // initial 阶段：`GiftIcon` + 可用提示 + 关闭按钮，语气是告知而非催促。
  // urgent 阶段：`AlarmClock` + 倒计时徽标，用警告色强化剩余时间。
  //
  if (phase === "initial") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-ui-sm"
        data-context-reset-reminder="initial"
      >
        <GiftIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        <span>
          {intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.available" }, { count })}
        </span>
        <ContextQuotaResetOpportunityDismissButton intl={intl} onDismiss={onDismiss} />
      </span>
    );
  }

  const countdown = formatCodingPlanQuotaResetCountdown(remainingSeconds, intl.formatMessage);
  return (
    <span
      role="status"
      className="inline-flex items-center gap-0 text-ui-sm"
      data-context-reset-reminder="urgent"
    >
      <span className="inline-flex items-center gap-1.5" data-context-reset-reminder-copy>
        <span
          className="inline-flex shrink-0 origin-bottom animate-zcode-alarm-ring text-warning motion-reduce:animate-none"
          aria-hidden="true"
        >
          <AlarmClock className="size-3.5" />
        </span>
        <span>
          {intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.expiresIn" })}{" "}
          <span className="inline-flex h-3.5 items-center rounded-full bg-warning/10 px-1.5 text-ui-xs leading-none font-medium tabular-nums text-warning">
            {countdown}
          </span>
        </span>
      </span>
      <ContextQuotaResetOpportunityDismissButton intl={intl} onDismiss={onDismiss} />
    </span>
  );
}

// 关闭按钮：`onPointerDown` 与 `onClick` 都调 stopPropagation，避免外部点击处理器连容器一起关。
// 图标按钮必须有 aria-label，文案走 intl，供读屏与自动化定位。
//
function ContextQuotaResetOpportunityDismissButton({
  intl,
  onDismiss,
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDismiss: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-foreground-subtle"
      aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.contextReminder.dismiss" })}
      data-context-reset-reminder-dismiss
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
    >
      <XIcon aria-hidden="true" />
    </Button>
  );
}
