// INV-01 纯展示组件：守住位置 props 解构；改错故障 流程页自己发请求，与详情页状态分叉。
// INV-02 时间线由事件与补充合并：守住位置 getFeedbackTimelineItems；改错故障 补充内容不出现在流程里。
// INV-03 最新项可能不存在：守住位置 latestItem 条件渲染；改错故障 空数组下读取 undefined 崩溃。
// INV-04 最新摘要按角色兜底：守住位置 isStaff 三元；改错故障 无摘要时显示空白一行。
// INV-05 步骤数取合并后长度：守住位置 timelineItems.length；改错故障 与时间线实际条目数不一致。
// INV-06 返回是唯一导航出口：守住位置 onBack；改错故障 页面内出现第二套路由逻辑。
// INV-07 进度只消费状态与指派人：守住位置 FeedbackProgress 入参；改错故障 进度条自行解释状态。
// INV-08 流程视图展示耗时：守住位置 showDurations；改错故障 各段耗时只在详情页可见。
// INV-09 补充提交只回调刷新：守住位置 onSubmitted；改错故障 提交后组件内重复拉取，出现双份数据。
// INV-10 标题最多两行：守住位置 line-clamp-2；改错故障 超长标题挤掉右侧计数。
// INV-11 时间用相对格式：守住位置 formatRelativeTime；改错故障 不同区块时间口径不一致。
// INV-12 全部文案走 intl：守住位置 formatMessage；改错故障 页面出现硬编码中文。
// INV-13 区块间距固定：守住位置 gap-5；改错故障 补充编辑器出现后整体错位。
// INV-14 组件不持有状态：守住位置 无 useState；改错故障 返回后筛选条件残留。
//
// 模块职责：`FeedbackProcessView` 把一张反馈工单渲染成头部摘要 / 时间线 / 补充编辑器三段。
// 阅读顺序：先看头部摘要，再看时间线区块，最后看补充编辑器。
import { ChevronLeft, Clock3, ListChecks } from "lucide-react";
import type { FeedbackTicketDetail } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { FeedbackProgress } from "@/feedback/feedbackProgress.js";
import { FeedbackSupplementComposer } from "@/feedback/FeedbackSupplementComposer.js";
import { FeedbackTimeline, getFeedbackTimelineItems } from "@/feedback/feedbackTimeline.js";
import { formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 所有数据来自 props，组件不发请求。
export function FeedbackProcessView({
  ticket,
  feedbackService,
  onBack,
  onRefresh,
}: {
  ticket: FeedbackTicketDetail;
  feedbackService: IFeedbackService;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  // 取出格式化函数，避免每处重复解构。
  const formatMessage = intl.formatMessage;
  // 事件与补充合并成一条时间线。
  const timelineItems = getFeedbackTimelineItems(ticket.events ?? [], ticket.comments, formatMessage);
  // `timelineItems` 为空时 `latestItem` 是 undefined，头部按无摘要渲染。
  const latestItem = timelineItems.at(-1);

  return (
    <div className="flex min-h-full flex-col gap-5">
      <header className="shrink-0">
        <div className="mb-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            // 返回是这里唯一的导航出口。
            onClick={onBack}
            className="h-8 rounded-lg text-foreground-subtle hover:bg-hover hover:text-foreground"
          >
            <ChevronLeft />
            {formatMessage({ id: "feedback.process.backToDetail" })}
          </Button>
        </div>
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-ui-base font-medium text-foreground-subtle">
                <ListChecks className="size-3.5" />
                {formatMessage({ id: "feedback.process.title" })}
              </div>
              <h2 className="mt-2 line-clamp-2 text-ui-lg font-semibold text-foreground">
                {ticket.title}
              </h2>
            </div>
            <div className="shrink-0 rounded-full border border-border bg-surface px-2.5 py-1 text-ui-base text-foreground-subtle">
              {formatMessage(
                { id: "feedback.timeline.stepCount" },
                // 步骤数取合并后的时间线长度。
                { count: String(timelineItems.length) },
              )}
            </div>
          </div>
          <div className="mt-4">
            <FeedbackProgress status={ticket.status} assigneeDisplay={ticket.assignee_display} />
          </div>
          {latestItem ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
              <Clock3 className="size-3.5 text-primary" />
              <span className="text-foreground-subtle">
                {formatMessage({ id: "feedback.process.currentLatest" })}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {latestItem.summary ??
                  (latestItem.isStaff
                    ? formatMessage({ id: "feedback.timeline.officialReply" })
                    : formatMessage({ id: "feedback.timeline.yourSupplement" }))}
              </span>
              <span className="shrink-0 text-foreground-subtle">
                {formatRelativeTime(latestItem.createdAt, formatMessage)}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <section className="rounded-lg border border-card-border bg-card p-4">
        <FeedbackTimeline events={ticket.events ?? []} comments={ticket.comments} showDurations />
      </section>

      <FeedbackSupplementComposer
        ticketId={ticket.id}
        feedbackService={feedbackService}
        // `onSubmitted` 直接转发父级 `onRefresh`，本组件不缓存工单也不自行重取。
        onSubmitted={onRefresh}
        title={formatMessage({ id: "feedback.supplement.continueTitle" })}
        description={formatMessage({ id: "feedback.supplement.continueDescription" })}
      />
    </div>
  );
}
