// ============================================================================
// contextUsage.tsx — 工具条 context 用量触发器 + 弹层（上下文 / Coding Plan / Start Plan）
//
// 职责边界：
//   - 一段触发器（进度环）+ 一个弹层，弹层内按数据可用性堆叠三段独立卡片。
//   - 只做展示与本地弹层状态；额度、重置、刷新全部由 props 或 hook 提供。
//   - 不写 Composer，不写 session，不直接请求网络。
//
// 三段数据必须分清（缺一段不能影响另外两段）：
//   taskUsage              上下文窗口占用（used / size / cache / breakdown）。
//   codingPlanUsageRemaining  个人或团队 Coding Plan 额度 + 重置机会。
//   startPlanBalance       Start Plan 今日余额。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 三段全空时整体返回 null。
//   守住它的位置：if ((!renderableTaskUsage || !contextUsageLabel) && !a && !b) return null。
//   改错故障：渲染出一个空触发器，点开是空白面板，用户以为功能坏了。
//
// INV-02 触发器文案有回退链：上下文 → Coding Plan 标题 → Start 余额标题。
//   守住它的位置：triggerLabel 的三元。
//   改错故障：新用户没有上下文用量时触发器没有可读标签，读屏只念出一个空按钮。
//
// INV-03 used / size 非法或非正数一律视为不可展示。
//   守住它的位置：getRenderableTaskUsage 的 Number.isFinite 与 <= 0 判断。
//   改错故障：初始化兜底的 0/0 被渲染成 0%，用户以为上下文已经满了或被清空。
//
// INV-04 上下文百分比必须先 clamp 到 0..1，再乘 100。
//   守住它的位置：usagePercent 的 Math.min/Math.max。
//   改错故障：越界值把进度条宽度写成非法 CSS，整段布局塌陷。
//
// INV-05 缓存命中率低于阈值默认不展示，开发环境例外。
//   守住它的位置：formatContextCacheHitRateLabel 的 showBelowThreshold 判断。
//   改错故障：低命中率常驻会分散对「容量」的注意力，且让用户以为缓存失效是故障。
//
// INV-06 命中率为 null / undefined / 非有限值时返回 null。
//   守住它的位置：formatContextCacheHitRateLabel 的首个 if。
//   改错故障：0 与「没有数据」混淆，面板长期显示 0% 缓存命中。
//
// INV-07 breakdown 只统计 chars > 0 且有限的项。
//   守住它的位置：buildContextUsageBreakdownSegments 的循环内 continue。
//   改错故障：负值或 NaN 参与求和后占比出现负百分数。
//
// INV-08 totalChars <= 0 时返回空数组，不返回全零分段。
//   守住它的位置：totalChars <= 0 的提前返回。
//   改错故障：图例渲染出若干 0% 的行，看起来像数据坏了。
//
// INV-09 分段排序固定为 chars 降序，其次按 BREAKDOWN_SOURCE_ORDER 升序。
//   守住它的位置：sort 里的 || 复合比较。
//   改错故障：同量级分段的顺序随机，每次打开面板颜色与图例都在变。
//
// INV-10 颜色按排序后的 index 取，超出长度复用最后一档。
//   守住它的位置：getBreakdownToneStyle 的 Math.min。
//   改错故障：index 越界得到 undefined，分段色块变成透明。
//
// INV-11 弹层宽度固定 320px（w-80），不随内容伸缩。
//   守住它的位置：contextPanelWidthClass。
//   改错故障：三段卡片宽度各不相同，hover 时面板左右跳动。
//
// INV-12 重置弹框打开期间必须拒绝 HoverCard 的关闭请求。
//   守住它的位置：handleContextOpenChange 的 quotaResetDialogOpenRef 判断。
//   改错故障：弹框一打开焦点移出，HoverCard 收起并卸载内容，Portal 里的弹框跟着消失。
//
// INV-13 重置弹框关闭时必须同时关闭上下文面板。
//   守住它的位置：handleQuotaResetDialogOpenChange 的 if (!open) setContextOpen(false)。
//   改错故障：弹框关掉后面板仍悬空存在，用户再 hover 也无法重新打开。
//
// INV-14 hover 刷新取 codingPlan.onAccess ?? startPlan.onAccess，两段互斥下只有一个存在。
//   守住它的位置：accessRefresh 的 ?? 表达式。
//   改错故障：只认 Coding Plan 时，Start Plan 用户 hover 永远不会刷新今日余额。
//
// INV-15 刷新必须带序列号，晚到的 promise 不得覆盖新一轮状态。
//   守住它的位置：refreshSeq 与 finally 里的相等判断。
//   改错故障：快速反复 hover 时旧请求先回，把刷新态错误地关掉。
//
// INV-16 refreshing 是「本地刷新中 或 上游 refreshing」的合成值。
//   守住它的位置：两处 useMemo 里的 contextAccessRefreshing || ... .refreshing。
//   改错故障：只看上游快照时 spinner 不转（静默刷新不置 loading）。
//
// INV-17 面板内的「更多 / 升级」动作必须先收起面板再执行。
//   守住它的位置：runContextPanelActionWithClose 与 onUpgradeClick 的 setContextOpen(false)。
//   改错故障：跳转到设置页后旧浮层仍悬在页面上，遮挡内容且关不掉。
//
// INV-18 自动完成的 used_at 必须「先 claim 成功」才能驱动 tooltip 与撒花。
//   守住它的位置：automaticCompletedAtByType 只读 claimedAutomaticCompletion。
//   改错故障：多窗口同时播撒花，违背「跨窗口只播一次」。
//
// INV-19 claim 结果必须按 sourceKey + completedAt 双重对齐。
//   守住它的位置：automaticCompletedAtByType 里的两个相等比较。
//   改错故障：切换套餐后沿用上一个 source 的完成时间，新套餐一挂载就撒花。
//
// INV-20 retry 只允许在组件仍 active 且候选未变化时重排。
//   守住它的位置：coordinateCodingPlanQuotaResetAutoPlay 的 isCurrent 与 then 里的二次校验。
//   改错故障：卸载后定时器重试，产生幽灵请求；或对已过期的 used_at 反复重试。
//
// INV-21 五小时与周额度各自维护撒花轨迹。
//   守住它的位置：resetCelebrationStateByTypeRef 与 armedByType 按类型写入。
//   改错故障：一类完成会压掉另一类的动效，用户错过其中一个重置。
//
// INV-22 两类同时处于提示阶段时，展示 observedAt 更晚的一类。
//   守住它的位置：activeResetType 的 reduce。
//   改错故障：总是固定优先五小时，周额度重置的提示被长期遮挡。
//
// INV-23 触发器 tooltip 只在「工作区可见 + 有提示类型 + 面板未打开」时展示。
//   守住它的位置：resetStatusTooltipOpen 的三段与。
//   改错故障：设置页覆盖层下仍弹出 tooltip（Portal 不受工作区 inert 约束）。
//
// INV-24 外部 pointerdown 只在面板未打开时解除机会提醒。
//   守住它的位置：监听 effect 的 early return 条件。
//   改错故障：打开面板后的内部点击被当成「点外部」，提醒刚出现就被清掉。
//
// INV-25 面板一打开就消费机会提醒（dismiss）。
//   守住它的位置：依赖 [contextOpen] 的 effect 首个分支。
//   改错故障：用户看过详情后提醒仍常驻，每次 hover 都重新弹出。
//
// INV-26 已收起的自动完成按 used_at 记录，新 used_at 会自动重新展示。
//   守住它的位置：resetTooltipDismissed 与 isTypeDismissed 的比较。
//   改错故障：用布尔「已读过」会让下一次真实重置永远不再提示。
//
// INV-27 跨窗口「已播」广播后必须 prune 掉已失效的撒花 arm。
//   守住它的位置：pruneCodingPlanQuotaResetConfettiArms 的 effect。
//   改错故障：另一窗口已播过，本窗口 hover 又撒一次。
//
// INV-28 processing 阶段到期必须切到 completed（而不是一直转）。
//   守住它的位置：依赖 resetTooltipPhase 的 setTimeout。
//   改错故障：重置动画永远停在处理中，用户以为后端卡住。
//
// INV-29 手动完成（startedAt 非空）不进入触发器交互。
//   守住它的位置：resolveAutomaticCompletedAt 的 startedAt === null。
//   改错故障：用户主动点的重置也会触发自动提示与撒花，语义重复。
//
// INV-30 设置页可见时不挂外部 pointerdown 监听。
//   守住它的位置：监听 effect 的 isWorkspaceVisible 条件。
//   改错故障：设置页里的点击被算作「已读」，回到工作区提醒不再出现。
//
// INV-31 触摸设备必须在 pointerdown 阶段手动打开面板。
//   守住它的位置：ContextTrigger 的 onPointerDown（hover: none 判断）。
//   改错故障：Radix 在 touchstart 阻止后续 click，手机端点触发器完全没反应。
//
// INV-32 span 必须包裹 ContextTrigger，避免两个 Radix 浮层叠加 ref。
//   守住它的位置：ControlHintTooltip 内的 span 容器。
//   改错故障：tooltip 与 HoverCard 争用同一节点 ref，两边定位与关闭都异常。
//
// INV-33 breakdown 行只展示占比，不展示分项 token 数。
//   守住它的位置：percentageFormatter 的渲染位置。
//   改错故障：分项 token 与顶部总量口径不同，用户算不平会认为数据错误。
//
// INV-34 压缩命令固定为 /compact。
//   守住它的位置：getContextCompressionCommand 的返回值。
//   改错故障：改动命令字面量会与 CLI 侧解析不一致，按钮点了没反应。
//
// INV-35 进度条 segments 与图例必须同源（progressSegments 由 breakdownSegments 派生）。
//   守住它的位置：两个 useMemo 的依赖链。
//   改错故障：条上颜色与下方图例不同，用户无法把占比对应到具体来源。
//
/* eslint-disable max-lines -- context 面板聚合 Context windows、Coding Plan 和 Start Plan 三段紧耦合展示；后续拆分需要单独梳理弹层状态边界。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  type CodingPlanResetType,
  type ZCodeContextUsageBreakdownItem,
  type ZCodeProvider,
} from "@zcode/shared";
import { TID_CHAT_CONTEXT_USAGE_TRIGGER } from "@zcode/shared/test-ids";
import {
  Context,
  ContextContentBody,
  ContextContent,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { resolveCodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import { CodingPlanQuotaResetStatusContent } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  advanceCodingPlanQuotaResetCelebration,
  pruneCodingPlanQuotaResetConfettiArms,
  resolveCodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetCelebrationState,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  ChatCodingPlanUsageRemainingPanel,
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
  type CodingPlanQuotaResetAutoConfettiArms,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import {
  ChatStartPlanBalancePanel,
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { runContextPanelActionWithClose } from "@/chat-input-toolbar/contextPanelAction.js";
import { coordinateCodingPlanQuotaResetAutoPlay } from "@/chat-input-toolbar/codingPlanQuotaResetAutoPlay.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import {
  CONTEXT_QUOTA_RESET_URGENT_SECONDS,
  ContextQuotaResetOpportunityReminderContent,
  contextQuotaResetOpportunityDismissalStore,
  resolveContextQuotaResetOpportunityReminder,
  resolveContextQuotaResetOpportunityTriggerTone,
  resolveContextTriggerTooltipKind,
  shouldDismissContextQuotaResetOpportunityReminder,
} from "@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js";

// [契约] 从协议类型里取联合而不是手写字符串：
// 后端新增来源时这里会自动扩展，BREAKDOWN_SOURCE_LABEL_ID / ORDER 的 Record 会强制补全。
type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

// [契约] chars 保留原始字符数用于排序，percent 是展示值，source 是图例与颜色的键。
// [失败路径] 不要只存 percent：四舍五入后的占比无法稳定排序，顺序会随小数抖动。
interface ContextUsageBreakdownSegment {
  chars: number;
  percent: number;
  source: ContextUsageBreakdownSource;
}

// [契约] 同色系五档由深到浅，全部基于 --color-usage-chart-1 混色：
// 不引入第二主色，保证与侧栏用量图表的视觉语言一致。
// [失败路径] 混色比例必须递增，否则相邻分段会出现「后一段比前一段更深」的错觉，
// 让人误以为排序错了。
const CONTEXT_PROGRESS_TONE_COLORS = [
  "var(--color-usage-chart-1)",
  "color-mix(in oklab, var(--color-usage-chart-1) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 28%, var(--color-surface))",
] as const;
const PERCENT_MAX = 100;
// [权衡] 78% 是「明显收益」的经验门槛（INV-05）：
// 低于它的命中率对用户没有决策价值，却会占掉一行版面。
// [失败路径] 只在展示层过滤，不要在数据层截断：
// CACHE_HIT_RATE_DISPLAY_THRESHOLD 只作用于展示层：开发者面板与埋点仍拿到真实低命中值。
const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;

// [契约] 对外导出的格式化函数必须与面板内部使用同一实现，
// 测试与其它入口（侧栏 / 设置页）复用它可以避免两套单位（1.2k 与 1.2K）。
export function formatContextUsageTokenCount(
  value: number,
  locale: string,
  options: { maximumFractionDigits?: number } = {},
): string {
  return formatCompactTokenNumber(locale, value, options);
}

// [契约] 摘要格式固定为 used/size (percent)，percent 由调用方传入而不是这里重算：
// 调用方已经做过 clamp（INV-04），重复计算会引入第二套舍入规则。
// [失败路径] size 用 maximumFractionDigits: 0，used 保留默认精度：
// 两者反过来会让总量出现小数而用量没有小数，读起来不协调。
export function formatContextUsageSummary({
  locale,
  percent,
  size,
  used,
}: {
  locale: string;
  percent: number;
  size: number;
  used: number;
}): string {
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  return `${formatContextUsageTokenCount(used, locale)}/${formatContextUsageTokenCount(
    size,
    locale,
    {
      maximumFractionDigits: 0,
    },
  )} (${percentageFormatter.format(percent)})`;
}

// [契约] 返回 null 表示「不该展示」，返回字符串表示「可以直接渲染」：
// formatContextCacheHitRateLabel 返回 null 表示整行不渲染；空串会让调用方误判成「有内容」。
export function formatContextCacheHitRateLabel(
  hitRate: number | null | undefined,
  locale: string,
  options: { showBelowThreshold?: boolean } = {},
): string | null {
  // [失败路径] 三个条件缺一不可（INV-06）：
  // null/undefined 表示没有缓存数据，NaN/Infinity 表示 provider 上报异常，
  // 两者都不应该格式化成 0%。
  if (hitRate === null || hitRate === undefined || !Number.isFinite(hitRate)) {
    return null;
  }

  // 生产面板只露出明显缓存收益，避免低命中率分散对上下文容量的注意力；
  // 开发环境需要观察 provider 的真实低命中值，因此允许绕过 78% 展示阈值。
  if (
    !options.showBelowThreshold &&
    hitRate < CACHE_HIT_RATE_DISPLAY_THRESHOLD
  ) {
    return null;
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, hitRate));
}

// [契约] 颜色只由排序后的 index 决定（INV-10）：
// 不按 source 固定颜色，是因为来源数量会随会话阶段变化，固定映射会让前几名颜色冲突。
function getBreakdownToneStyle(index: number): CSSProperties {
  return {
    backgroundColor:
      CONTEXT_PROGRESS_TONE_COLORS[
        Math.min(index, CONTEXT_PROGRESS_TONE_COLORS.length - 1)
      ] ?? CONTEXT_PROGRESS_TONE_COLORS[0],
  };
}

const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSource, string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

// [契约] 这是并列时的稳定次序：消息 → 系统提示 → 元上下文 → 技能 → 工具提示 → 工具 schema。
// [失败路径] 顺序值只用于 tie-break，不参与「重要性」判断；
// 不要用它覆盖 chars 降序（INV-09）。
const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
};

// [事务] 先把同 source 的多个条目合并，再算占比：
// 协议可能把同一来源拆成多条（例如多次注入的系统提示），
// 不合并会让图例出现重复来源且占比被拆碎。
// [失败路径] 空输入返回空数组而不是抛错：新任务、老会话都没有 breakdown。
export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(
      item.source,
      (charsBySource.get(item.source) ?? 0) + item.chars,
    );
  }

  const totalChars = [...charsBySource.values()].reduce(
    (sum, chars) => sum + chars,
    0,
  );
  // [失败路径] 总字符为 0 时返回空数组（INV-08）：
  // 继续计算会得到 NaN 占比，渲染层拿到 NaN 后宽度写成 NaN%，进度条整条消失。
  if (totalChars <= 0) {
    return [];
  }

  return [...charsBySource.entries()]
    .map(([source, chars]) => ({
      chars,
      percent: chars / totalChars,
      source,
    }))
    .sort(
      (left, right) =>
        right.chars - left.chars ||
        BREAKDOWN_SOURCE_ORDER[left.source] -
          BREAKDOWN_SOURCE_ORDER[right.source],
    );
}

// [契约] 进度条总长恒为 1：percent 直接作为分段宽度，剩余部分由 Progress 的底色补齐。
// [失败路径] 不要在这里补一个「空闲」分段：
// 空闲段会被图例当成一个真实来源，颜色与含义都对不上。
export function buildContextUsageProgressSegments(
  segments: readonly ContextUsageBreakdownSegment[],
) {
  return segments.map((segment, index) => ({
    id: segment.source,
    percent: segment.percent,
    style: getBreakdownToneStyle(index),
  }));
}

// [契约] 泛型透传让调用方保留自己的扩展字段（cache / breakdown），不做结构化拷贝。
// [失败路径] 非法值返回 null 而不是修正成 0（INV-03）：
// 修正会掩盖协议问题，并在面板上长期显示一个假的 0%。
export function getRenderableTaskUsage<
  T extends { used: number; size: number },
>(taskUsage: T | null): T | null {
  if (!taskUsage) {
    return null;
  }

  // ZCode Protocol 迁移后会单独补齐真实 contextUsed/contextWindow。
  // used=0 或非法值不代表可展示的上下文占用，避免把初始化/异常兜底渲染成误导性的 0%。
  if (
    !Number.isFinite(taskUsage.used) ||
    !Number.isFinite(taskUsage.size) ||
    taskUsage.used <= 0 ||
    taskUsage.size <= 0
  ) {
    return null;
  }

  return taskUsage;
}

// [契约] 命令字面量集中在这里（INV-34），provider 参数暂时不使用但保留签名，
// 为将来按 provider 区分压缩策略留出唯一改动点。
// [失败路径] 不要在各处内联 /compact：CLI 侧解析改动时容易漏改。
export function getContextCompressionCommand(_provider: ZCodeProvider): string {
  return "/compact";
}

// 自动/运营完成（startedAt 为空）当前生效的 used_at；手动完成不进入触发器交互。
// [契约] 只有「自动/运营完成」的条目进入触发器提示（INV-29）：
// startedAt === null 是自动完成的判据，手动重置由面板内按钮自己反馈。
function resolveAutomaticCompletedAt(
  entry: CodingPlanQuotaResetUiEntry | null,
): number | null {
  return entry?.status === "completed" &&
    entry.startedAt === null &&
    entry.observedAt !== null
    ? entry.completedAt
    : null;
}

// [事务] 打开即刷新，关闭不做任何事：
// 关闭时刷新会让用户在已经离开面板后仍触发一次额度请求。
export function refreshContextUsageOnOpen(
  open: boolean,
  onAccess: (() => Promise<void> | void) | undefined,
): void {
  if (open) {
    void onAccess?.();
  }
}

// [契约] 面板是受控展示组件：open 状态由本地持有（HoverCard 交互属于纯 UI），
// 但额度、刷新、跳转全部来自 props，组件不持有任何远端事实。
// [失败路径] selectedProvider 解构为 _selectedProvider：
// 保留接口兼容但当前不使用，删除参数会破坏既有调用方。
export function ChatContextUsage({
  codingPlanUsageRemaining,
  startPlanBalance,
  taskUsage,
  selectedProvider: _selectedProvider,
  intl,
  locale,
}: {
  codingPlanUsageRemaining?: ChatCodingPlanUsageRemainingConfig;
  startPlanBalance?: ChatStartPlanBalanceConfig;
  taskUsage: {
    used: number;
    size: number;
    cache?: { hitRate: number | null };
    breakdown?: ZCodeContextUsageBreakdownItem[];
  } | null;
  selectedProvider: ZCodeProvider;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
}) {
  // [事务] 用 selector 只订阅「当前活动 tab 是否为设置页」这一个布尔：
  // 订阅整个 tabs 数组会让每次 tab 切换都重渲染工具条。
  // [失败路径] Tooltip 的 Portal 挂在 body 上，工作区的 opacity/inert 管不到它（INV-23/INV-30），
  // 所以必须在这里显式判断可见性。
  const isWorkspaceVisible = useOptionalTabStore((state) =>
    !state.tabs.some((tab) => tab.id === state.activeTabId && isSettingsTab(tab)),
  );
  // [契约] 与弹层相关的本地状态共四个，职责互不重叠：
  // contextOpen          HoverCard 是否展开。
  // contextAccessRefreshing 本次 hover 触发的远端刷新是否在飞。
  // quotaResetDialogOpen 面板内重置弹框是否打开。
  // quotaResetDialogOpenRef 同一事实的同步镜像（供回调立即读取）。
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAccessRefreshing, setContextAccessRefreshing] = useState(false);
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const quotaResetDialogOpenRef = useRef(false);
  const contextUsageTriggerRef = useRef<HTMLElement | null>(null);
  const contextAccessRefreshSeqRef = useRef(0);
  // [事务] 打开：先置 open，再发起静默刷新并维护序列号。
  // 关闭：若重置弹框还开着则直接拒绝（INV-12）。
  // [失败路径] 两个动作的顺序不能反：先刷新后置 open 会让刷新回调里的关闭判断读到旧值。
  const handleContextOpenChange = useCallback(
    (open: boolean) => {
      // Dialog 打开后会把焦点移出 HoverCard，Radix 随即请求关闭 HoverCard；
      // 若此时卸载内容，Portal 中的重置弹框也会一起消失，因此弹框存活期间必须拒绝关闭。
      // [失败路径] 这里必须读 ref 而不是 state（INV-12）：
      // Radix 的关闭请求可能在同一次事件里同步发生，state 还没提交，读到的仍是 false。
      if (!open && quotaResetDialogOpenRef.current) {
        return;
      }
      setContextOpen(open);
      // hover 刷新入口不能只认 Coding Plan 的 onAccess：Start Plan（今日余额）与
      // Coding Plan 连接方式互斥，start plan 用户 hover 时整条刷新链路都不触发，余额只能被动等
      // 设置页/侧栏刷新。改为两段配置任一提供 onAccess 即发起本次静默 access 刷新（互斥下实际只有一个存在）。
      const accessRefresh =
        codingPlanUsageRemaining?.onAccess ?? startPlanBalance?.onAccess;
      if (!open || !accessRefresh) {
        return;
      }
      // silent access refresh 有缓存快照时不会把 entitlement.loading 置 true。
      // header 的刷新图标必须跟随本次 hover 触发的远端 promise，而不是只看快照 loading。
      // [并发] 序列号是「最后一次刷新」的唯一判据（INV-15）：
      // finally 里只有序号仍然相等才允许把 refreshing 置回 false。
      // [失败路径] 不要把 finally 写成无条件 setState(false)：
      // 连续 hover 时第一次请求先返回，会让 spinner 提前停掉。
      const refreshSeq = contextAccessRefreshSeqRef.current + 1;
      contextAccessRefreshSeqRef.current = refreshSeq;
      setContextAccessRefreshing(true);
      Promise.resolve(accessRefresh()).finally(() => {
        if (contextAccessRefreshSeqRef.current === refreshSeq) {
          setContextAccessRefreshing(false);
        }
      });
    },
    [codingPlanUsageRemaining?.onAccess, startPlanBalance?.onAccess],
  );
  // [事务] 先同步 ref，再更新 state，最后在关闭时收起面板（INV-13）：
  // 顺序保证 handleContextOpenChange 在同一 tick 内就能读到新值。
  const handleQuotaResetDialogOpenChange = useCallback((open: boolean) => {
    quotaResetDialogOpenRef.current = open;
    setQuotaResetDialogOpen(open);
    if (!open) {
      setContextOpen(false);
    }
  }, []);
  const renderableTaskUsage = getRenderableTaskUsage(taskUsage);
  // [契约] 在原始配置上包一层「动作前先关面板」（INV-17），
  // 只包 onUsageClick，其余字段原样透传。
  // [失败路径] 不要在这里改写 refreshing 之外的数据：
  // 额度条的颜色与文案由下层组件自己算，重复加工会产生两套状态。
  const codingPlanUsageRemainingWithClose = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (!codingPlanUsageRemaining) {
      return undefined;
    }
    const base = {
      ...codingPlanUsageRemaining,
      refreshing:
        contextAccessRefreshing || codingPlanUsageRemaining.refreshing === true,
    };
    if (!codingPlanUsageRemaining.onUsageClick) {
      return base;
    }

    return {
      ...base,
      onUsageClick: () =>
        runContextPanelActionWithClose({
          action: codingPlanUsageRemaining.onUsageClick,
          close: () => setContextOpen(false),
        }),
    };
  }, [codingPlanUsageRemaining, contextAccessRefreshing]);
  // [契约] Start 段同理：升级入口先收起面板，再切设置页（INV-17）。
  // [失败路径] refreshing 的合成规则必须与 Coding Plan 一致（INV-16），
  // 否则同一个 hover 下两段卡片一个转圈一个不转。
  const startPlanBalanceWithClose = useMemo<
    ChatStartPlanBalanceConfig | undefined
  >(() => {
    if (!startPlanBalance) {
      return undefined;
    }
    const base: ChatStartPlanBalanceConfig = {
      ...startPlanBalance,
      // 静默 access 刷新不置 entitlement.loading，今日余额标题旁 spinner 需要跟随
      // 本次 hover 触发的 promise（contextAccessRefreshing），语义对齐 Coding Plan 段的 refreshing。
      refreshing:
        contextAccessRefreshing || startPlanBalance.refreshing === true,
    };
    if (!startPlanBalance.onUpgradeClick) {
      return base;
    }

    return {
      ...base,
      onUpgradeClick: () => {
        // HoverCard 内按钮点击不会像外部 hover leave 一样自动关闭面板。
        // 升级入口会切到设置页，必须先收起 context 面板，避免旧浮层残留在新页面上。
        setContextOpen(false);
        startPlanBalance.onUpgradeClick?.();
      },
    };
  }, [startPlanBalance, contextAccessRefreshing]);
  const hasCodingPlanUsageRemaining = codingPlanUsageRemainingWithClose
    ? hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingWithClose)
    : false;
  const hasStartPlanBalance = hasChatStartPlanBalance(
    startPlanBalanceWithClose,
  );

  // 自动重置：触发器和面板复用同一完整 Personal/Team scope；共享 in-flight 避免重复请求。
  // [事务] 重置状态由「已包 close 的额度配置」解析，保证 displayedProviderId 与面板展示一致。
  // [失败路径] 用原始配置解析会在团队/个人切换时取到另一个 provider 的重置机会。
  const resetCodingPlanState = useMemo(
    () =>
      codingPlanUsageRemainingWithClose
        ? resolveCodingPlanUsageRemainingState(
            codingPlanUsageRemainingWithClose,
          )
        : null,
    [codingPlanUsageRemainingWithClose],
  );
  const resetSourceKey = resetCodingPlanState?.displayedProviderId ?? null;
  // MCP 与不足三张的主额度同排；主额度占满三列时才在下一行贯穿，浮层始终保持统一宽度。
  // [契约] 固定宽度（INV-11）：三段卡片共享同一栅格，宽度变化会让 hover 面板左右跳。
  // [权衡] 用 !w-80 覆盖底层组件的自适应宽度，是这里唯一允许的 !important。
  const contextPanelWidthClass = "!w-80";
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: resetSourceKey,
    preferredProviderId: resetCodingPlanState?.displayedEntitlement?.providerId,
    accountAccess: resetCodingPlanState?.displayedEntitlement?.accountAccess,
    onEntitlementRefresh:
      codingPlanUsageRemainingWithClose?.onEntitlementRefresh,
  });
  // [契约] 机会徽标是纯派生值：由重置状态 + 重置 UI 计算，不写回任何 store。
  // [失败路径] sourceKey 必须随 resetSourceKey 变化：
  // 否则切换套餐后旧来源的倒计时会继续挂在触发器上。
  const opportunityBadge = resolveChatCodingPlanResetOpportunityBadge(
    resetCodingPlanState,
    resetUi,
  );
  const [opportunityNow, setOpportunityNow] = useState(() => Date.now());
  // [契约] 已读状态放在外部 store 并用 useSyncExternalStore 订阅：
  // 多窗口共享同一份 dismissal 快照，组件卸载重挂也不会「已读复活」。
  // [失败路径] 用本地 useState 会在窗口切换后重新提示。
  const opportunityDismissal = useSyncExternalStore(
    contextQuotaResetOpportunityDismissalStore.subscribe,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
  );
  useEffect(() => {
    const now = Date.now();
    if (
      !opportunityBadge.visible ||
      opportunityBadge.expiresAt === null ||
      opportunityBadge.expiresAt <= now
    ) {
      return;
    }
    setOpportunityNow(now);
    let countdownTimer: number | undefined;
    let urgentThresholdTimer: number | undefined;
    const startUrgentCountdown = () => {
      const update = () => {
        const currentNow = Date.now();
        setOpportunityNow(currentNow);
        const expired = (opportunityBadge.expiresAt ?? 0) <= currentNow;
        if (expired && countdownTimer !== undefined) {
          window.clearInterval(countdownTimer);
          countdownTimer = undefined;
        }
        return expired;
      };
      if (!update()) {
        countdownTimer = window.setInterval(update, 1_000);
      }
    };
    const untilUrgent =
      opportunityBadge.expiresAt -
      now -
      CONTEXT_QUOTA_RESET_URGENT_SECONDS * 1_000;
    if (untilUrgent <= 0) {
      startUrgentCountdown();
    } else {
      urgentThresholdTimer = window.setTimeout(
        startUrgentCountdown,
        untilUrgent,
      );
    }
    return () => {
      if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
      if (urgentThresholdTimer !== undefined)
        window.clearTimeout(urgentThresholdTimer);
    };
  }, [opportunityBadge.expiresAt, opportunityBadge.visible, resetSourceKey]);
  const opportunityReminder = resolveContextQuotaResetOpportunityReminder({
    dismissal: opportunityDismissal,
    now: opportunityNow,
    opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
  });
  const opportunityTriggerTone = resolveContextQuotaResetOpportunityTriggerTone(
    {
      now: opportunityNow,
      opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
    },
  );
  const dismissOpportunityReminder = useCallback(() => {
    if (!opportunityReminder) return;
    contextQuotaResetOpportunityDismissalStore.dismiss(opportunityReminder);
  }, [opportunityReminder?.opportunityKey, opportunityReminder?.phase]);
  useEffect(() => {
    // 设置覆盖层保留工作区挂载；后台监听不能把设置页点击算作提醒已读。
    if (!isWorkspaceVisible || !opportunityReminder || contextOpen) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (
        shouldDismissContextQuotaResetOpportunityReminder(
          event.target,
          contextUsageTriggerRef.current,
        )
      ) {
        dismissOpportunityReminder();
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [
    isWorkspaceVisible,
    contextOpen,
    dismissOpportunityReminder,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
  ]);
  // 五小时与周额度各自维护撒花轨迹，避免一类完成压制另一类的触发器动效。
  const resetCelebrationStateByTypeRef = useRef<
    Record<CodingPlanResetType, CodingPlanQuotaResetCelebrationState | null>
  >({ FIVE_HOUR: null, WEEK: null });
  const fiveHourEntry = resetUi.entry;
  const weekEntry = resetUi.week.entry;
  // 自动/运营完成（startedAt 为空）只是播放候选；status 入口不能直接驱动 Tooltip/撒花。
  // [契约] 候选值只从「自动完成」条目解析（INV-29），按 FIVE_HOUR / WEEK 分槽。
  // [失败路径] 这里只是候选，不能直接驱动 UI：
  // 必须经过 claim（INV-18）才会变成 automaticCompletedAtByType。
  const automaticCompletionCandidateByType = useMemo<
    Record<CodingPlanResetType, number | null>
  >(
    () => ({
      FIVE_HOUR: resolveAutomaticCompletedAt(fiveHourEntry),
      WEEK: resolveAutomaticCompletedAt(weekEntry),
    }),
    [fiveHourEntry, weekEntry],
  );
  // [事务] claimed 结构同时记录 sourceKey 与两类 used_at：
  // sourceKey 是失效边界，used_at 是「播过哪一次」的身份。
  // [失败路径] 只记布尔会在下一次重置到来时无法区分新旧。
  const [claimedAutomaticCompletion, setClaimedAutomaticCompletion] = useState<{
    sourceKey: string | null;
    completedAtByType: CodingPlanQuotaResetAutoConfettiArms;
  }>({
    sourceKey: null,
    completedAtByType: { FIVE_HOUR: null, WEEK: null },
  });
  const claimedAutomaticCompletionRef = useRef(claimedAutomaticCompletion);
  claimedAutomaticCompletionRef.current = claimedAutomaticCompletion;
  const latestAutomaticCompletionCandidateRef = useRef({
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  });
  latestAutomaticCompletionCandidateRef.current = {
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  };
  const [autoPlayReservationRetryTick, setAutoPlayReservationRetryTick] =
    useState(0);

  // Main 返回 claim winner 前 Composer 可能已经卸载或切换 source。现在先获取带 token
  // 的临时 reservation，只有组件与候选仍有效且即将展示时才 commit played；失效 winner release，
  // busy loser 保留 observedAt，等待真实 played 广播或 reservation 释放后重试。
  useEffect(() => {
    // [并发] active 标记贯穿整个 claim effect（INV-20）：
    // 1) 卸载后不再发起重试；
    // 2) 异步结果回来时二次校验候选是否仍是当前候选；
    // 3) 重试定时器统一在 cleanup 里清理。
    let active = true;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const previous = claimedAutomaticCompletionRef.current;
    // [事务] 只有同一 source 才沿用已 claim 的 used_at（INV-19）：
    // 换 source 时把两类都重置为 null，相当于「新套餐还没播过」。
    // [失败路径] 不比较 completedAt 会沿用旧完成时间，新套餐首次挂载就误播。
    const sameSource = previous.sourceKey === resetSourceKey;
    const synchronized = {
      sourceKey: resetSourceKey,
      completedAtByType: {
        FIVE_HOUR:
          sameSource &&
          previous.completedAtByType.FIVE_HOUR ===
            automaticCompletionCandidateByType.FIVE_HOUR
            ? previous.completedAtByType.FIVE_HOUR
            : null,
        WEEK:
          sameSource &&
          previous.completedAtByType.WEEK ===
            automaticCompletionCandidateByType.WEEK
            ? previous.completedAtByType.WEEK
            : null,
      },
    };
    if (
      previous.sourceKey !== synchronized.sourceKey ||
      previous.completedAtByType.FIVE_HOUR !==
        synchronized.completedAtByType.FIVE_HOUR ||
      previous.completedAtByType.WEEK !== synchronized.completedAtByType.WEEK
    ) {
      claimedAutomaticCompletionRef.current = synchronized;
      setClaimedAutomaticCompletion(synchronized);
    }

    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const completedAt = automaticCompletionCandidateByType[resetType];
      if (
        completedAt === null ||
        synchronized.completedAtByType[resetType] === completedAt
      ) {
        continue;
      }
      // [事务] 一次自动播报的四步协议：
      // reserve  取得临时预约（带 token），失败则进入 busy loser 分支；
      // isCurrent 在提交前确认组件与候选仍然有效；
      // commit   真正标记「已播」；
      // release  失效 winner 必须释放，否则其它窗口永远拿不到。
      // [失败路径] 缺少 release 会让预约泄漏，跨窗口的「只播一次」退化成「永不播」。
      void coordinateCodingPlanQuotaResetAutoPlay({
        reserve: () =>
          resetUi.reserveAutomaticCompletion(resetType, completedAt),
        isCurrent: () => {
          const latest = latestAutomaticCompletionCandidateRef.current;
          return (
            active &&
            latest.sourceKey === resetSourceKey &&
            latest.completedAtByType[resetType] === completedAt
          );
        },
        commit: resetUi.commitAutomaticCompletion,
        release: resetUi.releaseAutomaticCompletion,
        onCommitted: () => {
          const current = claimedAutomaticCompletionRef.current;
          const completedAtByType =
            current.sourceKey === resetSourceKey
              ? current.completedAtByType
              : { FIVE_HOUR: null, WEEK: null };
          if (completedAtByType[resetType] === completedAt) {
            return;
          }
          const next = {
            sourceKey: resetSourceKey,
            completedAtByType: {
              ...completedAtByType,
              [resetType]: completedAt,
            },
          };
          claimedAutomaticCompletionRef.current = next;
          setClaimedAutomaticCompletion(next);
        },
      }).then((result) => {
        if (result.status !== "retry" || !active) {
          return;
        }
        const latest = latestAutomaticCompletionCandidateRef.current;
        if (
          latest.sourceKey !== resetSourceKey ||
          latest.completedAtByType[resetType] !== completedAt
        ) {
          return;
        }
        retryTimers.push(
          setTimeout(() => {
            if (active) {
              setAutoPlayReservationRetryTick((tick) => tick + 1);
            }
          }, result.retryAfterMs),
        );
      });
    }

    return () => {
      active = false;
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    autoPlayReservationRetryTick,
    resetSourceKey,
    resetUi.commitAutomaticCompletion,
    resetUi.releaseAutomaticCompletion,
    resetUi.reserveAutomaticCompletion,
  ]);

  // Tooltip/撒花只消费本窗口已经 claim 成功且仍对应当前候选的 used_at。
  // [契约] 对外只暴露「已 claim 且仍对应当前候选」的 used_at（INV-18/INV-19）：
  // 两个条件任一不满足都返回 null，UI 自然不展示。
  const automaticCompletedAtByType = useMemo<
    Record<CodingPlanResetType, number | null>
  >(() => {
    if (claimedAutomaticCompletion.sourceKey !== resetSourceKey) {
      return { FIVE_HOUR: null, WEEK: null };
    }
    return {
      FIVE_HOUR:
        claimedAutomaticCompletion.completedAtByType.FIVE_HOUR ===
        automaticCompletionCandidateByType.FIVE_HOUR
          ? claimedAutomaticCompletion.completedAtByType.FIVE_HOUR
          : null,
      WEEK:
        claimedAutomaticCompletion.completedAtByType.WEEK ===
        automaticCompletionCandidateByType.WEEK
          ? claimedAutomaticCompletion.completedAtByType.WEEK
          : null,
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    claimedAutomaticCompletion,
    resetSourceKey,
  ]);
  const [resetTooltipNow, setResetTooltipNow] = useState(() => Date.now());
  // 已被 hover 收起的自动完成 used_at(按类型记录)；新的自动完成 used_at 不同会自动重新展示,
  // 因此某一类型完成时无需清空另一类型的收起状态。
  const [resetTooltipDismissed, setResetTooltipDismissed] =
    useState<CodingPlanQuotaResetAutoConfettiArms>({
      FIVE_HOUR: null,
      WEEK: null,
    });
  // 待补播撒花的自动完成 used_at(按类型记录)；hover 展开面板后由对应额度条「已重置」位置各迸发一次。
  const [armedAutoConfetti, setArmedAutoConfetti] =
    useState<CodingPlanQuotaResetAutoConfettiArms>({
      FIVE_HOUR: null,
      WEEK: null,
    });
  const isTypeDismissed = useCallback(
    (resetType: CodingPlanResetType): boolean => {
      const completedAt = automaticCompletedAtByType[resetType];
      return (
        completedAt !== null && resetTooltipDismissed[resetType] === completedAt
      );
    },
    [automaticCompletedAtByType, resetTooltipDismissed],
  );
  const phaseByType = useMemo<
    Record<CodingPlanResetType, CodingPlanQuotaResetAutomaticPhase | null>
  >(
    () => ({
      FIVE_HOUR:
        automaticCompletedAtByType.FIVE_HOUR === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              fiveHourEntry,
              resetTooltipNow,
              isTypeDismissed("FIVE_HOUR"),
            ),
      WEEK:
        automaticCompletedAtByType.WEEK === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              weekEntry,
              resetTooltipNow,
              isTypeDismissed("WEEK"),
            ),
    }),
    [
      automaticCompletedAtByType.FIVE_HOUR,
      automaticCompletedAtByType.WEEK,
      fiveHourEntry,
      weekEntry,
      resetTooltipNow,
      isTypeDismissed,
    ],
  );
  // 两类同时处于自动提示阶段时，优先展示更晚被观察到的那一类（更贴近“刚刚发生”）。
  // [事务] 两类都在提示阶段时取 observedAt 更晚的一类（INV-22）：
  // observedAt 表达「这个窗口什么时候第一次看到它」，最接近用户感知的「刚刚发生」。
  // [失败路径] 用 completedAt 比较会把运营侧补发的旧时间排到前面。
  const activeResetType = useMemo<CodingPlanResetType | null>(() => {
    const candidates = CODING_PLAN_QUOTA_RESET_TYPES.filter(
      (resetType) => phaseByType[resetType] !== null,
    );
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((chosen, resetType) => {
      const chosenObserved =
        (chosen === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      const currentObserved =
        (resetType === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      return currentObserved > chosenObserved ? resetType : chosen;
    });
  }, [phaseByType, fiveHourEntry, weekEntry]);
  const resetTooltipPhase = activeResetType
    ? phaseByType[activeResetType]
    : null;
  const activeEntry =
    activeResetType === "WEEK"
      ? weekEntry
      : activeResetType === "FIVE_HOUR"
        ? fiveHourEntry
        : null;
  const triggerTooltipKind = resolveContextTriggerTooltipKind(
    resetTooltipPhase,
    opportunityReminder?.phase ?? null,
  );
  // Tooltip Portal 位于 body，工作区的 opacity/inert 隐藏不了它；必须跟随 Root 的设置标签可见性。
  // [失败路径] 三条件缺一不可（INV-23）：
  // 设置页可见性管 Portal，kind 管有没有内容，contextOpen 防止 tooltip 与面板叠加。
  const resetStatusTooltipOpen = isWorkspaceVisible && triggerTooltipKind !== null && !contextOpen;

  // 发现新的自动/运营完成：按类型重新计时合成“正在重置”,并 arm 对应额度条补播撒花。
  // 每类各自记录,一类完成不影响另一类；dismissed 按 used_at 记录,新 used_at 会自动重新展示。
  useEffect(() => {
    // [事务] 只在本轮「状态机判定需要庆祝」时才 arm（INV-21）：
    // arm 的值是 used_at 而不是布尔，面板补播时用它去重（同一 used_at 只撒一次）。
    const armedByType: Partial<Record<CodingPlanResetType, number>> = {};
    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const entry = resetType === "WEEK" ? weekEntry : fiveHourEntry;
      const automaticCompletedAt = automaticCompletedAtByType[resetType];
      const result = advanceCodingPlanQuotaResetCelebration(
        resetCelebrationStateByTypeRef.current[resetType],
        {
          sourceKey: resetSourceKey,
          completedAt: entry?.completedAt ?? null,
          automaticCompletion: automaticCompletedAt !== null,
        },
      );
      resetCelebrationStateByTypeRef.current[resetType] = result.state;
      if (result.shouldCelebrate && automaticCompletedAt !== null) {
        armedByType[resetType] = automaticCompletedAt;
      }
    }
    if (Object.keys(armedByType).length > 0) {
      setResetTooltipNow(Date.now());
      setArmedAutoConfetti((prev) => ({ ...prev, ...armedByType }));
    }
  }, [automaticCompletedAtByType, fiveHourEntry, weekEntry, resetSourceKey]);

  // 跨窗口"已播"广播会把正在展示的自动完成 observedAt 置空；此时已 arm 的
  // 补播撒花必须同步清除，否则本窗口 hover 面板时仍会撒花，违背“多窗口只播一次”。
  useEffect(() => {
    setArmedAutoConfetti((prev) =>
      pruneCodingPlanQuotaResetConfettiArms(prev, automaticCompletedAtByType),
    );
  }, [automaticCompletedAtByType]);

  // 合成“正在重置”阶段到期后切换为“已重置”（随后一直保留直到 hover 收起）。
  useEffect(() => {
    const observedAt = activeEntry?.observedAt ?? null;
    if (resetTooltipPhase !== "processing" || observedAt === null) {
      return;
    }
    const remaining =
      observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS - Date.now();
    const timer = window.setTimeout(
      () => setResetTooltipNow(Date.now()),
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timer);
  }, [resetTooltipPhase, activeEntry?.observedAt]);

  // 用户 hover 触发器展开额度面板：把当前处于自动提示阶段的**每一类**都标记收起,
  // 交由面板内对应重置项从同一位置补播撒花(两类可能同时处于提示阶段)。
  useEffect(() => {
    if (!contextOpen) {
      return;
    }
    if (opportunityReminder) {
      dismissOpportunityReminder();
    }
    setResetTooltipDismissed((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        const completedAt = automaticCompletedAtByType[resetType];
        if (
          phaseByType[resetType] !== null &&
          completedAt !== null &&
          next[resetType] !== completedAt
        ) {
          next[resetType] = completedAt;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    contextOpen,
    phaseByType,
    automaticCompletedAtByType,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
    dismissOpportunityReminder,
  ]);

  const handleAutoResetCelebrated = useCallback((completedAt: number) => {
    setArmedAutoConfetti((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        if (next[resetType] === completedAt) {
          next[resetType] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale),
    [locale],
  );
  // [契约] 触发器的可读标签（used/total），只在有可渲染用量时生成：
  // 它是 INV-01 判空条件的一部分，不能为了「总有文案」而补默认值。
  const contextUsageLabel = useMemo(() => {
    if (!renderableTaskUsage) {
      return null;
    }

    return intl.formatMessage(
      { id: "chat.contextUsage" },
      {
        used: numberFormatter.format(renderableTaskUsage.used),
        total: numberFormatter.format(renderableTaskUsage.size),
      },
    );
  }, [intl, numberFormatter, renderableTaskUsage]);
  // [契约] showBelowThreshold 只在 DEV 打开（INV-05）：
  // 生产靠阈值收噪音，开发需要看到 provider 的真实表现。
  const cacheHitRateLabel = useMemo(() => {
    return formatContextCacheHitRateLabel(
      renderableTaskUsage?.cache?.hitRate,
      locale,
      {
        showBelowThreshold: import.meta.env.DEV,
      },
    );
  }, [locale, renderableTaskUsage]);
  const breakdownSegments = useMemo(
    () => buildContextUsageBreakdownSegments(renderableTaskUsage?.breakdown),
    [renderableTaskUsage?.breakdown],
  );
  const progressSegments = useMemo(
    () => buildContextUsageProgressSegments(breakdownSegments),
    [breakdownSegments],
  );
  const percentageFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 1,
        style: "percent",
      }),
    [locale],
  );

  if (
    (!renderableTaskUsage || !contextUsageLabel) &&
    !hasCodingPlanUsageRemaining &&
    !hasStartPlanBalance
  ) {
    return null;
  }

  // [失败路径] clamp 下限 0 上限 1（INV-04）：
  // provider 偶尔上报 used > size（压缩前后的竞态），不做上限会让进度条溢出容器。
  const usagePercent = renderableTaskUsage
    ? Math.min(
        Math.max(renderableTaskUsage.used / renderableTaskUsage.size, 0),
        1,
      )
    : 0;
  const compactTokenUsageLabel = renderableTaskUsage
    ? formatContextUsageSummary({
        locale,
        percent: usagePercent,
        size: renderableTaskUsage.size,
        used: renderableTaskUsage.used,
      })
    : null;
  // [契约] 三级回退（INV-02）：上下文摘要 → Coding Plan 标题 → Start 余额标题。
  // [失败路径] 回退顺序不能变：有上下文时优先展示上下文，
  // 否则老会话会一直显示「Coding Plan」而看不到真实用量。
  const triggerLabel =
    contextUsageLabel ??
    (hasCodingPlanUsageRemaining
      ? intl.formatMessage({ id: "sidebar.usage.plan.title" })
      : intl.formatMessage({
          id: "settings.modelProvider.startPlan.balance.title",
        }));
  // [失败路径] 这里给 0 / 1 只是为了让底层 Context 组件的比例计算不除零：
  // 真正的展示门禁已经在 INV-01 完成，不能用这两个兜底值反过来判断「有没有用量」。
  const contextUsedTokens = renderableTaskUsage?.used ?? 0;
  const contextMaxTokens = renderableTaskUsage?.size ?? 1;

  // [契约] 渲染树固定为「触发器 → 弹层三段」：
  // 1) ControlHintTooltip 负责重置状态 / 机会提醒的紧凑提示；
  // 2) span 包裹 ContextTrigger（INV-32），触摸设备在 pointerdown 阶段打开（INV-31）；
  // 3) 弹层内顺序：上下文摘要 + 进度 → 来源图例 + 缓存命中率 → Coding Plan → Start Plan。
  // [失败路径] 三段之间用各自的数据条件独立门控：
  // 任何一段缺失都不能影响另外两段渲染（这是本组件最重要的组合性质）。
  // [失败路径] separated 参数必须与「上面是否渲染了上下文段」保持一致，
  // 否则分隔线的有无会与内容不匹配，出现首段上方多一条横线。
  return (
    <Context
      usedTokens={contextUsedTokens}
      maxTokens={contextMaxTokens}
      open={contextOpen}
      onOpenChange={handleContextOpenChange}
    >
      <ControlHintTooltip
        className={
          triggerTooltipKind === "reset-status"
            ? undefined
            : "bg-background py-0.5 pr-0.5"
        }
        open={resetStatusTooltipOpen}
        side="top"
        standalone
        triggerRef={contextUsageTriggerRef}
        title={
          triggerTooltipKind === "reset-status" && resetTooltipPhase ? (
            <CodingPlanQuotaResetStatusContent
              status={resetTooltipPhase}
              resetType={activeResetType ?? "FIVE_HOUR"}
            />
          ) : opportunityReminder ? (
            <ContextQuotaResetOpportunityReminderContent
              count={opportunityReminder.count}
              intl={intl}
              onDismiss={dismissOpportunityReminder}
              phase={opportunityReminder.phase}
              remainingSeconds={opportunityReminder.remainingSeconds}
            />
          ) : null
        }
      >
        {/* Bugfix：span 承载 ControlHintTooltip 的 asChild 锚点，内部 ContextTrigger 仍作为
            HoverCard 触发器，避免两个 Radix 浮层在同一 DOM 上叠加 ref。手动核销的
            processing 由弹层内「重置」按钮自身展示，触发器不转圈。 */}
        <span className="inline-flex shrink-0">
          <ContextTrigger
            aria-label={triggerLabel}
            className={cn(
              "text-foreground-subtle",
              opportunityTriggerTone === "available" && "text-success",
              opportunityTriggerTone === "urgent" &&
                "bg-warning/10 text-warning",
            )}
            data-chat-toolbar-popover-trigger="true"
            data-testid={TID_CHAT_CONTEXT_USAGE_TRIGGER}
            onPointerDown={(event) => {
              // Radix HoverCard 会在 touchstart 中阻止后续 click，手机端无法打开面板；
              // 在触摸 pointerdown 阶段先打开，桌面端继续保持原有 hover/focus 语义。
              if (
                !event.defaultPrevented &&
                event.pointerType === "touch" &&
                typeof window !== "undefined" &&
                window.matchMedia?.("(hover: none)").matches
              ) {
                // 统一走受控 open handler，确保触摸打开也会触发额度 access 刷新和刷新态反馈。
                if (!contextOpen) {
                  handleContextOpenChange(true);
                }
              }
            }}
          />
        </span>
      </ControlHintTooltip>
      <ContextContent
        className={cn(contextPanelWidthClass, "!rounded-xl !shadow-md")}
        side="top"
        sideOffset={2}
      >
        <ContextContentBody className="space-y-3">
          {/* Bugfix: 默认 ai-elements Header 会硬编码标题并把摘要拆到独立头部。
          工具栏上下文 hover 只需要一块紧凑信息面板，摘要和明细统一放在 body 里。 */}
          {renderableTaskUsage && compactTokenUsageLabel ? (
            <div className="space-y-2">
              <div className="flex min-w-0 mb-3 items-center gap-3">
                <span className="shrink-0 text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "chat.contextUsage.title" })}
                </span>
                <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
                  {compactTokenUsageLabel}
                </span>
              </div>
              <Progress
                className="h-2 bg-surface"
                indicatorClassName="min-w-2"
                segments={progressSegments}
                value={usagePercent * PERCENT_MAX}
              />
            </div>
          ) : null}
          {renderableTaskUsage &&
          (breakdownSegments.length > 0 || cacheHitRateLabel) ? (
            <>
              {breakdownSegments.length > 0 ? (
                <div
                  aria-label={intl.formatMessage({
                    id: "chat.contextUsage.breakdown",
                  })}
                  className="space-y-1.5"
                >
                  <div className="grid gap-1.5">
                    {breakdownSegments.map((segment, index) => (
                      <div
                        className="flex min-w-0 items-center gap-2 text-ui-sm"
                        key={segment.source}
                      >
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-sm border border-border"
                          style={getBreakdownToneStyle(index)}
                        />
                        <span className="min-w-0 truncate text-foreground-subtle">
                          {intl.formatMessage({
                            id: BREAKDOWN_SOURCE_LABEL_ID[segment.source],
                          })}
                        </span>
                        {/* Bugfix: breakdown 行只展示占比，分项 token 数会和顶部总量口径混在一起造成误读。 */}
                        <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
                          {percentageFormatter.format(segment.percent)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {cacheHitRateLabel ? (
                <div
                  className={cn(
                    "flex items-center justify-between gap-3 text-ui-sm",
                    breakdownSegments.length > 0 &&
                      "border-t border-border pt-3",
                  )}
                >
                  <span className="text-foreground-subtle">
                    {intl.formatMessage({
                      id: "chat.contextUsage.cacheHitRate",
                    })}
                  </span>
                  <span className="font-mono text-ui-sm text-foreground">
                    {cacheHitRateLabel}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
          {codingPlanUsageRemainingWithClose && hasCodingPlanUsageRemaining ? (
            <ChatCodingPlanUsageRemainingPanel
              autoCelebrateArm={armedAutoConfetti}
              config={codingPlanUsageRemainingWithClose}
              intl={intl}
              locale={locale}
              quotaResetDialogOpen={quotaResetDialogOpen}
              separated={Boolean(renderableTaskUsage && compactTokenUsageLabel)}
              onAutoCelebrated={handleAutoResetCelebrated}
              onQuotaResetDialogOpenChange={handleQuotaResetDialogOpenChange}
            />
          ) : null}
          {startPlanBalanceWithClose && hasStartPlanBalance ? (
            <ChatStartPlanBalancePanel
              config={startPlanBalanceWithClose}
              intl={intl}
              locale={locale}
              separated={Boolean(
                (renderableTaskUsage && compactTokenUsageLabel) ||
                hasCodingPlanUsageRemaining,
              )}
            />
          ) : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
