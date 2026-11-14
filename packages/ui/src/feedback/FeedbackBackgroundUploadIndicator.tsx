// INV-01 进度百分比必须落在 0 到 100 之间，负值与大于 100 的瞬时值都要被夹回边界；守住位置：progressValue 的双层钳制；改错故障：进度条反向溢出、把关闭按钮挤出视口，用户无法关掉遮挡层。
// INV-02 进度未知时不得渲染百分比文本，只有 progress 字段存在才显示数字；守住位置：百分比数字的渲染条件；改错故障：连接阶段显示 0%，用户误以为上传卡死而重复提交。
// INV-03 卡片状态只有 job 快照一个来源，组件内不得再存一份本地状态；守住位置：组件全部展示字段取自 job；改错故障：后台已成功而卡片仍显示上传中，两份状态长期分叉。
// INV-04 可交互能力统一由暂停、成功、失败三个派生布尔决定，禁止在 JSX 里散落 status 字符串比较；守住位置：isPaused 与 isSuccess 与 isError 的派生处；改错故障：新增状态时某个按钮的显隐漏改，出现点了没反应的入口。
// INV-05 成功态到期必须自动移除，定时器在状态变化与组件卸载时都要清理；守住位置：卡片内 success 分支的 useEffect 清理函数；改错故障：卡片已卸载仍触发移除，或在同一任务上叠出多个定时器。
// INV-06 只有成功态排期自动隐藏，失败态必须长期可见；守住位置：定时器 effect 首行的状态闸门；改错故障：失败卡片 5 秒后自动消失，用户来不及看清原因就失去重试入口。
// INV-07 全局任务订阅只在挂载时建立一次，卸载必须 dispose；守住位置：空依赖的订阅 effect 及其返回值；改错故障：监听器累积，一次广播触发多次状态写入，浮层闪烁并拖慢渲染。
// INV-08 首次渲染直接读取全局快照，不得用空数组起步；守住位置：useState 的惰性初始化；改错故障：卡片迟到一帧才出现，极短任务在界面上完全不可见。
// INV-09 没有任务时返回 null，不保留空的浮层根节点；守住位置：jobs 长度为 0 的早返回；改错故障：右下角常驻一个空定位层，截图与无障碍树多出无名区域。
// INV-10 反馈对话框打开时后台卡片必须整体隐藏；守住位置：feedbackDialogOpen 的早返回；改错故障：同一提交出现两份进度与两个关闭按钮，用户分不清哪份在生效。
// INV-11 多个任务各自持有独立定时器与独立移除动作，不得共享；守住位置：每张卡片自己的 effect；改错故障：一个任务成功导致所有卡片一起消失。
// INV-12 工单目标必须先打开详情再移除卡片，顺序不可倒置；守住位置：handleOpen 的 ticket 分支；改错故障：卡片消失而详情空白，用户只能再点一次才能看到工单。
// INV-13 只有成功或失败且确实带有工单号时才允许跳到已有工单；守住位置：shouldOpenExistingFeedbackTicket 的布尔表达式；改错故障：提交中点到卡片却打开尚未建成的工单，详情页空白或报错。
// INV-14 状态到图标与色调的映射必须同源覆盖四种状态，未知状态落到上传图标；守住位置：Icon 与 statusTone 两处三元链；改错故障：错误卡片配出绿色进度条，用户误以为提交成功。
// INV-15 进度不确定时不得写入宽度，只能走脉冲占位；守住位置：indeterminate 的三元分支；改错故障：进度条定格在 0 宽度，看起来像完全卡住，或写满被误读为已完成。
// INV-16 展开按钮的可访问名称与箭头图标必须同时跟随展开态；守住位置：按钮的 aria-label 三元与子图标三元；改错故障：读屏播报“展开”而实际执行收起，键盘用户无法预期行为。
// INV-17 展开态初值只由挂载时的状态派生一次，之后完全交给用户控制；守住位置：expanded 的惰性初始化；改错故障：每次进度广播重算初值，用户刚收起的卡片又被弹开。
// INV-18 卡片宽度必须同时受视口宽度约束，窄屏下不得溢出；守住位置：展开与收起两个宽度类名；改错故障：小窗口下卡片超出屏幕，关闭按钮被推到可视区外。
// INV-19 进度区域不得声明 aria-live，可访问名称由打开按钮的 aria-label 承担；守住位置：卡片根节点属性；改错故障：读屏按字节刷新反复播报百分比，其他内容无法被听清。
import { useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  PauseCircle,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  dismissFeedbackSubmissionJob,
  getFeedbackSubmissionJobsSnapshot,
  subscribeFeedbackSubmissionJobs,
  type FeedbackSubmissionJobSnapshot,
  type FeedbackSubmissionJobStatus,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

// [权衡] 5 秒是“看得见但不挡路”的折中：短于 3 秒读不完工单号，长于 10 秒卡片会压住右下角
// 的主操作区；刻意不做悬浮延长，重放悬浮会引入第二个隐藏定时器。
// 把 SUCCESS_DISMISS_DELAY_MS 放在模块顶层而不是卡片内部，是为了让测试与实现引用同一个常量，避免魔法数字漂移。
// [资源] 定时器句柄由卡片内的 useEffect 持有，状态离开 success 或组件卸载时清掉；
// 若改成模块级共享定时器，两张成功卡会互相 clear，先成功的那张永远不消失。
// 也不能在渲染期排期，那样每次进度广播都会新增一个定时器，5 秒后集中触发移除。
// 该值不参与任何计算而只作为延迟时长传入，因此不需要按环境区分。
const SUCCESS_DISMISS_DELAY_MS = 5_000;

interface FeedbackBackgroundUploadIndicatorProps {
  feedbackDialogOpen: boolean;
}

export interface FeedbackBackgroundUploadIndicatorViewProps {
  status: FeedbackSubmissionJobStatus;
  progress: FeedbackSubmissionProgressState;
  ticketId?: string;
  error?: string;
  onOpen: () => void;
  onContinueUpload: () => void;
  onDismiss: () => void;
  defaultExpanded?: boolean;
}

// [契约] 返回值是类型守卫：只有成功或失败且确实带工单号时为真，调用方据此选择
// “重开已有工单”还是“重开提交进度”，两者对应 store 上两个不同的打开动作。
// running 与 paused-log 一律为假：此时工单可能尚未建成，带着空号去打开详情只会得到空白页。
// [失败路径] 空串与 undefined 都必须落回提交视图，不能把空串当成有效工单号传下去。
// 用 Boolean 收口而不是直接判真值，是为了让类型守卫成立；漏掉这层，下游拿到的是 string 或 undefined。
// [权衡] 没有把“是否带错误”纳入判断：失败但工单已建成时仍应打开工单，让用户在原工单上补充信息。
// 若改成只看工单号，成功与失败两种入口语义会混在一起，后续想区分就得再改一次调用点。
export function shouldOpenExistingFeedbackTicket(
  status: FeedbackSubmissionJobStatus,
  ticketId: string | undefined,
): ticketId is string {
  return Boolean(ticketId) && (status === "success" || status === "error");
}

export type FeedbackBackgroundOpenTarget =
  | { kind: "submission"; jobId: string }
  | { kind: "ticket"; ticketId: string };

export function getFeedbackBackgroundOpenTarget(
  job: Pick<FeedbackSubmissionJobSnapshot, "id" | "status" | "ticketId">,
): FeedbackBackgroundOpenTarget {
  if (shouldOpenExistingFeedbackTicket(job.status, job.ticketId)) {
    return { kind: "ticket", ticketId: job.ticketId };
  }
  return { kind: "submission", jobId: job.id };
}

export function FeedbackBackgroundUploadIndicator({
  feedbackDialogOpen,
}: FeedbackBackgroundUploadIndicatorProps) {
  // useState 的初始值直接取全局注册表快照，而不是空数组：卡片挂载与提交发起可能落在同一帧，
  // 空数组起步会先渲染 null，再等下一次广播才出现，极短任务在界面上完全不可见。
  // [并发] setJobs 的惰性初始化只在首次渲染执行一次，后续快照变化全部走订阅回调；
  // 若把快照读取写在渲染体中，每次进度广播都会多读一次注册表，状态也会出现两份来源。
  // [资源] 这里拿到的是注册表快照的拷贝，卡片直接读字段即可，不必再为每个 job 建订阅。
  // [失败路径] 注册表为空时返回空数组而不是 undefined，因此下游可以无条件读取它的长度。
  // 不在初始化时做过滤或排序：顺序由插入序决定，前端再排一次会让卡片在进度更新时跳位。
  const [jobs, setJobs] = useState<FeedbackSubmissionJobSnapshot[]>(() =>
    getFeedbackSubmissionJobsSnapshot(),
  );
  const openSubmissionJob = useFeedbackStore((state) => state.openSubmissionJob);
  const openTickets = useFeedbackStore((state) => state.openTickets);

  // [资源] 订阅必须在挂载时建立、卸载时 dispose：注册表是模块级集合，
  // 漏掉 dispose 会让已卸载的组件继续被广播回调持有，热更新几次后一次广播触发多次 setJobs。
  // 依赖数组刻意留空：订阅函数与 setJobs 都是稳定引用，把 jobs 放进去会退化成
  // 把 jobs 放进依赖会变成“每次广播重新订阅”，回调在遍历监听器集合时被增删，订阅数量增长不可控。
  // [并发] 订阅时会立即回调一次当前快照，因此 effect 里不再主动拉一次，
  // 否则首帧会出现两次状态写入，多跑一轮渲染并可能吞掉中间态。
  // [失败路径] dispose 只移除监听器，不取消后台任务：卸载卡片不等于取消上传，
  // 若在这里顺手取消，用户切走页面就会把正在上传的日志一起掐断。
  useEffect(() => {
    const subscription = subscribeFeedbackSubmissionJobs(setJobs);
    return () => subscription.dispose();
  }, []);

  // 空任务直接返回 null，浮层根节点只在确有卡片时存在；
  // 保留空容器会让右下角常驻一个固定定位层，截图与无障碍树里都多出一块无名区域。
  // 紧邻的 feedbackDialogOpen 分支含义不同：不是没有任务，而是反馈面板正占据焦点，
  // 此时再叠一层后台卡片会出现两份进度、两个关闭按钮，用户分不清哪份是当前提交。
  // [权衡] 两个早返回都放在订阅 effect 之后，保证隐藏期间仍持续接收快照：
  // 若提前到 effect 之前返回，对话框关闭后要等下一次广播才有数据，卡片会迟到一拍。
  // 也不在隐藏时清空 jobs，那样关闭对话框后必须重读注册表，等于放弃订阅带来的连续性。
  // 返回 null 而不是用可见性隐藏，避免隐藏元素仍参与布局与 Tab 焦点顺序。
  if (jobs.length === 0) {
    return null;
  }

  if (feedbackDialogOpen) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-[9998] flex max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 overflow-y-auto sm:right-4 sm:bottom-4">
      {jobs.map((job) => (
        <FeedbackBackgroundUploadJobCard
          key={job.id}
          job={job}
          onOpenSubmissionJob={openSubmissionJob}
          onOpenTicket={openTickets}
        />
      ))}
    </div>
  );
}

function FeedbackBackgroundUploadJobCard({
  job,
  onOpenSubmissionJob,
  onOpenTicket,
}: {
  job: FeedbackSubmissionJobSnapshot;
  onOpenSubmissionJob: (jobId: string) => void;
  onOpenTicket: (ticketId?: string) => void;
}) {
  // [资源] 成功态在这里排一个一次性定时器，到期后把该 job 从全局队列移除；
  // 清理函数必须同时覆盖“状态离开 success”与“卡片卸载”两种情况，否则定时器会在
  // 组件已不存在的时刻触发一次移除，或在同一 job 上叠出多个定时器。
  // 依赖只有 job.id 与 job.status：进度对象每次广播都是新引用，把它放进依赖
  // 会让 5 秒倒计时在每个进度帧重置，成功卡永远等不到到期。
  // [失败路径] 非 success 直接 return，不排期也不清理——失败卡要一直可见，用户才有机会点进去重试。
  // 定时器只删展示项，不取消已完成的提交；换成取消会让成功工单在后台被撤销。
  // 同一毫秒出现两张成功卡时各持一个定时器，各自按自己的 jobId 收口，互不覆盖。
  useEffect(() => {
    if (job.status !== "success") return;
    const timer = window.setTimeout(() => {
      dismissFeedbackSubmissionJob(job.id);
    }, SUCCESS_DISMISS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [job.id, job.status]);

  // [事务] ticket 分支的顺序固定为“先打开工单、再移除卡片”：反过来会出现
  // 卡片已消失、详情却因工单尚未加载而空白的窗口，用户只能再点一次。
  // 提交分支只打开、不移除：任务仍在跑，移除后进度无处可见，用户会以为上传被取消。
  // [失败路径] 移除可能被上游拒绝（目标处于暂停态），此时卡片保留是预期结果，不能在此重试或报错。
  // 日志只记 jobId、状态与目标类型而不打印表单、提示词或附件内容，避免用户输入落进日志文件。
  // [权衡] 不做“正在打开”去重：打开同一工单是幂等操作，加锁会吞掉第二次点击，
  // 真正的重复提交由提交侧幂等号兜住，不该在这一层重复解决。
  // 目标类型用 kind 判别字段表达，不要用工单号是否存在来推断：两者在失败态会分叉。
  const handleOpen = () => {
    const target = getFeedbackBackgroundOpenTarget(job);
    logger.debug("[FeedbackBackgroundUploadIndicator] 打开后台反馈卡片", {
      jobId: job.id,
      status: job.status,
      target: target.kind,
    });
    if (target.kind === "ticket") {
      onOpenTicket(target.ticketId);
      dismissFeedbackSubmissionJob(job.id);
      return;
    }
    // 多个上传任务必须按被点击卡片的 jobId 打开，不能再回退到最后一个活动任务。
    onOpenSubmissionJob(target.jobId);
  };

  return (
    <FeedbackBackgroundUploadIndicatorView
      status={job.status}
      progress={job.progress}
      ticketId={job.ticketId}
      error={job.error}
      onOpen={handleOpen}
      onContinueUpload={job.job.continueLogUpload}
      onDismiss={() => dismissFeedbackSubmissionJob(job.id)}
    />
  );
}

export function FeedbackBackgroundUploadIndicatorView({
  status,
  progress,
  ticketId,
  error,
  onOpen,
  onContinueUpload,
  onDismiss,
  defaultExpanded = false,
}: FeedbackBackgroundUploadIndicatorViewProps) {
  const { intl } = useZCodeIntl();
  // [权衡] 进度先按 undefined 兜底为 0，再夹在 0 到 100 之间：上游可能给出负数或超过 100 的瞬时值，
  // 直接写进宽度样式会让进度条反向溢出，把卡片撑破并把关闭按钮挤出视口。
  // 上下界缺一不可：只取上界时负值仍然生效，只取下界时超过 100 的宽度会被浏览器裁掉。
  // 这里不做四舍五入：99.6 显示成 100 而进度条还差一截，用户会以为已经传完。
  // [失败路径] 上游若传入非数值，钳制无法把它变成合法数字，宽度声明会被浏览器丢弃，
  // 进度条退回满宽；所以本函数只保证有限数值的范围，不清洗脏数据，脏数据由上游契约挡。
  // 显示百分比与进度条宽度共用这一个值，两处各算一遍就会出现数字与长度不一致。
  const progressValue = Math.max(0, Math.min(progress.progress ?? 0, 100));
  const isPaused = status === "paused-log";
  const isSuccess = status === "success";
  const isError = status === "error";
  const shouldDefaultExpanded = isPaused || isError;
  const [expanded, setExpanded] = useState(() => shouldDefaultExpanded || defaultExpanded);
  const Icon = isPaused ? PauseCircle : isSuccess ? CheckCircle2 : isError ? AlertCircle : Upload;
  const statusTone = isError
    ? "text-destructive"
    : isSuccess
      ? "text-success"
      : isPaused
        ? "text-warning"
        : "text-primary";

  return (
    <div
      className={cn(
        "pointer-events-auto overflow-hidden rounded-xl border border-popover-border bg-popover text-foreground shadow-lg transition-[width] duration-200",
        expanded ? "w-[min(380px,calc(100vw-1.5rem))]" : "w-[min(320px,calc(100vw-1.5rem))]",
      )}
    >
      <div
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5",
          expanded ? "px-3 py-2.5" : "px-3 py-2",
        )}
      >
        <Icon
          // 后台提示是 toast 语义，状态图标不应再包一层边框底座，
          // 否则会被误读成独立按钮，也会和外层浮层圆角形成重复层级。
          className={cn("mt-0.5 shrink-0", expanded ? "size-4" : "size-3.5", statusTone)}
        />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={intl.formatMessage({ id: "feedback.background.open" })}
        >
          <div className="min-w-0 truncate text-ui-base font-medium leading-5 text-foreground">
            {intl.formatMessage({ id: "feedback.background.title" })}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-ui-base leading-5 text-foreground-subtle">
              {progress.label}
            </span>
            {progress.progress !== undefined ? (
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                {progressValue}%
              </span>
            ) : null}
          </div>
          {expanded ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtlest">
              <span className="min-w-0 truncate">
                {error ||
                  progress.detail ||
                  ticketId ||
                  intl.formatMessage({ id: "feedback.background.defaultDetail" })}
              </span>
              <span className="shrink-0 text-foreground-subtle">
                {intl.formatMessage({ id: "feedback.background.openDetail" })}
              </span>
            </div>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              // 收起态再点“展开”只露出一小截状态条，用户还要二次操作；这里直接打开完整反馈页。
              if (!expanded) {
                onOpen();
                return;
              }
              setExpanded(false);
            }}
            className="shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
            aria-label={intl.formatMessage({
              id: expanded ? "feedback.background.collapse" : "feedback.background.open",
            })}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </Button>
          {/* Bugfix: paused-log 只能继续上传；如果允许隐藏，会把等待用户动作的后台 job 变成不可恢复的悬挂状态。 */}
          {!isPaused ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onDismiss}
              className="shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
              aria-label={intl.formatMessage({ id: "feedback.background.dismiss" })}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className={cn("bg-border", expanded ? "h-1" : "h-0.5")}>
        {progress.indeterminate ? (
          <div className="h-full w-1/3 animate-pulse rounded-r-full bg-primary" />
        ) : (
          <div
            className={cn(
              "h-full rounded-r-full transition-[width] duration-200",
              isError
                ? "bg-destructive"
                : isSuccess
                  ? "bg-success"
                  : isPaused
                    ? "bg-warning"
                    : "bg-primary",
            )}
            style={{ width: `${progressValue}%` }}
          />
        )}
      </div>
      {expanded && isPaused ? (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface px-3 py-2">
          <Button type="button" size="sm" onClick={onContinueUpload}>
            {intl.formatMessage({ id: "feedback.submit.continueUpload" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
