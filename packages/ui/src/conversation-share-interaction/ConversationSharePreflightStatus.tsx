// INV-01 只读展示：守住位置 组件主体；改错故障：渲染期主动发起预检或改写选中集。
// INV-02 动作外置：守住位置 取消与重试回调；改错故障：组件内部自造请求，状态分叉。
// INV-03 缺省空表：守住位置 三类问题读取；改错故障：状态缺键时读取 undefined 抛错。
// INV-04 进行中归一：守住位置 checking 判定；改错故障：陈旧态显示为已完成，用户误提交。
// INV-05 优先级摘要：守住位置 状态文案选择；改错故障：有阻塞却显示可跳过，严重度被掩盖。
// INV-06 文案独立：守住位置 触发按钮标签；改错故障：按钮与摘要使用不同判断而互相矛盾。
// INV-07 全空不渲染：守住位置 早退分支；改错故障：无问题时占一行空白，压缩范围按钮区。
// INV-08 字节分档：守住位置 数值格式化；改错故障：上限显示成一长串字节数，难以比较。
// INV-09 缺失占位：守住位置 空值回退；改错故障：界面出现 undefined 或 null 字样。
// INV-10 问题模板：守住位置 取值对象构造；改错故障：文案模板缺字段，插值留空。
// INV-11 类型本地化：守住位置 产物类型与允许格式；改错故障：诊断里出现内部枚举名。
// INV-12 图标分档：守住位置 三类图标；改错故障：阻塞与警告同一图标，严重度不可辨。
// INV-13 列表有界：守住位置 五条截断；改错故障：问题过多撑爆浮窗。
// INV-14 键唯一：守住位置 列表 key 组合；改错故障：同码多问题复用时行状态错挂。
// INV-15 取消门控：守住位置 取消按钮条件；改错故障：无会话标识的问题也显示取消。
// INV-16 重试门控：守住位置 重试按钮条件；改错故障：非传输问题出现重试，点击无效果。
// INV-17 memo 稳定：守住位置 默认对象；改错故障：每次渲染新建默认值，memo 失效。
// INV-18 测试标识：守住位置 关键节点；改错故障：端到端测试无法定位预检状态。
//
// 模块职责：对话分享预检状态的可操作诊断入口与浮窗。
// 状态所有权：预检状态由外部持有；本组件只读并按优先级派生文案。
// 阅读顺序：默认值 → 派生文案 → 数值格式化 → 早退 → 浮窗结构。
import type {
  ConversationSharePreflightState,
  ConversationSharePreflightStatusProps,
} from "@/conversation-share-interaction/contract.js";
export type {
  ConversationSharePreflightState,
  ConversationSharePreflightStatusProps,
} from "@/conversation-share-interaction/contract.js";
import { memo } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { ConversationShareFailureIssue } from "@/conversation-share-interaction/contract.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

// 修复原因：memo 组件的默认对象每次创建会破坏引用稳定性；idle 默认值仅供读取。
// 共享的空预检对象，避免每次渲染新建引用。
// idle 只用于读取，不承载任何问题列表。
//
const DEFAULT_PREFLIGHT: ConversationSharePreflightState = {
  status: "idle",
};

// 本组件只读 preflight，onRetryPreflight 与 onDeselectTurn 都由外部注入。
// blockingIssues 等三类列表缺键时按空数组处理。
// status 为 checking、stale 或 idle 时都算 checking。
// statusLabel 先读 blockingIssues、skippableWarnings、deferredIssues 三类长度。
// triggerLabel 单独按长度分支，不复用 statusLabel 的判断结果。
//
function ConversationSharePreflightStatusImpl({
  onDeselectTurn,
  onRetryPreflight,
  preflight = DEFAULT_PREFLIGHT,
}: ConversationSharePreflightStatusProps) {
  const { intl, locale } = useZCodeIntl();
  const blockingIssues = "blockingIssues" in preflight ? preflight.blockingIssues : [];
  const skippableWarnings = "skippableWarnings" in preflight ? preflight.skippableWarnings : [];
  const deferredIssues = "deferredIssues" in preflight ? preflight.deferredIssues : [];
  const checking =
    preflight.status === "checking" || preflight.status === "stale" || preflight.status === "idle";
  const statusCount = blockingIssues.length || skippableWarnings.length || deferredIssues.length;
  // statusLabel 先判 blockingIssues，再判 skippableWarnings，最后 deferredIssues。
  // checking 为真时取 preflightChecking 文案，其余按问题类型降级。
  // preflightSkipped 传 { count }，preflightDeferred 不传参数。
  // 三类都为 0 时 statusLabel 返回空串，调用方据此不渲染。
  //
  const statusLabel = checking
    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
    : blockingIssues.length > 0
      ? intl.formatMessage({ id: "conversationShare.partial.preflightBlocked" })
      : skippableWarnings.length > 0
        ? intl.formatMessage(
            { id: "conversationShare.partial.preflightSkipped" },
            { count: skippableWarnings.length },
          )
        : deferredIssues.length > 0
          ? intl.formatMessage({
              id: "conversationShare.partial.preflightDeferred",
            })
          : "";
  const triggerLabel = intl.formatMessage({
    id:
      blockingIssues.length > 0
        ? "conversationShare.preflight.reviewIssues"
        : skippableWarnings.length > 0
          ? "conversationShare.preflight.reviewSkipped"
          : "conversationShare.preflight.reviewDeferred",
  });
  // 字节类数值按 MB、KB、B 三档格式化。
  // 非字节类数值直接 String(value) 返回。
  // value 为 undefined 时返回 "—"，不显示 undefined。
  // formatIssueValues 把缺失字段补成 "—"，再交给 formatMessage。
  // PopoverTitle 与列表项共用 formatIssueValues 的结果。
  //
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };
  const formatIssueValues = (issue: ConversationShareFailureIssue) => ({
    turnOrdinal: issue.turnOrdinal ?? "—",
    artifactDisplayName: issue.artifactDisplayName ?? "—",
    artifactType: formatConversationShareArtifactType(issue, locale),
    extension: issue.extension ?? "—",
    mimeType: issue.mimeType ?? "—",
    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
    actual: formatValue(issue.actual, issue.code),
    limit: formatValue(issue.limit, issue.code),
    phase: issue.phase ?? "—",
  });

  // 浮窗的检查态由范围按钮承载，此处只保留可操作的诊断，避免多占一行。
  // checking 或 statusCount 为 0 时返回 null，浮窗交给范围按钮。
  // Popover 内只渲染可操作的诊断项，不重复展示 statusLabel。
  // 合并三类问题后 slice(0, 5)，其余不展开。
  //
  if (checking || statusCount === 0) return null;

  return (
    <section
      data-conversation-share-keep-open="selection-dock"
      data-testid="conversation-share-selection-dock"
      className="flex items-center text-ui-sm text-foreground"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="conversation-share-selection-preflight-status"
            aria-label={triggerLabel}
            title={statusLabel}
            aria-busy={checking}
            className="flex min-w-0 items-start gap-1.5 text-left text-ui-sm leading-5 text-foreground-subtle hover:text-foreground"
          >
            {blockingIssues.length > 0 ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : skippableWarnings.length > 0 ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0">{triggerLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          collisionPadding={12}
          data-testid="conversation-share-selection-preflight-popover"
          className="w-96 max-w-[calc(100vw-1.5rem)] gap-2 p-3"
        >
          <PopoverTitle className="text-ui-base font-medium">{statusLabel}</PopoverTitle>
          <ul className="grid max-h-56 gap-2 overflow-y-auto text-ui-base">
            {[...blockingIssues, ...skippableWarnings, ...deferredIssues]
              .slice(0, 5)
              .map((issue, index) => (
                <li
                  key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                  className="grid gap-1"
                >
                  <span>
                    {intl.formatMessage(
                      {
                        id: blockingIssues.includes(issue)
                          ? resolveConversationShareIssueMessageId(issue)
                          : resolveConversationShareWarningMessageId(issue),
                      },
                      formatIssueValues(issue),
                    )}
                  </span>
                  {blockingIssues.includes(issue) &&
                  issue.productTurnId !== undefined &&
                  onDeselectTurn ? (
                    <button
                      type="button"
                      className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                      onClick={() => onDeselectTurn(issue.productTurnId!)}
                    >
                      {intl.formatMessage({
                        id: "conversationShare.issue.deselectTurn",
                      })}
                    </button>
                  ) : null}
                  {blockingIssues.includes(issue) &&
                  issue.scope === "transport" &&
                  onRetryPreflight ? (
                    <button
                      type="button"
                      data-testid="conversation-share-preflight-retry"
                      className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                      onClick={onRetryPreflight}
                    >
                      {intl.formatMessage({
                        id: "conversationShare.issue.retryPreflight",
                      })}
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </PopoverContent>
      </Popover>
    </section>
  );
}

// 对外暴露 memo 版本，props 引用稳定才跳过渲染。
// 实现组件不导出，避免绕开 memo。
// 默认对象与派生文案都在模块层固定，减少引用变化。
//
export const ConversationSharePreflightStatus = memo(ConversationSharePreflightStatusImpl);
