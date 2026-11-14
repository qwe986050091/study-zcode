// INV-01 [状态] 复制成功态是组件内的瞬时展示状态，不属于工单事实；守住位置：copiedIssueId 的初值与 issueIdCopied 对 ticket.id 的比较；改错故障：把已复制写进共享 store，切换工单后串态。
// INV-02 [顺序] 切换工单必须先让复制态失效；守住位置：useEffect 依赖 [ticket.id] 内的 setCopiedIssueId(null)；改错故障：复制 A 后切到 B，B 上短暂显示 A 的已复制。
// INV-03 [资源] 复位计时器同时只允许一个存活；守住位置：成功回调里先 clear 再 set，卸载 cleanup 再清一次；改错故障：连点堆叠计时器，晚到的回调提前抹掉最新状态。
// INV-04 [失败路径] 缺少剪贴板能力时只告警并返回；守住位置：handleCopyIssueId 开头对 navigator 与 writeText 的判断；改错故障：非安全上下文点击直接抛异常，按钮变成坏交互。
// INV-05 [失败路径] 写入被拒不得置成功态；守住位置：writeText 第二个回调里的 logger.warn 与 issueCopyFailed 文案；改错故障：失败也显示对勾，用户粘贴到空内容。
// INV-06 [资源] 计时器必须走 globalThis，而不是 window 或裸全局；守住位置：copiedResetTimerRef 的类型与两处 clearTimeout 调用；改错故障：无 DOM 环境引用 window 计时器直接崩。
// INV-07 [状态] 描述先过用户可见投影，不直接渲染原始字段；守住位置：userDescription 对 getUserFacingDescription(ticket.description) 的 useMemo；改错故障：内部诊断文本泄露给终端用户。
// INV-08 [状态] 只有带下载地址的图片附件进入图墙；守住位置：imageAttachments 同时判断 kind 为 image 与 download_url 非空；改错故障：无地址附件渲染成破图或空链接。
// INV-09 [契约] 时间线由系统事件与用户补充合并后取末条；守住位置：timelineItems 与 latestTimelineItem 的取值；改错故障：只看 events 会漏掉用户补充，摘要和步数偏低。
// INV-10 [失败路径] 末条缺少摘要时按角色回退文案；守住位置：header 内 summary 为空后的嵌套三元；改错故障：摘要为空渲染空白行，用户误以为没有进展。
// INV-11 [契约] 无活动时用固定兜底文案；守住位置：latestTimelineItem 为空的两处三元与 noActivity、syncWhenUpdated；改错故障：步数为 0 却显示最近更新时间，时间语义矛盾。
// INV-12 [事务] 提交补充后靠父级重新取数，本组件不维护工单副本；守住位置：FeedbackSupplementComposer 的 onSubmitted 与 ticket 的只读用法；改错故障：本地改 ticket 与服务端分叉，刷新后回跳。
// INV-13 [契约] 进度与状态提示只读后端字段；守住位置：FeedbackProgress 与 formatFeedbackStatusHint 的入参；改错故障：组件内自行推导阶段，与列表和服务端判定不一致。
// INV-14 [权衡] 描述区整块可选，二者皆空时不出现在 DOM；守住位置：userDescription 或 imageAttachments.length 的外层三元；改错故障：空卡片占位，详情页出现无意义留白。
// INV-15 [资源] 图墙外链必须新窗口打开并切断来源；守住位置：附件 a 标签的 href、target 与 rel 三个属性；改错故障：缺 rel 会把当前页面地址暴露给外部站点。
// INV-16 [契约] 复制按钮的图标态与读屏文案同源；守住位置：issueCopyLabel 同时用于 aria-label 与 title；改错故障：图标已变对勾而读屏仍报复制，状态描述失真。
// INV-17 [状态] 首屏数据全部来自 props 的 ticket，组件不发请求；守住位置：形参解构与全文无加载副作用；改错故障：组件自行拉取形成第二条数据源，刷新时序冲突。
// INV-18 [顺序] 高度由外层 flex 列承担，滚动交给父容器；守住位置：根 div 的 h-full、min-h-0、flex-col 与 gap-4；改错故障：去掉 min-h-0 后长内容撑破面板，内部滚动失效。
//
// 模块职责：单条反馈工单的详情视图，把工单快照投影成状态头部、活动摘要、描述与图片墙，并提供工单编号复制与补充入口。
// 状态所有权：ticket、feedbackService 与两个回调由父级注入；组件只持有 copiedIssueId 与复位计时器这两个瞬时 UI 状态。
// 阅读顺序：先看三处 useMemo 投影，再看复制态副作用与回调，最后看 header 与描述区两个渲染分支。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Clock, CopyIcon, ListChecks } from "lucide-react";
import type { FeedbackTicketDetail } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { StatusIndicator } from "@/feedback/feedbackBadges.js";
import { FeedbackProgress } from "@/feedback/feedbackProgress.js";
import { FeedbackSupplementComposer } from "@/feedback/FeedbackSupplementComposer.js";
import { getFeedbackTimelineItems } from "@/feedback/feedbackTimeline.js";
import {
  formatRelativeTime,
  formatFeedbackStatusHint,
  formatSubmittedAt,
  getUserFacingDescription,
} from "@/feedback/feedbackUserView.js";
import { cn } from "@/components/lib/utils.js";
import type { IFeedbackService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

// [契约] 入参只有工单快照、反馈服务与两个回调；本组件不承担服务实例的生命周期。
// [状态] ticket 是唯一事实来源，onRefresh 触发外部重新取数，组件不缓存工单副本。
// [边界] onOpenProcess 交给父级决定路由，本组件不关心全流程页如何打开。
// [权衡] 反馈服务下传只为补充输入框提交，详情读取路径不经过它。
// [契约] 组件返回单根 flex 容器，需要父级给出确定高度，否则内部滚动无法生效。
// [顺序] 先看三处 useMemo 投影，再看复制态副作用与回调，最后看两个渲染分支。
export function TicketDetailView({
  ticket,
  feedbackService,
  onRefresh,
  onOpenProcess,
}: {
  ticket: FeedbackTicketDetail;
  feedbackService: IFeedbackService;
  onRefresh: () => Promise<void>;
  onOpenProcess: () => void;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const copiedResetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [copiedIssueId, setCopiedIssueId] = useState<string | null>(null);
  const issueIdCopied = copiedIssueId === ticket.id;
  const userDescription = useMemo(
    () => getUserFacingDescription(ticket.description),
    [ticket.description],
  );
  // [状态] 图片墙是派生的只读投影，源数据始终是 ticket.attachments。
  // [契约] 过滤同时要求 kind 为 image 且 download_url 非空，缺一不可。
  // [失败路径] 没有下载地址的附件被排除，避免渲染出无法打开的图。
  // [权衡] 依赖数组只放 ticket.attachments，附件换成新引用才重新计算。
  // [契约] 后续图片节点直接取用该地址，安全性由这里的过滤条件兜住。
  // [状态] 附件顺序沿用后端返回顺序，组件不排序，保证与上传时间一致。
  const imageAttachments = useMemo(
    () => ticket.attachments.filter((item) => item.kind === "image" && item.download_url),
    [ticket.attachments],
  );

  const submittedLabel = formatSubmittedAt(ticket.created_at, formatMessage);
  // Bugfix: 后端旧数据里可能已经持久化了中文系统摘要；详情页展示时按当前语言重新映射系统事件。
  // [状态] 时间线把系统事件与用户补充合并成单一序列，是头部摘要的唯一输入。
  // [失败路径] events 允许缺省，用空数组兜底，旧数据没有事件流时仍可渲染。
  // [顺序] 合并后再取末条，摘要与步数共享同一份列表，避免两处各算一次。
  // [契约] 语言格式化函数一并下传，切换语言后条目文案随当前 locale 重排。
  // [权衡] 合并规则留在 feedbackTimeline 模块，本组件只消费结果，不复制逻辑。
  // [状态] 末条缺失即代表从未有活动，与空数组是同一个语义出口。
  const timelineItems = getFeedbackTimelineItems(ticket.events ?? [], ticket.comments, formatMessage);
  const latestTimelineItem = timelineItems.at(-1);
  const issueCopyLabel = formatMessage({
    id: issueIdCopied ? "feedback.detail.issueCopied" : "feedback.detail.issueCopy",
  });

  // [并发] 复制成功态以工单 id 为作用域，切单时必须整体失效。
  // [顺序] 副作用先清状态再清计时器，避免清理过程中触发已排队的回调。
  // [资源] 卸载时清理仍在跑的计时器，防止已卸载组件被回调再次置状态。
  // [失败路径] 清理后把句柄置为 null，后续判断以 null 为准，不依赖已失效的 id。
  // [事务] 这里只碰 copiedIssueId 与计时器，切单不清缓存与输入草稿。
  // [权衡] 依赖只写 ticket.id，其他字段变化不应重置复制反馈。
  useEffect(() => {
    // Bugfix: TicketsView 切换工单详情时会复用当前组件实例，复制成功态必须按工单 id 失效，
    // 否则用户复制 A 后切到 B，会在 B 上短暂看到 A 的“已复制”状态。
    setCopiedIssueId(null);
    if (copiedResetTimerRef.current !== null) {
      globalThis.clearTimeout(copiedResetTimerRef.current);
      copiedResetTimerRef.current = null;
    }

    return () => {
      if (copiedResetTimerRef.current !== null) {
        globalThis.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
    };
  }, [ticket.id]);

  // [失败路径] 运行环境无剪贴板能力时提前返回，只记录一次告警。
  // [资源] 写剪贴板是异步操作，用 void 显式丢弃未处理的 promise。
  // [事务] 成功分支重新取当前工单 id 再置状态，保证回调与最新工单一致。
  // [资源] 设新计时器前清旧句柄，连续点击不会产生多个复位源。
  // [失败路径] 拒绝分支取错误对象的消息，其余情况统一转成字符串。
  // [契约] 回调依赖格式化函数与 ticket.id，二者变化即重建句柄。
  const handleCopyIssueId = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
        issueId: ticket.id,
        reason: "clipboard-unavailable",
      });
      return;
    }

    void navigator.clipboard.writeText(ticket.id).then(
      () => {
        setCopiedIssueId(ticket.id);
        if (copiedResetTimerRef.current !== null) {
          globalThis.clearTimeout(copiedResetTimerRef.current);
        }
        copiedResetTimerRef.current = globalThis.setTimeout(() => {
          setCopiedIssueId(null);
          copiedResetTimerRef.current = null;
        }, 1600);
      },
      (error: unknown) => {
        logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
          issueId: ticket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [formatMessage, ticket.id]);

  // [契约] 头部三段式：状态与编号、标题与状态提示、可选的提交时间。
  // [状态] 提交时间可能为空，空值时整个时间胶囊不渲染而不是留空格。
  // [契约] 进度条与状态提示同源，二者都只读 status，不各自推断阶段。
  // [状态] 活动卡片的摘要、步数与最近更新时间都来自同一份时间线。
  // [边界] 查看全流程按钮只回调父级，不在本组件内切换视图。
  // [顺序] 补充输入框位于头部之下，提交后靠 onRefresh 拉取新详情。
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="rounded-lg border border-card-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <StatusIndicator status={ticket.status} className="text-ui-base font-semibold" />
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
              <span className="shrink-0">
                {formatMessage({ id: "feedback.tickets.issuePrefix" })}
              </span>
              <span className="min-w-0 truncate font-mono text-foreground">{ticket.id}</span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={issueCopyLabel}
                title={issueCopyLabel}
                onClick={handleCopyIssueId}
                className="shrink-0 text-foreground-subtle hover:text-foreground"
              >
                {issueIdCopied ? (
                  <Check className="size-3 text-success" />
                ) : (
                  <CopyIcon className="size-3" />
                )}
              </Button>
            </div>
            <h2 className="mt-3 text-lg font-semibold tracking-tight text-foreground">
              {ticket.title}
            </h2>
            <p className="mt-2 max-w-2xl text-ui-base leading-6 text-foreground-subtle">
              {formatFeedbackStatusHint(ticket.status, formatMessage)}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 text-ui-base text-foreground-subtle">
            {submittedLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1">
                <Clock className="size-3" />
                {submittedLabel}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-5">
          <FeedbackProgress status={ticket.status} assigneeDisplay={ticket.assignee_display} />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
              <ListChecks className="size-3.5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-ui-base font-medium text-foreground">
                {latestTimelineItem
                  ? latestTimelineItem.summary ??
                    (latestTimelineItem.isStaff
                      ? formatMessage({ id: "feedback.timeline.officialReply" })
                      : formatMessage({ id: "feedback.timeline.yourSupplement" }))
                  : formatMessage({ id: "feedback.detail.noActivity" })}
              </p>
              <p className="mt-0.5 truncate text-ui-xs text-foreground-subtle">
                {formatMessage(
                  { id: "feedback.timeline.stepCount" },
                  { count: String(timelineItems.length) },
                )}
                {latestTimelineItem
                  ? ` · ${formatMessage(
                      { id: "feedback.timeline.latestUpdate" },
                      { time: formatRelativeTime(latestTimelineItem.createdAt, formatMessage) },
                    )}`
                  : ` · ${formatMessage({ id: "feedback.timeline.syncWhenUpdated" })}`}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenProcess}
            className="h-7 shrink-0 rounded-lg"
          >
            {formatMessage({ id: "feedback.detail.viewFullProcess" })}
            <ChevronRight />
          </Button>
        </div>
      </header>

      <FeedbackSupplementComposer
        ticketId={ticket.id}
        feedbackService={feedbackService}
        onSubmitted={onRefresh}
      />

      {userDescription || imageAttachments.length > 0 ? (
        <section className="rounded-lg border border-card-border bg-card p-4">
          <h3 className="text-ui-base font-semibold tracking-wide text-foreground-subtle">
            {formatMessage({ id: "feedback.detail.yourDescription" })}
          </h3>
          {userDescription ? (
            <p className="mt-3 whitespace-pre-wrap text-ui-base leading-7 text-foreground">
              {userDescription}
            </p>
          ) : null}
          {imageAttachments.length > 0 ? (
            <div className={cn("grid gap-2 sm:grid-cols-2", userDescription ? "mt-3" : "mt-2")}>
              {imageAttachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={attachment.download_url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border-hover"
                >
                  <img
                    src={attachment.download_url!}
                    alt=""
                    className="max-h-40 w-full object-cover"
                  />
                </a>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

    </div>
  );
}
