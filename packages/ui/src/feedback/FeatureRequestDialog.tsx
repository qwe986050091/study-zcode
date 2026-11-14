// 功能请求弹窗：三段式表单（功能描述 / 期望方案 / 联系方式），复用异步提交作业
// 展示连接、处理、失败与取消；提交成功后把工单号交给 openTickets 切页。
// 边界：不负责建单协议、日志采集与工单列表刷新，也不做本地草稿持久化（仅联系方式走偏好缓存）。
//
// 不变量（先读再改；每条都对应线上可见故障）：
// INV-01 断言：提交按钮仅在未提交且描述与方案都非空时可用 —— 守住它的位置：submitDisabled 计算 —— 改错故障：空表单可点提交，服务端收到空标题工单
// INV-02 断言：提交前必须对两个字段再做一次 trim 判空 —— 守住它的位置：handleSubmit 开头的 trimmed 判断 —— 改错故障：按钮态与真实值不同步时提交空内容
// INV-03 断言：submitting 为真时重置按钮不可用 —— 守住它的位置：handleReset 首行判断 —— 改错故障：提交中被清空草稿，进度仍在跑但内容丢失
// INV-04 断言：提交中关闭必须先取消作业，取消不掉就不能关 —— 守住它的位置：handleClose 的两次 return —— 改错故障：弹窗关闭但作业继续建单，产生用户不知情的工单
// INV-05 断言：只取消尚未拿到 ticketId 的 running 作业 —— 守住它的位置：cancelActiveCreate 与卸载清理的条件 —— 改错故障：取消掉已建单作业，客户端与远端状态分叉
// INV-06 断言：卸载后不得再写 React 状态 —— 守住它的位置：mountedRef 在所有回调中的判断 —— 改错故障：切页后出现更新已卸载组件的告警与内存泄漏
// INV-07 断言：作业回调只在仍是当前作业时生效 —— 守住它的位置：activeSubmissionJobRef 的 id 比较 —— 改错故障：旧作业的完成回调把新弹窗带进工单页
// INV-08 断言：每个提交作业只挂一个订阅且必须 dispose —— 守住它的位置：订阅 effect 的清理函数 —— 改错故障：反复提交后回调叠加，进度抖动且状态被旧作业覆盖
// INV-09 断言：作业 done 必须被 catch 吞掉再 finally 收尾 —— 守住它的位置：job.done 链 —— 改错故障：失败路径抛未处理拒绝，控制台报错且 submitting 卡在 true
// INV-10 断言：finally 里只在作业仍是当前作业时复位 submitting —— 守住它的位置：finally 内的 id 比较 —— 改错故障：连续提交时先结束的旧作业把新作业的提交态提前解除
// INV-11 断言：成功 toast 后延迟 900ms 才切工单页 —— 守住它的位置：onCompleted 的 setTimeout —— 改错故障：toast 与页面切换同时发生，用户看不到提交成功反馈
// INV-12 断言：延迟切页前要复查挂载与作业身份 —— 守住它的位置：setTimeout 回调的双条件 —— 改错故障：弹窗早已关闭仍被旧定时器拉走页面
// INV-13 断言：联系方式输入实时写回偏好缓存 —— 守住它的位置：Input 的 onChange 包装 —— 改错故障：下次打开弹窗联系方式丢失，用户需重复填写
// INV-14 断言：联系方式初值取自偏好缓存而非空串 —— 守住它的位置：useState 惰性初始化 —— 改错故障：每次打开都清空已记住的邮箱
// INV-15 断言：字段长度上限固定为 2000 与 200 —— 守住它的位置：模块常量与 maxLength —— 改错故障：超长正文被服务端截断或拒单，用户看到无解释的失败
// INV-16 断言：建单参数固定为 feature 类型、P3-低、模块其它，且不采集日志 —— 守住它的位置：startSimplifiedFeedbackSubmission 入参 —— 改错故障：功能请求被错分到问题工单，或误带日志造成隐私泄露
// INV-17 断言：正文模板各段必须 trim 后用标题拼接 —— 守住它的位置：buildFeatureRequestDescription —— 改错故障：正文出现大段空白或段标题与内容错位
// INV-18 断言：对话框关闭一律走 handleClose，不自带关闭按钮 —— 守住它的位置：onOpenChange 与 showCloseButton 为 false —— 改错故障：提交中可从右上角直接关掉，绕过取消语义
// INV-19 断言：文本域必须固定尺寸并允许长词换行 —— 守住它的位置：Textarea 的 field-sizing-fixed 与 break-words —— 改错故障：长串 URL 把弹窗撑宽，两个反馈弹窗宽度不再一致
// INV-20 断言：提交异常必须同时写错误文案并复位提交态 —— 守住它的位置：handleSubmit 的 catch —— 改错故障：失败后按钮永久禁用，只能关弹窗重开
//
// 本地状态（输入、进度、作业）都不外泄给 store；store 只提供开关与跳转入口。
// 作业对象是不透明句柄，除 id 与 getState 外不要读内部字段。
// 改这里先跑该文件单测，再在桌面与窄屏各验证一次取消与失败路径。
// 文案全部走 i18n，新增字符串时必须同步补齐各语言资源，否则界面露出 key。
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { FeedbackErrorTip, RequiredMarker } from "@/feedback/feedbackBadges.js";
import {
  readFeedbackContactPreference,
  rememberFeedbackContactInput,
} from "@/feedback/feedbackContactPreference.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { SubmitProgressView } from "@/feedback/FeedbackSubmitProgressView.js";
import {
  cancelFeedbackCreateSubmissionJob,
  dismissFeedbackSubmissionJob,
  type FeedbackSubmissionJob,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import { useFeedbackSubmissionCopy } from "@/feedback/feedbackSubmissionCopy.js";
import { startSimplifiedFeedbackSubmission } from "@/feedback/feedbackSubmitSubmission.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { toast } from "@/components/ui/toast.js";

// 字段上限是服务端校验的镜像，不要为了「更宽松」而单方面调大。
// 描述与期望方案共用同一上限，模板拼接后正文长度约为两倍，超限由服务端拒单。
// 两个弹窗的字段上限都由 FEATURE_TEXT_MAX 与 CONTACT_MAX 给出，宽度尺寸差异只允许写在输入组件里。
// 改上限时同步核对 i18n 文案里的提示数字，避免界面承诺与实际校验不一致。
const FEATURE_TEXT_MAX = 2000;
const CONTACT_MAX = 200;

// [契约] 组件只认 feedbackService，不触碰 repo 或平台实现，便于桌面与 Web 共用。
// memo 包裹是为了让父级弹窗栈重渲染时不重复挂载表单，输入态才不会丢。
// 弹窗开关与跳转工单都从 store 取，组件不持有第二份开关状态。
// 所有文案走 formatMessage，禁止在这里拼中文。
// 输入用本地 state，关闭即销毁；需要跨次保留的只有联系方式。
export const FeatureRequestDialog = memo(function FeatureRequestDialogComponent({
  feedbackService,
}: {
  feedbackService: IFeedbackService;
}) {
  const open = useFeedbackStore((state) => state.featureRequestOpen);
  const close = useFeedbackStore((state) => state.close);
  const openTickets = useFeedbackStore((state) => state.openTickets);
  const { intl, locale } = useZCodeIntl();
  const formatMessage = useCallback(
    (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const [description, setDescription] = useState("");
  const [solution, setSolution] = useState("");
  const [contact, setContact] = useState(() => readFeedbackContactPreference());
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] =
    useState<FeedbackSubmissionProgressState | null>(null);
  const [submissionJob, setSubmissionJob] = useState<FeedbackSubmissionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const activeSubmissionJobRef = useRef<FeedbackSubmissionJob | null>(null);
  const copy = useFeedbackSubmissionCopy(formatMessage);
  // 提交禁用条件把 submitting 与两个 trim 判空合成一个布尔值。
  // 注意这里的 trim 只为判断，不修改受控输入本身，也不延迟到提交时再修正。
  // 只要有一个字段是纯空白，按钮就保持禁用，与提交时的兜底判断方向一致。
  // 若新增字段，必须同时更新这里、handleSubmit 判断与模板拼接三处。
  const submitDisabled = submitting || !description.trim() || !solution.trim();

  // [资源] 首个 effect 只负责挂载标记与卸载清理，不要往这里加订阅。
  // 卸载时取消仅限「运行中且没有 ticketId」的作业，已经建单的不能撤。
  // 这里用 ref 读最新作业，避免把 job 放进依赖导致 effect 反复执行。
  // 清理里不写状态，卸载后任何 setState 都是无效且会告警。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const activeJob = activeSubmissionJobRef.current;
      const activeState = activeJob?.getState();
      if (activeJob && activeState?.status === "running" && !activeState.ticketId) {
        void cancelFeedbackCreateSubmissionJob(activeJob);
      }
    };
  }, []);

  // [并发] 订阅 effect 依赖 submissionJob 与 formatMessage，作业或语言变化都会重建订阅。
  // 回调里同时写进度、提交态与错误，三者必须来自同一份 jobState 快照。
  // paused-log 仍算提交中，否则暂停日志阶段按钮会提前恢复可点。
  // 状态为 error 时用失败文案兜底，避免 toast 与内联错误各说一套。
  // 清理必须 dispose，否则旧作业回调会把新作业的进度覆盖回去。
  useEffect(() => {
    if (!submissionJob) return;
    const subscription = submissionJob.subscribe((jobState) => {
      setSubmitProgress(jobState.progress);
      setSubmitting(jobState.status === "running" || jobState.status === "paused-log");
      if (jobState.status === "error") {
        setError(jobState.error ?? formatMessage("feedback.submission.failedLabel"));
      }
    });
    return () => subscription.dispose();
  }, [formatMessage, submissionJob]);

  // 取消动作只在「运行中且尚未拿到 ticketId」时成立，返回值表示是否真的发起取消。
  // 取消失败通过 onCancelError 写进内联错误，不再弹 toast，避免与进度视图重复提示。
  // 返回 false 表示没有可取消的作业，调用方据此决定是否允许关闭。
  // ref 与 state 可能短暂不一致，判定一律以 ref 上的活跃作业为准。
  const cancelActiveCreate = useCallback(() => {
    const activeJob = activeSubmissionJobRef.current;
    const activeState = activeJob?.getState();
    if (activeJob && activeState?.status === "running" && !activeState.ticketId) {
      void cancelFeedbackCreateSubmissionJob(activeJob, { onCancelError: setError });
      return true;
    }
    return false;
  }, []);

  // handleClose 在 submitting 时先调 cancelActiveCreate，取消成功就 return 不关闭弹窗，让用户看到取消结果。
  // 返回 true 的分支必须留在弹窗内，否则取消动作失去可见反馈。
  // 提交中但无可取消作业时直接返回，不关闭也不报错。
  // 非提交态才允许真正 close。
  // 不要简化成「submitting 就 return」，那会让用户在取消后无法退出。
  const handleClose = useCallback(() => {
    if (submitting && cancelActiveCreate()) return;
    if (submitting) return;
    close();
  }, [cancelActiveCreate, close, submitting]);

  // handleReset 只清 description、solution 与 error，contact 保留，因为联系方式属于跨次偏好。
  // 提交中直接返回，防止进度条还在跑而草稿被清空。
  // 不复位进度与作业状态，作业生命周期由订阅与 finally 收口。
  // 清错误是必要的，否则用户改完内容仍看到上一次的失败提示。
  const handleReset = useCallback(() => {
    if (submitting) return;
    setDescription("");
    setSolution("");
    setError(null);
  }, [submitting]);

  // [事务] handleSubmit 依次做 trim 校验、startSimplifiedFeedbackSubmission 启动作业与 ref 登记，任一步失败都由同一 catch 收尾。
  // 开始前先置 submitting 与连接中进度，保证首次点击即刻有反馈。
  // 正文模板在提交瞬间生成，源字段用的是 trim 后的值。
  // 作业句柄先写 ref 再写 state，顺序不能反，否则订阅回调先于身份登记。
  // 依赖数组保持完整，缺少 openTickets 会让成功回调里的跳转读到旧引用。
  const handleSubmit = useCallback(async () => {
    const trimmedDescription = description.trim();
    const trimmedSolution = solution.trim();
    // 这里是按钮态之外的二次兜底，防止状态不同步时放过空内容。
    // 报错用 featureRequest 专属文案，不复用问题反馈的必填提示。
    // 校验失败不改变 submitting，避免按钮先禁用再恢复造成闪烁。
    // 一旦通过校验，后续路径不再回头改输入值。
    if (!trimmedDescription || !trimmedSolution) {
      setError(formatMessage("feedback.featureRequest.missingRequired"));
      return;
    }
    setSubmitting(true);
    setSubmitProgress({
      kind: "working",
      label: formatMessage("feedback.submission.connectingLabel"),
      detail: formatMessage("feedback.submission.connectingDetail"),
      indeterminate: true,
    });
    setError(null);
    // [失败路径] 进入 try 前错误已清空，成功与失败分支都不会残留上一次提示。
    // 组装正文与启动作业都在 try 内，任一步抛错都会落到统一 catch。
    // 捕获分支只负责写错误文案与复位提交态，不重试也不静默吞掉。
    // 不要在这里补 toast，内联错误已足够，重复提示会盖住进度视图。
    try {
      const structuredDescription = buildFeatureRequestDescription({
        description: trimmedDescription,
        solution: trimmedSolution,
        source: formatMessage("feedback.featureRequest.source"),
        formatMessage,
      });
      // [契约] 建单参数是产品约定：feature 类型、P3-低、模块其它、不采集日志、无截图。
      // includeLogs 固定 false 是有意为之，功能请求不需要诊断日志，也避免上传用户数据。
      // modelContext 传空对象即可，服务端不要求功能请求带上下文。
      // 这里的 formatMessage 传的是 intl.formatMessage 原函数，作业内部按 id 取文案。
      // onCompleted 先 toast 再延迟跳转，onError 只在仍挂载时写错误。
      const job = await startSimplifiedFeedbackSubmission({
        feedbackService,
        title: trimmedDescription,
        description: structuredDescription,
        contact,
        screenshots: [],
        includeLogs: false,
        ticketType: "feature",
        ticketSeverity: "P3-低",
        ticketModule: "其它",
        modelContext: {},
        locale,
        copy,
        formatMessage: intl.formatMessage,
        onCompleted: (ticketId) => {
          toast(formatMessage("feedback.featureRequest.submittedToast"), { durationMs: 3000 });
          if (!mountedRef.current) return;
          window.setTimeout(() => {
            if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
              openTickets(ticketId);
            }
          }, 900);
        },
        onError: (message) => {
          if (mountedRef.current) setError(message);
        },
      });
      // 先登记 ref 再进 state，保证卸载清理与后续回调都能看到同一身份。
      // 不登记就会让取消逻辑永远找不到活跃作业，表现为关闭时无法取消。
      // setSubmissionJob 触发订阅 effect 重建，这是作业切换的唯一入口。
      // 不要在登记前 await 任何东西，否则中间窗口会被关闭路径漏判。
      activeSubmissionJobRef.current = job;
      setSubmissionJob(job);
      // [并发] done 永远不 reject 到外层，catch 吞掉后统一走 finally 收尾。
      // finally 里先 dismiss 作业缓存，再按身份判断是否复位 submitting。
      // 身份判断不可省：连续提交时旧作业先结束，误复位会让新作业按钮提前可用。
      // 这里不写 toast，成功提示由 onCompleted 负责，失败提示由订阅回调负责。
      // void 前缀表示有意不等待，避免 lint 把它当成遗漏的 Promise。
      void job.done
        .catch(() => undefined)
        .finally(() => {
          dismissFeedbackSubmissionJob(job.id);
          if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
            setSubmitting(false);
          }
        });
    // startSimplifiedFeedbackSubmission 同步抛错时 job 尚未生成，catch 只写 getErrorMessage 与复位 submitting。
    // getErrorMessage 保证非 Error 抛出也能拿到可读文案。
    // 这类失败通常是服务不可用，文案要能引导用户稍后重试。
    } catch (submitError) {
      setError(getErrorMessage(submitError));
      setSubmitting(false);
    }
  }, [
    contact,
    copy,
    description,
    feedbackService,
    formatMessage,
    locale,
    openTickets,
    solution,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(38rem,calc(100vh-2rem))] w-[min(34rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-foreground shadow-md backdrop-blur-2xl max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)]"
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 p-6 pb-0">
          <DialogTitle className="min-w-0 truncate text-ui-lg font-medium text-foreground">
            {formatMessage("feedback.featureRequest.title")}
          </DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="shrink-0 rounded-xl"
            aria-label={formatMessage("common.close")}
            onClick={handleClose}
          >
            <XIcon className="size-4" />
          </Button>
        </DialogHeader>

        <ScrollFadeViewport className="px-6 pb-4 pt-3">
          <div className="mx-auto flex max-w-[720px] flex-col gap-3">
            <FeatureRequestTextarea
              autoFocus
              required
              title={formatMessage("feedback.featureRequest.descriptionLabel")}
              value={description}
              max={FEATURE_TEXT_MAX}
              placeholder={formatMessage("feedback.featureRequest.descriptionPlaceholder")}
              onChange={setDescription}
            />
            <FeatureRequestTextarea
              required
              title={formatMessage("feedback.featureRequest.solutionLabel")}
              value={solution}
              max={FEATURE_TEXT_MAX}
              placeholder={formatMessage("feedback.featureRequest.solutionPlaceholder")}
              onChange={setSolution}
            />
            <section className="space-y-2">
              <h3 className="text-ui-base font-semibold text-foreground">
                {formatMessage("feedback.featureRequest.contactLabel")}
              </h3>
              <Input
                type="text"
                inputMode="email"
                autoComplete="email"
                value={contact}
                onChange={(event) => {
                  setContact(rememberFeedbackContactInput(event.target.value));
                }}
                maxLength={CONTACT_MAX}
                placeholder={formatMessage("feedback.submit.contact.placeholder")}
                className="h-10 rounded-xl border-input-border bg-input px-3 text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              />
            </section>
            {error ? <FeedbackErrorTip message={error} /> : null}
          </div>
        </ScrollFadeViewport>

        <div className="shrink-0 px-6 pb-6 pt-2">
          {submitting && submitProgress ? (
            <SubmitProgressView
              progress={submitProgress}
              processingLabel={formatMessage("feedback.submit.processing")}
            />
          ) : null}
          <div
            className={
              submitting && submitProgress
                ? "mt-2.5 flex items-center justify-between gap-3"
                : "flex items-center justify-between gap-3"
            }
          >
            <Button
              type="button"
              variant="link"
              size="lg"
              disabled={submitting}
              className="px-0 text-primary"
              onClick={handleReset}
            >
              {formatMessage("feedback.featureRequest.reset")}
            </Button>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="outline" size="lg" onClick={handleClose}>
                {formatMessage("common.cancel")}
              </Button>
              <Button
                size="lg"
                onClick={() => void handleSubmit()}
                disabled={submitDisabled}
                className="rounded-lg"
              >
                {submitting ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                    {formatMessage("feedback.submit.submitting")}
                  </>
                ) : (
                  formatMessage("feedback.featureRequest.submit")
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

// 文本域是受控组件，只回传字符串，不做 trim，也不阻止粘贴超长内容。
// 计数器显示原始长度而非 trim 后长度，与 maxLength 口径一致。
// required 既驱动必填星标也驱动 aria-required，两者不能只改一个。
// 组件内不读 i18n，标题与占位符全部由父级传入。
function FeatureRequestTextarea({
  autoFocus,
  required,
  title,
  value,
  max,
  placeholder,
  onChange,
}: {
  autoFocus?: boolean;
  required?: boolean;
  title: string;
  value: string;
  max: number;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  // [权衡] 固定高度会牺牲按内容自适应，换来两个反馈弹窗尺寸一致、列表不跳动。
  // 去掉 field-sizing-fixed 或 max-h 任一，长单词与 URL 都会撑开宽度。
  // whitespace-pre-wrap 与 break-words 必须同时保留，否则换行与断词只生效一半。
  // 滚动交给内部 overflow-y-auto，不要让外层容器跟着变高。
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-semibold text-foreground">
          {required ? <RequiredMarker /> : null}
          {title}
        </h3>
        <span className="text-ui-xs tabular-nums text-foreground-subtle">
          {value.length}/{max}
        </span>
      </div>
      <Textarea
        autoFocus={autoFocus}
        required={required}
        aria-required={required}
        aria-label={title}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        maxLength={max}
        placeholder={placeholder}
        // Textarea 默认的 field-sizing-content 会按无换行长文本扩张宽度。
        // 产品需求弹窗和问题反馈弹窗同宽，必须固定输入框尺寸并允许长词在框内换行。
        className="field-sizing-fixed h-[136px] max-h-[136px] min-w-0 max-w-full resize-none overflow-y-auto rounded-xl border-input-border bg-input text-ui-base leading-6 whitespace-pre-wrap break-words text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
      />
    </section>
  );
}

// buildFeatureRequestDescription 按描述、期望方案、来源三段拼标题，保持与服务端模板一致。
// 每段内容都 trim，避免标题下出现空行或首行缩进错位。
// 段标题走 i18n，正文本身不翻译，保证服务端存的是用户原文。
// 拼接用换行符，末尾不追加空行，否则工单正文会多一个空段落。
export function buildFeatureRequestDescription({
  description,
  solution,
  source,
  formatMessage,
}: {
  description: string;
  solution: string;
  source: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  // 返回的是纯字符串，不做 markdown 转义，渲染方按纯文本处理即可。
  // 顺序即工单阅读顺序，调整顺序等同于改变产品展示结构。
  return [
    `## ${formatMessage("feedback.featureRequest.descriptionLabel")}`,
    description.trim(),
    "",
    `## ${formatMessage("feedback.featureRequest.solutionLabel")}`,
    solution.trim(),
    "",
    `## ${formatMessage("feedback.submit.template.section.featureSource")}`,
    source.trim(),
  ].join("\n");
}
