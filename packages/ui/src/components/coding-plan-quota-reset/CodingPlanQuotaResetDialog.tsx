// CodingPlanQuotaResetDialog.tsx —— 编码计划配额重置的确认弹框：剩余用量、可核销行、倒计时与成功/收起动画
// INV-01 不可逆核销只从 resetLimit 发出，本文件不提供第二个触发点；守住位置：核销按钮的 onClick；改错故障：多一个入口等于跳过一次确认，用户误触即永久消耗一张机会
// INV-02 核销在途时全部行一起禁用，而不只禁用被点的那一行；守住位置：resetLimit 的入口守卫与 Button 的 disabled；改错故障：并行发起两次不可逆核销，后到者必然失败却已扣减
// INV-03 成功态必须先完整停留 SUCCESS_DISPLAY_MS 才允许收起；守住位置：settleTimer 与 removeTimer 的两级延时；改错故障：行在成功图标出现前塌陷，用户误以为失败并再点一次
// INV-04 两级延时句柄都必须登记进 timersRef，关闭弹框与卸载时逐个清理；守住位置：open 变化的清理分支与空依赖卸载 effect；改错故障：旧任务向新弹框写状态，刚打开就有行莫名消失
// INV-05 关闭后重开必须把 resettingType、successfulType、exitingType 三个动画态同时复位；守住位置：open 由假变真的分支；改错故障：上次的 loading 或收起态被继承，行永久停在不可点击状态
// INV-06 展示行集合只由 config 与三个动画态派生，组件内不得维护张数或到期的第二份副本；守住位置：visibleResetItems 的 filter；改错故障：本地副本与服务端读数分叉，核销一张后余下行渲染成空到期
// INV-07 expiresAt 为 null 只表示「无机会或无到期」，渲染必须用占位符而不是 0；守住位置：到期文案的三元分支；改错故障：出现「0 分 0 秒后过期」这种自相矛盾的读数
// INV-08 可用判据是张数大于 0、到期非空且晚于当前时刻，与外部 helper 保持同口径；守住位置：isResetItemUsable；改错故障：按钮可点但行被过滤，或行在列表里却永远点不出结果
// INV-09 时钟唯一：now 只由每秒定时器推进，渲染期不得各自调用 Date.now；守住位置：now 的 state 与 interval effect；改错故障：同屏两行倒计时互相错位，进度观感抖动
// INV-10 每秒定时器只在 open 期间存在，关闭即清除；守住位置：interval effect 的 return 与 open 依赖；改错故障：关闭后定时器继续唤醒主线程，快速开关会叠加多个时钟
// INV-11 剩余秒数必须向上取整并钳到非负；守住位置：getRemainingSeconds；改错故障：过期瞬间闪出负数秒，用户看到「-1 秒后过期」
// INV-12 倒计时按天、时、分、秒四个分量选择词条，四个变量都必须传入插值；守住位置：formatCodingPlanQuotaResetCountdown 的四条分支；改错故障：词条缺变量时界面直接显示模板占位符
// INV-13 进度条宽度必须钳在 0 到 100 之间，null 按 0 渲染；守住位置：style 的 width 表达式；改错故障：百分比越界后条溢出卡片或被截断，用户误读剩余额度
// INV-14 多张机会必须在行内显式标注张数与最快到期，不得让单一到期时间代表全部机会；守住位置：hasMultipleOpportunities 与即将到期词条的选择；改错故障：用户以为所有机会都在最早那一刻同时失效
// INV-15 核销失败不得关闭弹框，只复位 resettingType 让按钮重新可点；守住位置：resetLimit 的 catch；改错故障：失败即关窗，用户失去上下文，也找不到提示所指的入口
// INV-16 弹框开关一律由外层 onOpenChange 驱动，本文件不得自行关闭；守住位置：Dialog 的 open 与 onOpenChange 透传；改错故障：成功后自行关窗，外层状态未同步，再打开仍是旧配置
// INV-17 成功后的行去留按最新 config 判定，不得使用点击时的 item 快照；守住位置：settleTimer 内对 resetItemsRef 的查找；改错故障：多张机会核销一张后行不收起，或错误收起
// INV-18 上下滚动遮罩只反映真实可滚动余量，行数变化后立即重算；守住位置：readScrollMasks 与依赖 visibleResetItems.length 的 effect；改错故障：只剩一行无需滚动时仍显示渐隐条，暗示下面还有内容
// INV-19 行的进出只通过 grid-rows 与 opacity 过渡表达，退出期间必须 pointer-events-none；守住位置：isExiting 的类名切换；改错故障：正在塌陷的行仍可点击，用户点到已无机会却在动画中的按钮
import type { MouseEvent, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { CheckIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

// 两个时长常量的差值就是收起动画的可用窗口，ROW_EXIT_MS 必须严格大于 SUCCESS_DISPLAY_MS
// 成功态停留 600ms：长于对勾被看清所需的时间，又短于用户第二次点同一行的间隔
// [权衡] 收起 820ms 与成功 600ms 分开定义，而不是在回调里写死一个总数，改节奏时不会算错其中一段
// [资源] 两级延时都由 window.setTimeout 产生句柄并登记进 timersRef，任何路径都不得在渲染期丢弃句柄
// 若差值算成零或负数，收起会与成功态同时启动，对勾还没出现行就开始塌陷
// 这些秒数是交互节奏而非服务端配置，放进 config 会让不同环境出现不同的可点击时长
const SUCCESS_DISPLAY_MS = 600;
const ROW_EXIT_MS = 820;

export interface CodingPlanQuotaResetDialogUsageItem {
  color: string;
  id: string;
  label: string;
  percentage: number | null;
  resetTime?: string;
  value: string;
}

export interface CodingPlanQuotaResetDialogResetItem {
  count: number;
  expiresAt: number | null;
  onReset: () => Promise<void>;
  processing?: boolean;
  resetType: CodingPlanResetType;
}

export interface CodingPlanQuotaResetDialogConfig {
  resetItems: CodingPlanQuotaResetDialogResetItem[];
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
}

// 向上取整让剩余 0.2 秒仍显示 1 秒，倒计时只在真正过期后归零
// 下界 0 只兜住已过期项产生的负差，判活由 isResetItemUsable 提前完成
// now 由上层每秒推进的 state 传入，函数内部不读时钟，同一帧内所有行共享同一时刻
// [权衡] 不做本地累加：设备休眠或页面隐藏后累加值会与到期时刻漂移，每次重算差值天然自愈
// 两个入参都必须是毫秒时间戳，混入秒级值会得到以天计的荒谬读数
function getRemainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

/**
 * 行是否仍持有可核销的机会；与 hasUsableCodingPlanQuotaResetOpportunity 同口径，
 * 只是不排除 processing——核销中的行要保留展示 loading。
 */
function isResetItemUsable(item: CodingPlanQuotaResetDialogResetItem, now: number): boolean {
  return item.count > 0 && item.expiresAt !== null && item.expiresAt > now;
}

export function formatCodingPlanQuotaResetCountdown(
  totalSeconds: number,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  // 先把总秒数拆成天、时、分、秒四个分量，再按分量组合挑选词条，避免为每种组合各写一条文案
  // 小时对 86400 取模、分钟对 3600 取模，逐级剥离已进位部分，少一次取模会显示成 25 小时
  // 秒直接对 60 取模，不再额外钳制，入参已由 getRemainingSeconds 保证是非负整数
  // [权衡] 用四条独立词条而不是拼接单位字符串，各语言的时间单位顺序与复数规则不同，拼接无法本地化
  // 天与小时同时为零时落到分秒词条，最后一分钟仍每秒变化，用户能看出倒计时是活的
  // 四个分量统一转成字符串，i18n 插值只接受字符串，传数字在部分语言下会丢尾零
  // 若改成逐级相减而不取模，分钟会累计成跨小时的总分钟，出现「90 分钟后过期」这类无法对照的读数
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const values = {
    days: String(days),
    hours: String(hours),
    minutes: String(minutes),
    seconds: String(seconds),
  };
  if (days > 0) {
    return hours > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.daysHours" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.daysOnly" }, values);
  }
  if (hours > 0) {
    return minutes > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.hoursMinutes" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.hoursOnly" }, values);
  }
  return formatMessage({ id: "codingPlan.quotaReset.countdown.minutesSeconds" }, values);
}

function readScrollMasks(viewport: HTMLDivElement) {
  return {
    bottom: viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    top: viewport.scrollTop > 1,
  };
}

function resetTypeLabelId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.dialog.week"
    : "codingPlan.quotaReset.dialog.fiveHour";
}

function resetTypeAriaId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.resetAriaWeek"
    : "codingPlan.quotaReset.resetAria";
}

export function CodingPlanQuotaResetDialog({
  config,
  open,
  onOpenChange,
}: {
  config: CodingPlanQuotaResetDialogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const [resettingType, setResettingType] = useState<CodingPlanResetType | null>(null);
  const [successfulType, setSuccessfulType] = useState<CodingPlanResetType | null>(null);
  const [exitingType, setExitingType] = useState<CodingPlanResetType | null>(null);
  const [scrollMasks, setScrollMasks] = useState({ bottom: false, top: false });
  const resetListRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const wasOpenRef = useRef(false);
  // 成功反馈结束时要按最新的 config 决定行去留，延时任务里的 item 是点击时的旧快照。
  const resetItemsRef = useRef(config.resetItems);

  useEffect(() => {
    resetItemsRef.current = config.resetItems;
  }, [config.resetItems]);

  useEffect(() => {
    // 这是关闭与重开的统一收口：只要开关状态变化，先前排下的成功与收起延时全部作废
    // [资源] 先清空句柄数组再逐个清理，避免清理过程中新增的延时混进同一批
    // [失败路径] 不清旧任务时，重开弹框后上一轮的收起定时器会按旧快照把新行收起
    // 三个动画态只在由假变真时复位，关闭期间保留旧值以便外层决定是否重新挂载
    // wasOpenRef 记录上一次渲染的 open，与本次比较才能识别出「变化」而不是「为真」
    // 重开时把 resettingType 归零，让上次卡在 loading 的行恢复可点击
    // [权衡] 用 ref 而不是 state 记录上一次的 open，写 ref 不触发重渲染，也不会让本 effect 自我重入
    if (open !== wasOpenRef.current) {
      // 成功反馈使用延时任务收起行；若用户中途关闭并重新打开，旧任务会污染新弹框状态。
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    }
    if (open && !wasOpenRef.current) {
      setResettingType(null);
      setSuccessfulType(null);
      setExitingType(null);
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    // 每秒推进一次 now，弹框内所有倒计时文本与可见性判断都从这一个快照派生
    // [资源] 清理函数必须清掉同一个句柄，用 effect 返回值而不是另存数组，依赖变化与卸载都会执行
    // [并发] 定时器不保证精确 1 秒，主线程繁忙时回调会延后，因此每次回调都重新读时钟而不是自增
    // 依赖只写 open：把 now 一起放进依赖会在每次 tick 后重建定时器，倒计时退化成不定长间隔
    // [失败路径] 漏掉清理时，快速开关弹框会叠加多个定时器，setNow 被高频调用导致界面闪烁
    // 标签页隐藏时浏览器会节流定时器，重新可见后差值一次跳变，这是可接受的表现
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  // Bugfix：弹框曾在本地另记一份「已核销张数」，与 entry 的机会余额形成两个数据源。
  // 完成态又把余额清零，核销一张后余下的行拿到空到期，渲染成「0 分 0 秒后过期」，
  // 重开弹框才被新 status 校正。现在 completed 如实携带余下机会，张数/到期/能否展示
  // 只读 config；动画中的行（点击 → 成功 → 收起）临时保留。
  // 展示集合是纯派生值：config 加上三个动画态，组件内不存在第二份张数或到期数据
  // 四个条件取或：仍可用、正在核销、刚成功、正在收起，少任一分支都会让行在动画中途被瞬间移除
  // [权衡] 不在成功回调里 setState 维护列表，多一份列表就多一个与服务端读数分叉的来源
  // [事务] 核销后的读数由完成态写回 config，filter 在新 config 到达后自然收缩，不需要手工增删
  // 顺序沿用 config 原序而不按到期时间重排，行不会在核销过程中跳到别处导致用户点错
  // [失败路径] 若只按可用性过滤，最后一张核销成功后行立刻消失，成功图标与彩带都来不及被看到
  // 过滤发生在渲染前而不是 effect 里，首帧不会先展示全部行再收缩
  const visibleResetItems = config.resetItems.filter(
    (item) =>
      isResetItemUsable(item, now) ||
      resettingType === item.resetType ||
      successfulType === item.resetType ||
      exitingType === item.resetType,
  );

  useEffect(() => {
    const viewport = resetListRef.current;
    if (viewport) setScrollMasks(readScrollMasks(viewport));
  }, [visibleResetItems.length]);

  const updateScrollMasks = (event: UIEvent<HTMLDivElement>) => {
    const next = readScrollMasks(event.currentTarget);
    setScrollMasks((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  const resetLimit = async (
    item: CodingPlanQuotaResetDialogResetItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    // 这是重复提交的唯一闸门：只要已有核销在途，后续点击一律丢弃
    // resettingType 是全局单飞标志而不是每行一把，服务端同一时刻只接受一次核销
    // [并发] 判断与随后的 setResettingType 之间没有 await，同步段内第二次点击不可能插入，取锁是原子的
    // 按钮的 disabled 只是视觉层，函数入口的再判断负责兜住键盘回车与双击在置灰前的那段窗口
    // 提交中所有行一起禁用，而不只禁用被点的那一行：任一行核销都会改变其他行的余额与到期
    // item.processing 来自外层状态，代表另一入口已发起核销，本弹框必须让位而不是竞争
    // [失败路径] 删掉这行守卫，双击会发起两次不可逆核销，用户白白损失一张无法退回的机会
    // [权衡] 不用 ref 做锁，state 更新会顺带重渲染把按钮置灰，锁与界面不会出现不一致窗口
    if (resettingType !== null || item.processing) return;
    const origin = event.currentTarget;
    setResettingType(item.resetType);
    try {
      await item.onReset();
      setSuccessfulType(item.resetType);
      burstCodingPlanQuotaResetConfetti(origin);
      // 成功反馈结束时按最新 config 决定去留：同类型仍有余下机会则留在原位恢复可点击
      // （张数与最早到期已由完成态携带），否则收起该行。onReset 在 status 对账写入后才
      // resolve，此时 config 已是核销后的读数。
      // 成功态先停留再决定去留，这 600ms 是用户唯一能看到核销成功的窗口
      // 去留依据是最新 config，onReset 解析时完成态已把余下张数与最早到期写回
      // 同类型仍可用就把三个动画态一起复位，行留在原位恢复可点击，用户可以继续核销下一张
      // [资源] 两级延时都要登记进 timersRef，关闭弹框时统一清理，否则旧任务会污染新弹框
      // 收起段时长用 ROW_EXIT_MS 减去 SUCCESS_DISPLAY_MS，避免把已消耗的成功停留再计一遍
      // [事务] 本地只负责节奏，不参与「还剩几张」的计算，一切余额以对账后的 config 为准
      // [失败路径] 若改用点击时的 item.count 判断，多张机会核销后会被误判为仍有库存，行永不收起
      // 两级延时合成一级会让收起在成功态尚未结束时启动，对勾被提前抹掉
      const settleTimer = window.setTimeout(() => {
        const latest = resetItemsRef.current.find(
          (candidate) => candidate.resetType === item.resetType,
        );
        if (latest && isResetItemUsable(latest, Date.now())) {
          setResettingType(null);
          setSuccessfulType(null);
          return;
        }
        setExitingType(item.resetType);
        const removeTimer = window.setTimeout(() => {
          setResettingType(null);
          setSuccessfulType(null);
          setExitingType(null);
        }, ROW_EXIT_MS - SUCCESS_DISPLAY_MS);
        timersRef.current.push(removeTimer);
      }, SUCCESS_DISPLAY_MS);
      timersRef.current.push(settleTimer);
    // 失败路径的职责边界：弹框不改 config、不关窗、不提示，只把本行的 loading 复位
    // 原因与提示由外层核销逻辑统一处理，弹框再报一次会出现双份提示
    // 不关窗是刻意的：用户需要留在原地看到失败后的余额与到期，再决定是否重试
    // [失败路径] 若在 catch 里回滚本地张数，会与完成态写入的读数打架，重试时显示错误余额
    // 失败分支不写 successfulType，因此对勾不会闪现，彩带也不会被触发
    // [权衡] 不在这里做自动重试，不可逆接口的重复核销代价过高，必须交回用户手动确认
    } catch {
      // 失败原因与 toast 由 useCodingPlanQuotaResetUi 统一处理；弹框只恢复可点击状态。
      setResettingType(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(480px,calc(100vw-2rem))] max-w-none gap-5"
      >
        <DialogTitle className="min-w-0 truncate pr-8 text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "codingPlan.quotaReset.dialog.title" })}
        </DialogTitle>

        <section aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.remaining" })}>
          <div
            className={`grid gap-2 ${getContextQuotaMeterGridClass(config.usageItems.length)} max-sm:grid-cols-1`}
          >
            {config.usageItems.map((item) => (
              <div key={item.id} className="min-w-0 rounded-lg bg-surface p-3">
                <div className="truncate text-ui-sm text-foreground-subtle">{item.label}</div>
                <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                  <span className="text-ui-lg font-semibold leading-none text-foreground">
                    {item.value}
                  </span>
                  {item.resetTime ? (
                    <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                      {item.resetTime}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/50">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                    style={{
                      backgroundColor: item.color,
                      // 宽度写入 style 前完成三件事：null 归零、下界 0、上界 100，缺一层都会画出越界条
                      // percentage 来自服务端用量，正常应在区间内，钳制是防御对账过程中的临时越界
                      // Math.min 与 Math.max 遇到 NaN 都会原样放行，null 只能由空值合并兜住，两者职责不同
                      // [失败路径] 若不钳制，超卖或统计漂移产生的 120% 会让条溢出卡片，用户误以为额度模型出错
                      // 宽度变化依赖持续 500ms 的过渡，数值刷新时是滑动而不是跳变，便于用户感知变化方向
                      width: `${Math.max(0, Math.min(100, item.percentage ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {visibleResetItems.length > 0 ? (
          <section
            aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.resettable" })}
          >
            <div className="relative">
              <div
                ref={resetListRef}
                className="max-h-[262px] overflow-y-auto overscroll-contain pr-1"
                onScroll={updateScrollMasks}
              >
                {visibleResetItems.map((item) => {
                  const success = successfulType === item.resetType;
                  const isExiting = exitingType === item.resetType;
                  const effectiveProcessing = item.processing || resettingType === item.resetType;
                  // 同一类型可能持有多张机会，但服务端 /use 不支持指定核销哪一张，entry 只保留
                  // 张数与最早到期时刻（核销一张后由完成态携带余下的张数/到期）。多张时显式
                  // 标注张数与「最快」，避免用户把最早到期时间误读成全部机会的统一期限。
                  const hasMultipleOpportunities = item.count > 1;
                  return (
                    <div
                      key={item.resetType}
                      className={`grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out last:[&>div]:pb-0 motion-reduce:transition-none ${
                        isExiting
                          ? "pointer-events-none grid-rows-[0fr] opacity-0"
                          : "grid-rows-[1fr] opacity-100"
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden pb-2">
                        <div className="flex min-w-0 items-center gap-3 rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-ui-base text-foreground">
                                {intl.formatMessage({ id: resetTypeLabelId(item.resetType) })}
                              </span>
                              {hasMultipleOpportunities ? (
                                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm text-interaction-confirmation-foreground">
                                  {intl.formatMessage(
                                    { id: "codingPlan.quotaReset.dialog.itemCount" },
                                    { count: item.count },
                                  )}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle tabular-nums">
                              {/* Bugfix：核销掉最后一张后行仍在播放成功/收起动画，此时没有到期时刻；
                                  曾被当作 0 秒渲染成「0 分 0 秒后过期」。用不换行空格占位保持行高。 */}
                              {item.expiresAt === null
                                ? "\u00a0"
                                : intl.formatMessage(
                                    {
                                      id: hasMultipleOpportunities
                                        ? "codingPlan.quotaReset.dialog.expiresInSoonest"
                                        : "codingPlan.quotaReset.dialog.expiresIn",
                                    },
                                    {
                                      time: formatCodingPlanQuotaResetCountdown(
                                        getRemainingSeconds(item.expiresAt, now),
                                        intl.formatMessage,
                                      ),
                                    },
                                  )}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            aria-label={
                              success
                                ? intl.formatMessage({ id: "codingPlan.quotaReset.success" })
                                : intl.formatMessage({ id: resetTypeAriaId(item.resetType) })
                            }
                            className="bg-success text-success-foreground hover:bg-success/80"
                            disabled={Boolean(
                              success ||
                              effectiveProcessing ||
                              (resettingType !== null && resettingType !== item.resetType),
                            )}
                            onClick={(event) => void resetLimit(item, event)}
                          >
                            {success ? (
                              <>
                                <CheckIcon className="size-3.5" aria-hidden="true" />
                                {intl.formatMessage({ id: "codingPlan.quotaReset.completed" })}
                              </>
                            ) : effectiveProcessing ? (
                              <Loader2
                                className="size-3.5 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              intl.formatMessage({ id: "codingPlan.quotaReset.reset" })
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.top ? "opacity-100" : "opacity-0"
                }`}
              />
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.bottom ? "opacity-100" : "opacity-0"
                }`}
              />
            </div>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
