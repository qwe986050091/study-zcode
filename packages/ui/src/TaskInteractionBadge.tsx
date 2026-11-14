// INV-01 展示纯函数：守住位置 getTaskInteractionBadgePresentation；改错故障：判定内直接读时钟或发请求。
// INV-02 旧帧兼容：守住位置 工具名与自动消解兜底；改错故障：历史会话的问答被误判成权限确认。
// INV-03 权限兜底：守住位置 非问答分支；改错故障：未知交互被渲染成问答胶囊。
// INV-04 延后隐藏倒计时：守住位置 snoozed 分支；改错故障：已延后仍显示倒计时并跳动。
// INV-05 未到时刻无进度：守住位置 visibleAt 判断；改错故障：倒计时提前起跳，进度倒退。
// INV-06 进度夹紧：守住位置 进度计算；改错故障：时钟偏差导致进度超出零到一。
// INV-07 时长下限：守住位置 分母取值；改错故障：可见期为零时除零，进度变成无穷。
// INV-08 注入时钟优先：守住位置 renderNow；改错故障：测试固定时间被真实时钟覆盖。
// INV-09 低频校准：守住位置 聚焦与可见性监听；改错故障：连续动画带来无谓重渲染。
// INV-10 卸载对称：守住位置 事件移除；改错故障：重复挂载后监听累积，刷新次数翻倍。
// INV-11 单次延后：守住位置 请求标识引用；改错故障：连点重复提交同一延后请求。
// INV-12 失败回滚：守住位置 同步异常与拒绝分支；改错故障：请求失败后按钮永久失效。
// INV-13 可延后三条件：守住位置 canSnooze；改错故障：无回调时渲染可点按钮，点击无反应。
// INV-14 阻止冒泡：守住位置 按下与点击处理；改错故障：点徽标同时选中整行任务。
// INV-15 语义分叉：守住位置 可延后分支；改错故障：可点态仍用 span，键盘无法触发。
// INV-16 文案同源：守住位置 类型到文案键映射；改错故障：问答与权限显示同一文案。
// INV-17 装饰隐藏：守住位置 倒计时填充与双行切换；改错故障：读屏念出重复标签。
// INV-18 数据属性完整：守住位置 徽标属性；改错故障：端到端测试无法读取倒计时状态。
//
// 模块职责：任务行阻塞交互胶囊的展示判定与延后交互。
// 状态所有权：交互数据由外部持有；本组件只持内部时钟与单次请求标记。
// 阅读顺序：属性 → 展示结构 → 问答判定 → 展示推导 → 组件与延后处理。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ZCodeTaskPendingInteraction } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

// 交互对象与旧的待定标记二选一，缺省都可为空。
// now 只用于测试注入，生产不传。
//
interface TaskInteractionBadgeProps {
  interaction?: ZCodeTaskPendingInteraction;
  legacyPending?: boolean;
  className?: string;
  /** fake-clock / SSR 注入；生产缺省使用当前绝对时间。 */
  now?: number;
  formatMessage: (id: string) => string;
  onSnoozeCountdown?: (interactionId: string) => boolean | Promise<boolean>;
}

// presentation 由 kind、countdownProgress、canSnooze 三个字段组成。
// 进度为 0 到 1，缺省表示无倒计时。
//
export interface TaskInteractionBadgePresentation {
  kind: "permission" | "userInput";
  countdownProgress?: number;
  canSnooze: boolean;
}

// 非用户输入类型一律不是 Ask 交互。
// 旧 sessions-index 帧没有 toolName，autoResolution 是恢复时的兜底判据。
// toolName 经 trim().toLowerCase() 归一后再与 "askuserquestion" 比较。
// autoResolution 只在恢复历史帧时参与判定，新帧由 toolName 主判。
//
export function isAskUserQuestionInteraction(
  interaction: ZCodeTaskPendingInteraction | undefined,
): boolean {
  if (!interaction || interaction.kind !== "userInput") return false;
  // 旧 sessions-index 摘要没有 toolName；autoResolution 只属于普通 AskUserQuestion，
  // 因此可作为恢复旧帧时的兼容判据。
  return (
    interaction.toolName?.trim().toLowerCase() === "askuserquestion" ||
    interaction.autoResolution !== undefined
  );
}

// 无交互但有旧待定标记时降级为权限确认。
// 非 Ask 交互一律按权限确认处理。
// 缺少自动消解时先稳定显示问答，允许运行期幂等处理暂停意图。
// 已延后时隐藏倒计时，只保留可延后状态。
// 未到可见时刻不显示进度，避免倒计时提前起跳。
//
export function getTaskInteractionBadgePresentation(
  interaction: ZCodeTaskPendingInteraction | undefined,
  legacyPending: boolean,
  now: number,
): TaskInteractionBadgePresentation | null {
  if (!interaction) {
    return legacyPending ? { kind: "permission", canSnooze: false } : null;
  }
  if (!isAskUserQuestionInteraction(interaction)) {
    return { kind: "permission", canSnooze: false };
  }
  const autoResolution = interaction.autoResolution;
  if (!autoResolution) {
    // permission_requested 与 durable autoResolution event 可能相邻两帧到达；已知工具身份时
    // 先稳定显示 Ask 交互，并允许 runtime 幂等处理提前的暂停意图。
    return { kind: "userInput", canSnooze: true };
  }
  // duration 由 Math.max(1, deadlineAt - visibleAt) 给出，避免相等时除零。
  // progress 按剩余时间线性衰减，再用 Math.min/max 夹到 0–1。
  // now 早于 visibleAt 或晚于 deadlineAt 时都落到边界值。
  // autoResolution.state 缺失按未延后处理，canSnooze 保持 true。
  // 返回值由入参与常量决定，函数无副作用，可直接单测。
  //
  if (autoResolution.state === "snoozed") {
    return { kind: "userInput", canSnooze: false };
  }
  if (now < autoResolution.visibleAt) {
    return { kind: "userInput", canSnooze: true };
  }
  const duration = Math.max(1, autoResolution.deadlineAt - autoResolution.visibleAt);
  const progress = Math.max(0, Math.min(1, (autoResolution.deadlineAt - now) / duration));
  return { kind: "userInput", countdownProgress: progress, canSnooze: true };
}

/** 普通、timeline、grouped task row 共用的阻塞交互胶囊。 */
// 注入时间优先，测试可固定时钟。
// injectedNow 优先；未注入时 clockNow 只在 focus/visibilitychange 时校准一次。
// 展示结果为 null 时整块不渲染。
//
export function TaskInteractionBadge({
  interaction,
  legacyPending = false,
  className,
  now: injectedNow,
  formatMessage,
  onSnoozeCountdown,
}: TaskInteractionBadgeProps) {
  const [clockNow, setClockNow] = useState(Date.now);
  const snoozeRequestedInteractionIdRef = useRef<string | null>(null);
  const renderNow = injectedNow ?? clockNow;

  useEffect(() => {
    if (injectedNow !== undefined) return;
    // reduced-motion 不连续动画；窗口重新活跃时只按绝对 deadline 校准一次。
    const refresh = () => setClockNow(Date.now());
    // 原因：task row 通常比 pending interaction 存活更久；新问答或阶段事件到达时若沿用
    // row mount 时的旧 clock，可能把 visibleCountdown 误判成仍在静默期。
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    injectedNow,
    interaction?.interactionId,
    interaction?.autoResolution?.state,
    interaction?.autoResolution?.startedAt,
  ]);

  const presentation = getTaskInteractionBadgePresentation(interaction, legacyPending, renderNow);
  if (!presentation) return null;

  const label = formatMessage(
    presentation.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
  );
  const snoozeLabel = formatMessage("taskList.stopCountdown");
  const progress = presentation.countdownProgress;
  const autoResolution = interaction?.autoResolution;
  const remainingMs =
    progress !== undefined && autoResolution && autoResolution.state !== "snoozed"
      ? Math.max(0, autoResolution.deadlineAt - renderNow)
      : 0;
  const style =
    progress !== undefined
      ? ({
          "--zcode-interaction-progress": String(progress),
          "--zcode-interaction-remaining-ms": `${remainingMs}ms`,
        } as CSSProperties)
      : undefined;
  const canSnooze = presentation.canSnooze && Boolean(interaction) && Boolean(onSnoozeCountdown);
  const handleSnooze = () => {
    if (!canSnooze || !interaction || !onSnoozeCountdown) return;
    if (snoozeRequestedInteractionIdRef.current === interaction.interactionId) return;
    snoozeRequestedInteractionIdRef.current = interaction.interactionId;
    let snoozeRequest: boolean | Promise<boolean>;
    try {
      snoozeRequest = onSnoozeCountdown(interaction.interactionId);
    } catch {
      snoozeRequestedInteractionIdRef.current = null;
      return;
    }
    void Promise.resolve(snoozeRequest)
      .then((accepted) => {
        if (!accepted && snoozeRequestedInteractionIdRef.current === interaction.interactionId) {
          snoozeRequestedInteractionIdRef.current = null;
        }
      })
      .catch(() => {
        if (snoozeRequestedInteractionIdRef.current === interaction.interactionId) {
          snoozeRequestedInteractionIdRef.current = null;
        }
      });
  };

  const badgeContent = (
    <>
      {progress !== undefined ? (
        <span
          aria-hidden="true"
          className="zcode-task-interaction-countdown-fill absolute inset-0 origin-left bg-interaction-ask-fill transition-opacity group-hover/interaction-badge:opacity-0 group-focus-visible/interaction-badge:opacity-0 motion-reduce:transition-none"
        />
      ) : null}
      {canSnooze ? (
        <span aria-hidden="true" className="relative z-1 grid whitespace-nowrap">
          <span className="col-start-1 row-start-1 transition-opacity group-hover/interaction-badge:opacity-0 group-focus-visible/interaction-badge:opacity-0 motion-reduce:transition-none">
            {label}
          </span>
          <span className="col-start-1 row-start-1 opacity-0 transition-opacity group-hover/interaction-badge:opacity-100 group-focus-visible/interaction-badge:opacity-100 motion-reduce:transition-none">
            {snoozeLabel}
          </span>
        </span>
      ) : (
        <span className="relative z-1 whitespace-nowrap">{label}</span>
      )}
    </>
  );

  const badgeClassName = cn(
    // 原因：权限确认和用户问答使用相同的“等待确认”文案，颜色分叉会让同一状态看似不一致。
    "relative inline-flex h-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-transparent bg-interaction-confirmation-surface px-2 text-ui-sm font-medium text-interaction-confirmation-foreground",
    className,
  );

  if (canSnooze) {
    return (
      <button
        type="button"
        data-task-interaction-badge={presentation.kind}
        data-slot="badge"
        data-countdown-progress={progress?.toFixed(3)}
        data-countdown-snoozable="true"
        aria-label={snoozeLabel}
        className={cn(
          "group/interaction-badge cursor-pointer transition-colors hover:bg-secondary hover:text-foreground focus-visible:bg-secondary focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused motion-reduce:transition-none",
          badgeClassName,
        )}
        style={style}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleSnooze();
        }}
      >
        {badgeContent}
      </button>
    );
  }

  return (
    <span
      data-task-interaction-badge={presentation.kind}
      data-slot="badge"
      data-countdown-progress={progress?.toFixed(3)}
      className={badgeClassName}
      style={style}
    >
      {badgeContent}
    </span>
  );
}
