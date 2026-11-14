// INV-01 成功动效只能由服务端 completedAt 驱动：守住位置是 awaitingOwnCompletionRef 与 successCompletedAt 的赋值顺序；改错故障是点击即撒花，服务端拒绝后用户看到假成功。
// INV-02 previousCompletedAtRef 必须先写回再比较：守住位置是完成态效果的函数开头两行；改错故障是把比较放在写回之前，跳变永远判定为无变化而丢失动效。
// INV-03 本机 arm 标记只在真实点击分支置真：守住位置是点击处理里的赋值；改错故障是渲染期或效果里无条件置真，别人触发的重置也被当成本机结果。
// INV-04 自动补播的幂等标记必须在撒花成功后才写入：守住位置是延帧回调的末端；改错故障是提前写入，锚点未挂载时既没播花又永久失去补播机会。
// INV-05 自动补播要延后一帧并校验锚点仍然连接：守住位置是帧回调与清理函数；改错故障是浮层刚提交就读锚点，粒子从错误坐标炸开甚至抛错。
// INV-06 按钮可用性取服务端 processing 与本地 localProcessing 的并集：守住位置是 effectiveProcessing 派生；改错故障是只看一路，本地请求期间按钮仍可再点。
// INV-07 localProcessing 必须在 finally 中复位：守住位置是请求链的收尾分支；改错故障是失败路径漏复位，按钮永久转圈且再也无法重试。
// INV-08 失败时必须清除本机 arm 标记：守住位置是 catch 分支；改错故障是标记余留，之后任意一次他人完成都会被误认成本机成功并撒花。
// INV-09 成功勾选的展示窗口由 600 毫秒常量与超时效果共同界定：守住位置是常量与依赖它的定时效果；改错故障是缺失定时器，勾选永久停留并吞掉重置入口。
// INV-10 成功态渲染优先级高于已完成态与按钮态：守住位置是三个返回分支的先后顺序；改错故障是顺序对调，完成瞬间直接跳到已重置文案，用户看不到任何反馈。
// INV-11 awaitingSuccessRender 要在渲染期补齐状态更新前的一帧空窗：守住位置是它的三条件合取推导；改错故障是只依赖 successCompletedAt，父级更新早于效果时闪回按钮。
// INV-12 completedAt 非空即代表机会已被服务端核销：守住位置是已完成分支的提前返回；改错故障是完成态仍渲染可点按钮，用户能重复消耗已用完的额度。
// INV-13 打开弹窗与直接重置是互斥的两种行为：守住位置是联合类型与展开式回调传递；改错故障是同时传入两个回调，入口语义分裂为既开弹窗又发请求。
// INV-14 已重置文案的最小高度要与按钮 xs 尺寸对齐：守住位置是 min-h-5 这个内联类名；改错故障是完成态把额度条标签行撑高，整列数值与进度条错位。
// INV-15 提示气泡只在拿到完成时间时才可聚焦：守住位置是 tabIndex 的条件赋值；改错故障是无提示也进入 Tab 序列，键盘用户停在没有任何信息的元素上。
// INV-16 所有定时器与帧回调都要在清理函数里撤销：守住位置是两个效果的收尾返回；改错故障是浮层关闭后仍撒花，或对已摘除实例继续写入状态。
// INV-17 重置类型只影响文案不影响行为：守住位置是 resetType 的默认值与三元选择；改错故障是周额度沿用五小时文案，无障碍播报的周期与实际不符。
// INV-18 完成时间格式化固定两位小时与 24 小时制：守住位置是 hourCycle 与时位配置；改错故障是跨语言环境出现下午三时这类宽文本，撑破紧凑的标签行。
//
// 模块职责：五小时与周额度共用的重置入口展示层，负责按下、处理中、已完成、成功勾选四种视觉状态与撒花时机，本身不发请求也不持有配额真值。
// 状态所有权：配额真值与 used_at 归父级与服务端，localProcessing、successCompletedAt、arm 标记与已补播标记只归本组件实例，实例卸载即全部失效。
// 阅读顺序：先看本地化包装层如何只映射文案，再看两个效果如何识别服务端跳变与补播，最后看三个返回分支的优先级与点击守卫。
import { CheckIcon, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

// 成功勾选的停留时长是产品节奏的选择，而不是动画时长，600 毫秒让用户读得到反馈又不挡住下一次操作。
// 这个窗口只服务手动重置后的短暂成功态，自动补播路径不会进入该分支，因此两处节奏可以各自独立。
// 抽成模块常量而非内联，是为了让测试与设计评审对齐同一个数值，避免改动散落在样式与逻辑两侧。
// 调大会让连续重置的用户以为按钮卡死，调小则勾选一闪而过，等于没有反馈。
// [权衡] `MANUAL_RESET_SUCCESS_DISPLAY_MS` 与 `burstCodingPlanQuotaResetConfetti` 解耦后两处节奏可分别调整，代价是勾选已收回时粒子可能仍在飘。
// 若改成等动画结束再收起，就需要额外回调进来，反而扩大了这个纯展示组件的职责边界。
const MANUAL_RESET_SUCCESS_DISPLAY_MS = 600;

type CodingPlanQuotaResetActionBehavior =
  | { onOpenDialog: () => void; onReset?: never }
  | { onOpenDialog?: never; onReset: () => Promise<void> };

export function LocalizedCodingPlanQuotaResetAction({
  completedAt,
  processing,
  onOpenDialog,
  onReset,
  autoCelebrateCompletedAt,
  onAutoCelebrated,
  resetType = "FIVE_HOUR",
}: {
  completedAt: number | null;
  processing: boolean;
  /** 自动/运营完成时由 Composer 触发器在 hover 展开面板后要求补播撒花的 used_at；手动重置为 null。 */
  autoCelebrateCompletedAt?: number | null;
  onAutoCelebrated?: (completedAt: number) => void;
  /** 五小时与周额度共用同一按钮组件，仅无障碍/处理中文案按类型区分。 */
  resetType?: CodingPlanResetType;
} & CodingPlanQuotaResetActionBehavior) {
  const { intl, locale } = useZCodeIntl();
  const completedTime = completedAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(completedAt)
    : null;

  return (
    <CodingPlanQuotaResetAction
      ariaLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.resetAriaWeek"
            : "codingPlan.quotaReset.resetAria",
      })}
      autoCelebrateCompletedAt={autoCelebrateCompletedAt}
      completedAt={completedAt}
      completedLabel={intl.formatMessage({
        id: "codingPlan.quotaReset.completed",
      })}
      completedTooltipLabel={
        completedTime
          ? intl.formatMessage({ id: "codingPlan.quotaReset.completedAt" }, { time: completedTime })
          : undefined
      }
      processing={processing}
      processingLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.processingWeek"
            : "codingPlan.quotaReset.processing",
      })}
      resetLabel={intl.formatMessage({ id: "codingPlan.quotaReset.reset" })}
      successLabel={intl.formatMessage({ id: "codingPlan.quotaReset.success" })}
      onAutoCelebrated={onAutoCelebrated}
      {...(onOpenDialog ? { onOpenDialog } : { onReset: onReset! })}
    />
  );
}

export function CodingPlanQuotaResetAction({
  ariaLabel,
  autoCelebrateCompletedAt,
  completedAt,
  completedLabel,
  completedTooltipLabel,
  processing,
  processingLabel,
  resetLabel,
  successLabel,
  onAutoCelebrated,
  onOpenDialog,
  onReset,
  onCelebrate = burstCodingPlanQuotaResetConfetti,
}: {
  ariaLabel: string;
  autoCelebrateCompletedAt?: number | null;
  completedAt: number | null;
  completedLabel: string;
  completedTooltipLabel?: string;
  processing: boolean;
  processingLabel: string;
  resetLabel: string;
  successLabel: string;
  onAutoCelebrated?: (completedAt: number) => void;
  onCelebrate?: (origin: HTMLElement) => void;
} & CodingPlanQuotaResetActionBehavior) {
  const [localProcessing, setLocalProcessing] = useState(false);
  const [successCompletedAt, setSuccessCompletedAt] = useState<number | null>(null);
  // `previousCompletedAtRef` 存上一次渲染看到的 `completedAt`：用来识别服务端刚把值推进到新时间的那次跳变。
  // 用 ref 而非状态承接基线，是因为比较本身不该触发重渲染，也不该把旧值牵连进依赖数组。
  // [并发] 父级连续两次推送同一个时间戳时，相等比较把后一次判为噪声，避免重复撒花。
  // 必须先写回基线再判断是否变化，否则每次都是新值与新值相比，跳变永远检测不到。
  // 两份基线并存：ref 负责首帧之后的比较，渲染期推导负责首帧之内的空窗。
  // 若换成普通变量，重渲染会重置基线，成功动效将在每次父级更新时被反复触发。
  const previousCompletedAtRef = useRef(completedAt);
  const clickedOriginRef = useRef<HTMLElement | null>(null);
  const awaitingOwnCompletionRef = useRef(false);
  // 自动/运营完成时的“已重置”文案元素，用于从与手动重置相同的位置补播撒花。
  const completedTextRef = useRef<HTMLSpanElement | null>(null);
  const autoCelebratedCompletedAtRef = useRef<number | null>(null);
  // 本地请求与服务端推送各持有一半待定语义，按钮可用性必须取二者的并集。
  // 父级的处理中覆盖重置已被受理、结果未回这一窗口，本地处理中覆盖请求刚发出、父级尚未刷新这一窗口。
  // 只认其中一路会留出空档，空档内按钮仍可点击，重复点击就会重复消耗重置机会。
  // [权衡] 取并集让状态机保持简单，但两路都结束前按钮一直禁用，视觉上可能比真实请求更久。
  // 禁用属性与点击守卫都要读这个派生值，任何一处漏用都会在空档内放行第二次点击。
  // 它不参与成功态判断，成功只看服务端时间戳，避免本地布尔值伪造出完成。
  const effectiveProcessing = processing || localProcessing;

  useEffect(() => {
    const previousCompletedAt = previousCompletedAtRef.current;
    previousCompletedAtRef.current = completedAt;
    if (
      completedAt === null ||
      completedAt === previousCompletedAt ||
      !awaitingOwnCompletionRef.current
    ) {
      return;
    }

    // 成功动效只能由服务端 used_at 驱动，不能在点击时用 Date.now() 乐观伪造完成。
    awaitingOwnCompletionRef.current = false;
    setSuccessCompletedAt(completedAt);
    if (clickedOriginRef.current) {
      onCelebrate(clickedOriginRef.current);
    }
  }, [completedAt, onCelebrate]);

  // 自动/运营重置：用户 hover 触发器展开面板后（Composer 传入 autoCelebrateCompletedAt），
  // 从“已重置”文案位置补播一次撒花。手动重置由上方点击分支撒花，此处不会命中（未 arm）。
  useEffect(() => {
    if (
      autoCelebrateCompletedAt == null ||
      completedAt === null ||
      autoCelebrateCompletedAt !== completedAt ||
      autoCelebratedCompletedAtRef.current === completedAt
    ) {
      return;
    }

    // 不能在浮层刚提交 DOM 时立即消费 arm：面板尚未完成挂载/定位就可能播放完动画。
    // 延后一帧确认锚点仍连接在文档中，且只有真正调用撒花后才标记已播放；关闭浮层会取消该帧。
    const frameId = window.requestAnimationFrame(() => {
      const origin = completedTextRef.current;
      if (!origin?.isConnected) {
        return;
      }
      onCelebrate(origin);
      autoCelebratedCompletedAtRef.current = completedAt;
      onAutoCelebrated?.(completedAt);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [autoCelebrateCompletedAt, completedAt, onAutoCelebrated, onCelebrate]);

  useEffect(() => {
    if (successCompletedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setSuccessCompletedAt(null),
      MANUAL_RESET_SUCCESS_DISPLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [successCompletedAt]);

  // 成功态需要一个父级已推新值、效果尚未执行的渲染结果，否则会闪回可点按钮一帧。
  // [并发] 效果在提交之后才运行，父级改掉完成时间的同一帧里，成功时间状态仍是旧值。
  // `awaitingSuccessRender` 在渲染期补一个三条件合取：`completedAt` 有值 / 由本机发起 / 与基线不同。
  // 三个条件各司其职：缺第一个会以空值进入成功态，缺第二个会把他人重置当成本机结果，缺第三个会在旧值上反复成立。
  // 它与基线比较是同一判断的两个时机，两处条件必须保持一致，改一处就要同步另一处。
  // 若改用额外状态承接，会多一次提交，空窗从一帧变成两帧，反而更容易被看见闪烁。
  const awaitingSuccessRender = Boolean(
    completedAt !== null &&
    awaitingOwnCompletionRef.current &&
    completedAt !== previousCompletedAtRef.current,
  );
  const showSuccess =
    completedAt !== null && (successCompletedAt === completedAt || awaitingSuccessRender);

  if (showSuccess) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={successLabel}
        disabled
        className="rounded-md px-1 text-ui-sm text-success hover:text-success"
      >
        <CheckIcon
          className="size-3 animate-in zoom-in-75 motion-reduce:animate-none"
          aria-hidden="true"
        />
      </Button>
    );
  }

  // 走到这个分支说明服务端已经给出完成时间，本组件从此不再提供任何重置入口。
  // 配额状态的所有权完全在父级与服务端，这里只做只读呈现，不缓存也不推算剩余次数。
  // [资源] 只保留文案而不渲染按钮，是为了让同一行的高度与宽度在几种状态之间保持稳定。
  // 提示气泡与可聚焦性同源：有完成时间才挂气泡才给 Tab 位，没有时间就保持纯文本。
  // [权衡] 时间格式化留在本地化包装层，使这个纯组件不依赖国际化上下文，便于单独渲染测试。
  // 如果在这里允许点击重试，就等于给了客户端绕过服务端核销的入口。
  if (completedAt !== null) {
    const completedText = (
      <span
        ref={completedTextRef}
        // min-h 与「重置」按钮的 xs 尺寸(h-5)一致:三种状态等高,避免完成态把
        // 所在额度条的标签行撑高,导致同排其他额度条的数值与进度条错位。
        className="inline-flex min-h-5 items-center text-ui-xs text-foreground-subtlest tabular-nums"
        tabIndex={completedTooltipLabel ? 0 : undefined}
      >
        {completedLabel}
      </span>
    );

    return completedTooltipLabel ? (
      <ControlHintTooltip title={completedTooltipLabel}>{completedText}</ControlHintTooltip>
    ) : (
      completedText
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={effectiveProcessing ? processingLabel : ariaLabel}
      disabled={effectiveProcessing}
      className="rounded-md bg-interaction-confirmation-surface px-1 text-ui-sm text-interaction-confirmation-foreground hover:bg-interaction-confirmation-surface hover:text-interaction-confirmation-foreground"
      onClick={(event) => {
        if (effectiveProcessing || completedAt) {
          return;
        }
        // 页面额度标题旁入口只负责打开统一弹窗；不预先进入 processing，也不直接核销机会。
        if (onOpenDialog) {
          onOpenDialog();
          return;
        }
        clickedOriginRef.current = event.currentTarget;
        awaitingOwnCompletionRef.current = true;
        setLocalProcessing(true);
        // 触发条件是按钮当前可点：既不在任何处理中状态，也没有已完成的完成时间。
        // 点击时先落本机标记再发请求，顺序反了会在极快响应下错过这次完成跳变。
        // [失败路径] 请求失败只回滚本机标记与本地处理中，不播成功动效，提示文案由联调层统一走 toast。
        // 故意不在这里落地用户可见的错误文案，是因为失败语义与配额域耦合，展示口径需要单点维护。
        // 请求以即发即忘方式挂起，不阻塞渲染；卸载后回调只会落在已摘除实例上，不会回写到界面。
        // [事务] 服务端核销与本地乐观态之间没有补偿接口，所以任何本地成功暗示都必须等服务端确认。
        void onReset()
          .catch(() => {
            // 失败文案由联调 hook 统一 toast；Action 只负责恢复交互且不播放成功动效。
            awaitingOwnCompletionRef.current = false;
          })
          .finally(() => {
            setLocalProcessing(false);
          });
      }}
    >
      {effectiveProcessing ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        resetLabel
      )}
    </Button>
  );
}
