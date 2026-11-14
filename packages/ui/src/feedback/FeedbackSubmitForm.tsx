// 反馈提交表单：收集问题描述、联系方式、截图与日志开关，并驱动一次后台提交任务，向用户回报进度与失败原因。
// 不负责：工单的读写与服务端校验（IFeedbackService）、进度视图的结构（SubmitProgressView）、
// 提交任务的排队/重试/取消实现（feedbackSubmissionJob）；本文件只编排 UI 侧状态与回调时序。
//
// 不变量（逐条核对，任一破坏都会在线上表现为「表单卡死 / 内容丢失 / 重复工单」）：
// INV-01 断言：提交按钮在描述 trim 后为空时禁用，handleSubmit 首段仍二次校验 —— 守住它的位置：SubmitFooter 的 submitDisabled 与 handleSubmit 开头 —— 改错故障：空描述也能发请求，后端 400 后用户只看到泛化失败。
// INV-02 断言：日志开关用 ?? 合并草稿值且默认开启 —— 位置：includeLogs 的 useState 初值与 applySubmitDraft —— 故障：用户取消勾选后恢复草稿又被强制打开，上传了本不想上传的诊断日志。
// INV-03 断言：仅当带日志或带截图时才在工单创建瞬间自动关闭表单 —— 位置：shouldAutoCloseFeedbackOnTicketCreated 及其调用点 —— 故障：带附件提交被提前关闭，后续上传失败用户完全看不到。
// INV-04 断言：后台任务恢复必须由 submissionJobId 精确命中 —— 位置：第三个 useEffect 里的 getFeedbackSubmissionJob —— 故障：旧任务的进度锁住新表单，新建反馈长时间无法提交。
// INV-05 断言：恢复 job 时必须同时恢复该 job 的 formDraft —— 位置：applySubmitDraft(selectedJob.formDraft) 调用处 —— 故障：进度条有数据但描述为空，用户以为内容丢失并重复提单。
// INV-06 断言：草稿只在引用不同时应用 —— 位置：appliedDraftRef 与 initialDraft effect 的相等判断 —— 故障：父组件重渲染把用户正在编辑的内容覆盖回旧草稿。
// INV-07 断言：只有任务 running 且没有 ticketId 才允许取消 —— 位置：卸载清理与 handleCancel —— 故障：工单已创建仍被取消，用户收到成功提示却在列表里查不到。
// INV-08 断言：卸载后任何异步回调都先检查 mountedRef —— 位置：onCompleted、onError、job.done 的 finally —— 故障：对已销毁组件写 state，警告之外还可能污染下一个实例的 submitting。
// INV-09 断言：截图数量硬上限 5，超出部分丢弃并提示 —— 位置：appendScreenshotFiles 的 remaining、slice 与提示分支 —— 故障：附件超限导致整条反馈被后端拒绝。
// INV-10 断言：焦点在 input/textarea 时不接管粘贴 —— 位置：handleFormPaste 首行的 isTextInputFocused —— 故障：联系方式框里粘贴图片被拦截，连文本粘贴也一起失效。
// INV-11 断言：提交载荷用未 trim 的 description，trim 只参与校验 —— 位置：startSimplifiedFeedbackSubmission 的入参 —— 故障：用户排版的换行被抹平，后台卡片里的描述失去可读性。
// INV-12 断言：job.done 必须被 catch，finally 里按 job.id 比对后才解锁 —— 位置：handleSubmit 尾部的任务收尾 —— 故障：未捕获拒绝变成 unhandledrejection；旧任务结束会提前解锁新任务的按钮。
//
// 阅读顺序：常量与自动关闭判定 → 组件 ref/state → 草稿与后台任务恢复 effect → 截图与粘贴 →
// 取消与提交 → JSX。末尾两个局部函数分别负责焦点判定与模型上下文投影。
//
// 注释只描述当前实现；改动行为前先确认上述不变量是否仍然成立。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import {
  type FeedbackTicketModule,
  type FeedbackTicketSeverity,
  type FeedbackTicketType,
} from "@zcode/shared";
// 组件只依赖注入的服务与共享类型，不直接访问 window.zcode、Repo 或平台实现；
// 跨包导入走公开入口与既有路径别名，平台差异由 props 注入（platform 以 _platform 接收）。
// 提交相关的副作用（排队、上传、取消）全部下沉到 feedbackSubmitSubmission 与 feedbackSubmissionJob，这里不重写一份。
import { toast } from "@/components/ui/toast.js";
import { FeedbackErrorTip } from "@/feedback/feedbackBadges.js";
import { readFeedbackContactPreference } from "@/feedback/feedbackContactPreference.js";
import {
  FeedbackScreenshotPicker,
  readScreenshotDraft,
  type ScreenshotAttachmentDraft,
} from "@/feedback/FeedbackScreenshotPicker.js";
import {
  ContactSection,
  DescriptionSection,
  LogUploadToggle,
  Section,
  SubmitFooter,
} from "@/feedback/FeedbackSubmitSections.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import {
  readCurrentAgentModelContext,
  type FeedbackAgentModelContext,
} from "@/feedback/feedbackSubmitModelContext.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import {
  cancelFeedbackCreateSubmissionJob,
  getFeedbackSubmissionJob,
  type FeedbackSubmissionJob,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import { useFeedbackSubmissionCopy } from "@/feedback/feedbackSubmissionCopy.js";
import {
  DEFAULT_FEEDBACK_MODULE,
  DEFAULT_FEEDBACK_SEVERITY,
  DEFAULT_FEEDBACK_TYPE,
  startSimplifiedFeedbackSubmission,
} from "@/feedback/feedbackSubmitSubmission.js";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export { SubmitProgressView } from "@/feedback/FeedbackSubmitProgressView.js";
export { readCurrentAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";

// [契约] 4000 / 200 / 5 分别约束描述、联系方式与截图数量，前端只做兜底，真正校验在后端。
// 把这里的值调大却不改后端，用户填完才在提交阶段整条失败，而且看不出是哪一项超限。
// [权衡] 上限做成模块常量而非 props，是为了让计数展示与截断共享同一份来源；
// 若改成可配置，需要同步 DescriptionSection、ContactSection 的 max 与 appendScreenshotFiles 的截断逻辑。
const DESCRIPTION_MAX = 4000;
const CONTACT_MAX = 200;
const MAX_SCREENSHOT_ATTACHMENTS = 5;

type SubmitProgressState = FeedbackSubmissionProgressState;

// [契约] 只有带日志或带截图的提交才在工单创建瞬间关闭表单：这两类内容还会继续异步上传，
// 用户需要留在页面上看到真实进度与失败原因；纯文本提交没有后续阶段，立即关闭是预期体验。
// [失败路径] 返回值在提交瞬间计算一次，之后不再随 includeLogs 或截图变化，保证与本次载荷一致。
// 改成无条件返回 true，会让带附件的提交失败时表单已经消失，只剩一条 toast，现场最难复现。
export function shouldAutoCloseFeedbackOnTicketCreated({
  includeLogs,
  screenshotCount,
}: {
  includeLogs: boolean;
  screenshotCount: number;
}): boolean {
  return includeLogs || screenshotCount > 0;
}

// platform 以 _platform 接收而不是删掉：调用方按统一签名注入平台服务，删形参会迫使桌面与 Web 两个入口各改调用点。
// 组件内所有可变状态都是 UI 局部状态，不写入 store，避免与后台 job 形成两份事实来源。
// _platform 前缀同时让 lint 忽略未使用参数，不要改成省略参数或解构，那会改变调用方依赖的 props 形状。
export function FeedbackSubmitForm({
  feedbackService,
  platform: _platform,
  initialDraft,
  submissionJobId,
  onSubmitted,
  onViewTickets,
  onCancel,
}: {
  feedbackService: IFeedbackService;
  platform: IPlatformService;
  initialDraft?: FeedbackSubmitDraft | null;
  submissionJobId?: string | null;
  onSubmitted: (ticketId: string) => void;
  onViewTickets: () => void;
  onCancel: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const formatMessage = useCallback(
    (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values),
    [intl],
  );
  // 用引用相等判断草稿是否已应用，而不是内容比较：initialDraft 每次渲染都可能是新对象，
  // 内容比较会把用户在当前草稿上的编辑重置，引用比较只在父级换了另一份草稿时才覆盖。
  // 该 ref 由 applySubmitDraft 内部赋值，供 initialDraft effect 与后台任务恢复共用，不要拆成两个标记。
  const appliedDraftRef = useRef<FeedbackSubmitDraft | null>(null);
  // [资源] 跨 await 的回调（onCompleted、onError、job.done 的 finally）都依赖它，
  // 因为提交任务的生命周期长于组件：用户可能关掉进度页、切换 tab 或关窗导致卸载。
  // 不要换成 useState：更新它不需要触发渲染，也不该进入任何依赖数组。
  const mountedRef = useRef(true);
  const activeSubmissionJobRef = useRef<FeedbackSubmissionJob | null>(null);
  const modelContext = useActiveFeedbackModelContext();
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState(() => readFeedbackContactPreference());
  const [screenshots, setScreenshots] = useState<ScreenshotAttachmentDraft[]>([]);
  // 新反馈默认附带诊断日志；显式草稿值保留用户取消勾选及后台恢复时的选择。
  // 这里必须是 ?? 而不是 ||：false 是用户取消勾选日志的显式选择，用 || 会被默认值吞掉。
  // 初值只取一次，后续草稿切换交给 applySubmitDraft；后台任务恢复同样保留 job 快照里的勾选状态。
  // 默认开启是有意为之：诊断日志是定位问题的主要依据，默认关闭会让多数反馈无法排查。
  const [includeLogs, setIncludeLogs] = useState(initialDraft?.includeLogs ?? true);
  const [ticketType, setTicketType] = useState<FeedbackTicketType>(DEFAULT_FEEDBACK_TYPE);
  const [ticketSeverity, setTicketSeverity] =
    useState<FeedbackTicketSeverity>(DEFAULT_FEEDBACK_SEVERITY);
  const [ticketModule, setTicketModule] = useState<FeedbackTicketModule>(DEFAULT_FEEDBACK_MODULE);
  const [submitting, setSubmitting] = useState(false);
  // 进度只是渲染投影，事实来源是 submissionJob 的订阅回调；
  // 不要在 handleSubmit 里手工维护进度文案，否则会与后台阶段机形成两套状态。
  // 初值 null 表示尚未开始，footer 据此决定是否渲染进度条。
  const [submitProgress, setSubmitProgress] = useState<SubmitProgressState | null>(null);
  const [submissionJob, setSubmissionJob] = useState<FeedbackSubmissionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 文案表由 formatMessage 派生；切换语言时 formatMessage 引用变化会带动它重建，
  // handleSubmit 依赖它，因此语言切换后的下一次提交一定使用新语言，不会残留旧文案。
  // 这里不做额外缓存：文案量小，重建成本远低于缓存失效导致的脏文案风险。
  const submissionCopy = useFeedbackSubmissionCopy(formatMessage);

  // [契约] 草稿字段一律用 ?? 合并：description 允许为空字符串（用户主动清空），
  // 只有 undefined/null 才回落到 title；写成 || 会把空描述替换成标题，正文被悄悄改写。
  // 截图应用时重新生成 id，避免后台 job 快照与当前列表共用同一 id，导致删除时错位。
  // 每次应用都清空 error：上一次的失败提示不属于新草稿，留着会让用户重复排查。
  const applySubmitDraft = useCallback((draft: FeedbackSubmitDraft) => {
    appliedDraftRef.current = draft;
    setDescription(draft.description ?? draft.title ?? "");
    if (draft.contact !== undefined) {
      setContact(draft.contact);
    }
    setTicketType(draft.type ?? DEFAULT_FEEDBACK_TYPE);
    setTicketSeverity(draft.severity ?? DEFAULT_FEEDBACK_SEVERITY);
    setTicketModule(draft.module ?? DEFAULT_FEEDBACK_MODULE);
    setIncludeLogs(draft.includeLogs ?? true);
    setScreenshots(
      (draft.screenshots ?? []).map((item, index) => ({
        id: `draft-${Date.now()}-${index}`,
        filename: item.filename,
        contentType: item.contentType,
        dataBase64: item.dataBase64,
        size: item.size,
      })),
    );
    setError(null);
  }, []);

  useEffect(() => {
    // [资源] 卸载清理只在任务仍在跑且尚未产出工单时取消上传，
    // 一旦拿到 ticketId，工单已存在于服务端，再取消只会制造「提示成功但查不到」的错觉。
    // 清理读的是 activeSubmissionJobRef 而非 state：卸载闭包里 state 永远是首次渲染的值。
    // 取消请求失败被静默忽略是刻意的，不要在这里补 await 或重试，卸载流程不能再被阻塞。
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

  useEffect(() => {
    // [并发] 拿到新 job 就重新订阅，旧订阅在 cleanup 里 dispose；
    // 否则切换后台任务后会有两个订阅同时写 submitProgress，进度条在新旧状态间抖动。
    // setSubmitting 由 status 推导（running 与 paused-log 都算进行中），不要另设一个布尔量。
    // 订阅已在卸载时 dispose，这里不再判断 mountedRef；多一层判断会掩盖真正的订阅泄漏。
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

  useEffect(() => {
    // [契约] 后台任务恢复只认 submissionJobId，绝不猜「最近一个活动 job」，
    // 否则上一次失败或暂停的任务会一直锁住新建表单，用户以为页面卡死。
    // 找不到对应 job 时静默返回：多半是刷新后任务已结束，这里报错只会制造噪音。
    // 恢复顺序不能颠倒：先 applySubmitDraft 再 setSubmissionJob，保证订阅首次回调时表单已有内容。
    if (submissionJob) return;
    if (!submissionJobId) return;
    // 后台提交必须由用户点击的 card 通过 jobId 精确绑定。
    // 新建问题上报不再猜测“最后一个活动 job”，避免旧上传状态锁住新表单。
    const selectedJob = getFeedbackSubmissionJob(submissionJobId);
    if (!selectedJob) return;
    logger.debug("[FeedbackSubmitForm] 恢复后台反馈任务", {
      jobId: selectedJob.id,
      hasFormDraft: Boolean(selectedJob.formDraft),
      screenshotCount: selectedJob.formDraft.screenshots?.length ?? 0,
    });
    // 恢复 job 进度时必须同时恢复该 job 的原始表单，否则问题描述为空。
    // 表单快照随 job 保存，确保并发提交时点击不同 card 能看到各自的内容。
    applySubmitDraft(selectedJob.formDraft);
    activeSubmissionJobRef.current = selectedJob;
    setSubmissionJob(selectedJob);
  }, [applySubmitDraft, submissionJob, submissionJobId]);

  useEffect(() => {
    // initialDraft 变化（例如从列表再次点开同一草稿）才重新应用，引用相同则跳过，
    // 这样用户在表单里的编辑不会因为父组件频繁重渲染而被清掉。
    // [权衡] 不做深比较：草稿由上层按份生成，深比较收益极低，却容易在数组字段上漏项。
    if (!initialDraft || appliedDraftRef.current === initialDraft) return;
    applySubmitDraft(initialDraft);
  }, [applySubmitDraft, initialDraft]);

  // [并发] remaining 用闭包里的 screenshots.length 计算，依赖数组已列出它；
  // 若从依赖里移除，连续两次粘贴会各按旧长度判断，最终突破 5 张上限。
  // Promise.all 中任一文件读取失败会整批丢弃，已读成功的也不会进入列表，
  // 这是刻意的原子语义：宁可让用户重选，也不要出现只加进来一半的截图。
  const appendScreenshotFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      setError(null);
      try {
        const remaining = Math.max(MAX_SCREENSHOT_ATTACHMENTS - screenshots.length, 0);
        const next = await Promise.all(
          imageFiles.slice(0, remaining).map((file) => readScreenshotDraft(file)),
        );
        if (next.length > 0) {
          setScreenshots((current) => [...current, ...next].slice(0, MAX_SCREENSHOT_ATTACHMENTS));
        }
        if (imageFiles.length > remaining) {
          setError(
            formatMessage("feedback.submit.screenshotLimit", {
              count: String(MAX_SCREENSHOT_ATTACHMENTS),
            }),
          );
        }
      } catch (readError) {
        setError(getErrorMessage(readError));
      }
    },
    [formatMessage, screenshots.length],
  );

  // [失败路径] 焦点在 input/textarea 时不接管粘贴：这两种元素有自己的粘贴行为，
  // 同时处理会让同一张图片既插入文本又变成附件。
  // 只有剪贴板里确实有图片文件才 preventDefault，纯文本粘贴必须放行给默认行为。
  const handleFormPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (isTextInputFocused(event.currentTarget.ownerDocument)) return;

      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;

      event.preventDefault();
      void appendScreenshotFiles(files);
    },
    [appendScreenshotFiles],
  );

  // [契约] 取消按钮有两套语义，由任务是否在跑且未出单决定：
  // 进行中且无 ticketId 时取消后台任务并留在表单，用户可修改后重提；
  // 未提交、已出单、已失败则直接走 onCancel 关闭。
  // 漏掉 ticketId 判断会在工单已创建时误取消，用户拿到成功提示却查不到记录。
  const handleCancel = useCallback(() => {
    const activeJob = activeSubmissionJobRef.current;
    const activeState = activeJob?.getState();
    if (submitting && activeJob && activeState?.status === "running" && !activeState.ticketId) {
      void cancelFeedbackCreateSubmissionJob(activeJob, { onCancelError: setError });
      return;
    }
    onCancel();
  }, [onCancel, submitting]);

  // [事务] 提交只有一个入口：先本地校验，再置 submitting，最后创建后台任务。
  // setSubmitting(true) 必须在第一个 await 之前，否则连点期间按钮仍可点，会创建两个 job。
  // 闭包里的 description 与 screenshots 就是点击瞬间的快照，中途编辑不会污染本次提交，
  // 所以依赖数组必须列全，漏项会让快照退回更早的渲染值。
  const handleSubmit = useCallback(async () => {
    // 校验只看 trim 后的结果，纯空白描述不发起请求；提交载荷仍用原文 description，
    // 保留用户排版（换行、缩进），后台卡片恢复时展示才一致。
    // 提示文案走后端 key（feedback.submit.missingDescription），不要在这里写死中文。
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setError(formatMessage("feedback.submit.missingDescription"));
      return;
    }
    // [契约] 置位提交中后立刻铺一条「连接中」进度，避免后台任务创建前 footer 空白；
    // indeterminate 表示此刻还没有真实阶段可报，后续由 job 订阅覆盖。
    // 随后清空 error：上一次的失败提示与本次提交无关。
    setSubmitting(true);
    setSubmitProgress({
      kind: "working",
      label: formatMessage("feedback.submission.connectingLabel"),
      detail: formatMessage("feedback.submission.connectingDetail"),
      indeterminate: true,
    });
    setError(null);
    try {
      // [权衡] 是否自动关闭在提交瞬间判定一次，不放到回调里再读 state，
      // 因为回调触发时用户可能已经改过截图或日志开关，那时再判断会与本次提交内容不符。
      // 两个入参都取本次闭包快照，保证行为与用户点击时看到的一致。
      const shouldCloseOnTicketCreated = shouldAutoCloseFeedbackOnTicketCreated({
        includeLogs,
        screenshotCount: screenshots.length,
      });
      // [契约] 同时传 copy 与 intl.formatMessage：前者给后台阶段的固定文案，
      // 后者给需要插值的动态文案；混用会导致进度页出现未替换的占位符。
      // description 传原文而非 trimmedDescription，理由见上一条校验注释。
      const job = await startSimplifiedFeedbackSubmission({
        feedbackService,
        // 后端正文使用 trim 后的内容，但后台卡片恢复时必须保留用户输入原文。
        description,
        contact,
        screenshots,
        includeLogs,
        ticketType,
        ticketSeverity,
        ticketModule,
        modelContext,
        locale,
        copy: submissionCopy,
        formatMessage: intl.formatMessage,
        onTicketCreated: shouldCloseOnTicketCreated
          ? () => {
              if (mountedRef.current) {
                onCancel();
              }
            }
          : undefined,
        onCompleted: (ticketId) => {
          toast(formatMessage("feedback.submission.submittedToast"), { durationMs: 3000 });
          if (!mountedRef.current) return;
          window.setTimeout(() => {
            if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
              onSubmitted(ticketId);
            }
          }, 1200);
        },
        // [失败路径] 任务失败时只写 error，不解除 submitting：
        // job.done 的 finally 会统一解锁，在这里重复解锁会让按钮提前可点。
        // 卸载后必须跳过 setError，否则会对已销毁组件写 state，并可能污染下一个实例。
        onError: (message) => {
          if (mountedRef.current) setError(message);
        },
      });
      // [事务] 先写 ref 再写 state：ref 供卸载清理与回调里的 id 比对，state 只负责触发订阅 effect。
      // 顺序不能反，因为订阅要等渲染后才建立，期间到达的回调只能依赖 ref。
      // onCompleted 里用 job.id 与这个 ref 比对，丢弃用户已切到另一个后台任务后到达的迟到回调，
      // 否则新任务的提交结果会被旧任务的回调覆盖，用户点开的工单可能不是刚提交的那条。
      activeSubmissionJobRef.current = job;
      if (mountedRef.current) {
        setSubmissionJob(job);
      }
      // [并发] 这里不 await：UI 已由订阅驱动进度，await 只会让 handleSubmit 挂到任务结束。
      // 必须吞掉任务的拒绝：失败已由 onError 呈现，未捕获的拒绝会冒泡成 unhandledrejection。
      // finally 里再按 job.id 比对，防止旧任务结束时把新任务的 submitting 误置为 false。
      // 同理，卸载后（mountedRef 为 false）不再写 state。
      void job.done
        .catch(() => undefined)
        .finally(() => {
          if (mountedRef.current && activeSubmissionJobRef.current?.id === job.id) {
            setSubmitting(false);
          }
        });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
      setSubmitting(false);
    }
  }, [
    contact,
    description,
    feedbackService,
    formatMessage,
    includeLogs,
    locale,
    modelContext,
    onCancel,
    onSubmitted,
    screenshots,
    submissionCopy,
    ticketModule,
    ticketSeverity,
    ticketType,
  ]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-popover text-foreground"
      onPaste={handleFormPaste}
    >
      <ScrollFadeViewport className="px-6 pb-4 pt-3">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          <DescriptionSection
            value={description}
            max={DESCRIPTION_MAX}
            onChange={setDescription}
            formatMessage={formatMessage}
          />
          <Section
            title={formatMessage("feedback.submit.simple.screenshotTitle")}
            right={
              <span className="text-ui-xs tabular-nums text-foreground-subtle">
                {screenshots.length}/{MAX_SCREENSHOT_ATTACHMENTS}
              </span>
            }
          >
            <FeedbackScreenshotPicker
              screenshots={screenshots}
              screenshotHint={formatMessage("feedback.submit.simple.screenshotHint")}
              screenshotPrivacyHint={formatMessage("feedback.submit.simple.screenshotPrivacyHint")}
              addScreenshotLabel={formatMessage("feedback.submit.addScreenshot")}
              removeScreenshotLabel={formatMessage("feedback.submit.removeScreenshot")}
              onChange={setScreenshots}
              onAddFiles={(files) => {
                void appendScreenshotFiles(files);
              }}
            />
          </Section>
          <ContactSection
            value={contact}
            max={CONTACT_MAX}
            onChange={setContact}
            formatMessage={formatMessage}
          />
          <LogUploadToggle
            checked={includeLogs}
            onCheckedChange={setIncludeLogs}
            label={formatMessage("feedback.submit.simple.logsLabel")}
            hint={formatMessage("feedback.submit.simple.logsHint")}
          />
          {error ? <FeedbackErrorTip message={error} /> : null}
        </div>
      </ScrollFadeViewport>
      <SubmitFooter
        submitting={submitting}
        submitProgress={submitProgress}
        submitDisabled={submitting || !description.trim()}
        onViewTickets={onViewTickets}
        onCancel={handleCancel}
        onSubmit={handleSubmit}
        formatMessage={formatMessage}
      />
    </div>
  );
}

// 用 ownerDocument.defaultView 上的构造器做 instanceof 判断，而不是全局 HTMLInputElement：
// 表单可能被渲染进别的 document（弹窗、嵌入预览），全局构造器在那时会判错类型。
// 取不到 defaultView 时保守返回 false，即允许接管粘贴，避免环境异常吞掉用户操作。
function isTextInputFocused(ownerDocument: Document) {
  const activeElement = ownerDocument.activeElement;
  const view = ownerDocument.defaultView;
  if (!activeElement || !view) return false;
  return (
    activeElement instanceof view.HTMLInputElement ||
    activeElement instanceof view.HTMLTextAreaElement
  );
}

// 只订阅当前工作区路径与身份；selector 返回 null 时不触发无谓重渲染。
// 模型上下文依赖 configOptions 的引用变化，useMemo 保证同一份配置不重复解析。
// 该 hook 是提交载荷的模型来源，改成读全局 store 会把其他工作区的模型写进反馈。
function useActiveFeedbackModelContext(): FeedbackAgentModelContext {
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const workspaceZCodeState = useZCodeSessionStore((state) =>
    activeWorkspacePath
      ? selectWorkspaceZCodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
      : null,
  );
  return useMemo(
    () => readCurrentAgentModelContext(workspaceZCodeState?.configOptions),
    [workspaceZCodeState?.configOptions],
  );
}
