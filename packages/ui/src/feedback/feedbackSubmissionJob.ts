/* eslint-disable max-lines -- 反馈后台提交状态机集中维护创建、截图、日志上传、取消和降级逻辑；本次修 413/fetch 回归，不拆文件避免扩大行为面。 */
// 反馈后台提交 job：create 工单、上传截图、上传完整日志、取消与清理的唯一编排者；边界是只依赖 IFeedbackService 与 logger，不渲染界面、不读 store、不碰 window。
//
// INV-01 断言：一次启动只创建一个 job、只发一次创建请求 —— 守住它的位置：startFeedbackSubmissionJob 内序号自增与直接调用执行体 —— 改错故障：同一份表单落两张工单，用户看到重复反馈。
// INV-02 断言：jobId 与创建幂等号由同一时间戳与序号派生 —— 守住它的位置：jobId 与 createOperationId 的构造处 —— 改错故障：host 侧幂等去重失效，重发即多一张工单。
// INV-03 断言：job 必须先写入全局注册表再广播 —— 守住它的位置：submissionJobs.set 与紧随的通知调用 —— 改错故障：卡片收到通知却查不到 job，提交在后台变成幽灵任务。
// INV-04 断言：暂停等待中的 job 不可被 dismiss —— 守住它的位置：dismissFeedbackSubmissionJob 首行状态闸门 —— 改错故障：等待永不唤醒，日志压缩包与进度订阅一起泄漏。
// INV-05 断言：取消以本地取消标记为准，不以后端返回值为准 —— 守住它的位置：创建返回后、写状态之前的判断 —— 改错故障：用户点过取消，几秒后界面又冒出工单与截图上传。
// INV-06 断言：工单号一旦写入状态就不得回退为空 —— 守住它的位置：创建成功后的状态写入 —— 改错故障：后续失败被当成尚未创建，引导用户重复提交。
// INV-07 断言：同一时刻只有一个活跃上传进度标识 —— 守住它的位置：该变量的赋值与三处清空 —— 改错故障：暂停按钮取消错传输，进度互相覆盖。
// INV-08 断言：单张截图失败不阻断日志上传与最终成功 —— 守住它的位置：失败清单与逐张上传的捕获 —— 改错故障：一张超限截图让整次提交失败，而工单其实已建成。
// INV-09 断言：完整日志的非取消错误必须原样抛出 —— 守住它的位置：上传循环里取消错误的判断分支 —— 改错故障：断网或超限被吞掉后仍显示提交成功，研发只拿到缺日志的工单。
// INV-10 断言：只有上传被取消才进入暂停态并等待用户动作 —— 守住它的位置：上传异常捕获里的状态切换 —— 改错故障：网络错误被误当暂停，界面卡在一个永不到来的点击上。
// INV-11 断言：日志压缩包清理必须无条件执行 —— 守住它的位置：日志函数末尾的 finally —— 改错故障：准备成功而上传失败的路径在用户机器上残留压缩包。
// INV-12 断言：进度订阅必须与压缩包同批释放 —— 守住它的位置：同一个 finally —— 改错故障：每次重试叠加一个监听者，进度回调次数越滚越多。
// INV-13 断言：状态只能经统一写入函数修改 —— 守住它的位置：闭包内的状态变量重赋值 —— 改错故障：绕过广播直接改状态，订阅者与全局快照永久停在旧值。
// INV-14 断言：表单快照在启动时同步复制并冻结 —— 守住它的位置：快照构造函数 —— 改错故障：并发反馈共享同一份内容，后提交的覆盖前者的恢复结果。
// INV-15 断言：取消提示只发一次 —— 守住它的位置：取消标记函数首行的提前返回 —— 改错故障：取消失败回滚后再取消，用户连续收到两条已取消。
// INV-16 断言：错误文案映射只做展示替换，原始消息原样进日志 —— 守住它的位置：错误映射函数与告警日志字段 —— 改错故障：关键词被覆盖后无法再区分代理失败与后端错误。
//
// 维护提示：下面每条「看起来该改」的注释都对应一次真实回归，改前先读故障后果。
import type { CreateFeedbackTicketInput, FeedbackAttachmentKind } from "@zcode/shared";
import type { FeedbackUploadProgress, IFeedbackService } from "@zcode/services";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export interface FeedbackSubmissionAttachmentDraft {
  filename: string;
  contentType: string;
  dataBase64: string;
  size: number;
}

export interface FeedbackSubmissionProgressState {
  kind?: "working" | "uploading-log" | "paused-log" | "success";
  label: string;
  detail?: string;
  progress?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  indeterminate?: boolean;
}

// [契约] 所有面向用户的文案都从这份结构注入，组件不允许自带兜底字符串。
// [权衡] 字段看着多且重复，但每条对应一个状态机分支，按用途命名才能保证换文案时不串行。
// [失败路径] 缺字段时整份回退默认对象，不做逐字段合并，避免出现半截英文半截中文。
export interface FeedbackSubmissionCopy {
  connectingLabel: string;
  connectingDetail: string;
  cancelingCreateLabel: string;
  cancelingCreateDetail: string;
  canceledLabel: string;
  canceledDetail: string;
  uploadingScreenshotLabel: string;
  submittedLabel: string;
  submittedDetail: string;
  failedLabel: string;
  networkErrorDetail: string;
  postCreateNetworkErrorDetail: string;
  pausingLogLabel: string;
  pausingLogDetail: string;
  exportingLogLabel: string;
  exportingLogDetail: string;
  uploadingLogLabel: string;
  logUploadSuccessLabel: string;
  logUploadPausedLabel: string;
  logUploadPausedDetail: string;
  preparingUploadDetail: string;
}

// [契约] 四种状态里只有暂停态能回到运行态，其余三种都是终态。
// [失败路径] 从失败态再回运行态会让已经通知过的失败卡片复活，任何重试都必须新建 job。
export type FeedbackSubmissionJobStatus = "running" | "paused-log" | "success" | "error";

export interface FeedbackSubmissionJobState {
  id: string;
  status: FeedbackSubmissionJobStatus;
  progress: FeedbackSubmissionProgressState;
  ticketId?: string;
  error?: string;
}

export interface FeedbackSubmissionJob {
  readonly id: string;
  /** 提交瞬间的用户表单快照，用于按 jobId 重新打开对应反馈。 */
  readonly formDraft: FeedbackSubmitDraft;
  // [契约] 这是这次提交唯一的完成信号，成功与取消都用它收口。
  // [并发] 它由执行体在启动时同步产出，调用方只能等它，不能再触发第二次执行。
  // [失败路径] 取消以失败形式表达，等待方必须按取消错误与真实故障分别处理。
  readonly done: Promise<{ ticketId: string }>;
  getState: () => FeedbackSubmissionJobState;
  subscribe: (listener: (state: FeedbackSubmissionJobState) => void) => { dispose: () => void };
  cancelSubmission: () => Promise<void>;
  cancelActiveUpload: () => Promise<void>;
  continueLogUpload: () => void;
}

export interface FeedbackSubmissionJobSnapshot extends FeedbackSubmissionJobState {
  job: FeedbackSubmissionJob;
}

export interface StartFeedbackSubmissionJobOptions {
  feedbackService: IFeedbackService;
  ticketInput: CreateFeedbackTicketInput;
  screenshots: FeedbackSubmissionAttachmentDraft[];
  includeLogs: boolean;
  formDraft: FeedbackSubmitDraft;
  copy?: FeedbackSubmissionCopy;
  onTicketCreated?: (ticketId: string) => void;
  onCompleted?: (ticketId: string) => void;
  onError?: (message: string) => void;
}

type LogUploadAction = "continue";

// [契约] 默认文案只维护这一份，测试与组件共用，避免出现第二套中文措辞。
// [权衡] 文案里写明不要重复提交、请继续上传日志，这是排障流程的一部分，不是装饰。
// [失败路径] 改措辞会直接改变用户决策，属于产品行为变更，不能当注释级重构顺手改。
const DEFAULT_SUBMISSION_COPY: FeedbackSubmissionCopy = {
  connectingLabel: "正在连接反馈服务",
  connectingDetail: "创建成功后会继续上传截图和日志",
  cancelingCreateLabel: "正在取消提交",
  cancelingCreateDetail: "已收到取消请求，正在停止创建反馈。",
  canceledLabel: "反馈提交已取消",
  canceledDetail: "反馈提交已取消",
  uploadingScreenshotLabel: "正在上传截图",
  submittedLabel: "反馈已提交",
  submittedDetail: "我们会尽快处理。",
  failedLabel: "反馈提交失败",
  networkErrorDetail: "无法连接反馈服务，请检查网络、VPN 或代理设置后重试。",
  postCreateNetworkErrorDetail:
    "反馈已创建，但后续材料上传失败。请打开已创建的反馈补充材料，不要重复提交。",
  pausingLogLabel: "正在暂停日志上传",
  pausingLogDetail: "已收到取消请求，稍等一下。",
  exportingLogLabel: "正在导出完整日志",
  exportingLogDetail: "会根据本机日志大小耗时数秒",
  uploadingLogLabel: "正在上传完整日志",
  logUploadSuccessLabel: "日志上传成功",
  logUploadPausedLabel: "已暂停日志上传",
  logUploadPausedDetail: "日志是定位问题的必需材料，请继续上传。",
  preparingUploadDetail: "准备上传",
};

// [并发] 模块级单调计数器，只在启动 job 时同步自增。
// [契约] job 标识的可读序号来自它，日志检索与排查都依赖序号不重复。
// [权衡] 它不持久化，进程重启后从零开始，所以标识里必须同时带时间戳。
let nextJobSeq = 0;
// [事务] 全局唯一注册表，全局卡片与提交弹窗都从这里取快照。
// [资源] 条目只由显式关闭删除，订阅者退订不会回收：卡片与弹窗各订各的，退订不代表任务结束。
// [并发] 所有读写都在主线程同步完成，不要改成异步存储，否则快照会读到中间态。
const submissionJobs = new Map<string, FeedbackSubmissionJob>();
const globalListeners = new Set<(jobs: FeedbackSubmissionJobSnapshot[]) => void>();

function getSubmissionJobSnapshots(): FeedbackSubmissionJobSnapshot[] {
  // [契约] 快照每次调用都重新拼装，不缓存不记忆，保证状态与实例来自同一时刻。
  // [并发] 遍历时不允许在回调里改注册表，否则会漏条目或多出条目。
  return Array.from(submissionJobs.values()).map((job) => ({
    ...job.getState(),
    job,
  }));
}

// [并发] 先取一次快照再遍历，避免每个监听器各取一份、看到不同版本。
// [契约] 监听器抛错会中断后续通知，订阅方要自己保证回调不抛。
function notifySubmissionJobSnapshots() {
  const snapshot = getSubmissionJobSnapshots();
  for (const listener of globalListeners) {
    listener(snapshot);
  }
}

export function getFeedbackSubmissionJobsSnapshot(): FeedbackSubmissionJobSnapshot[] {
  return getSubmissionJobSnapshots();
}

// [契约] 订阅时立即回调一次当前快照，订阅者不必额外拉一次初始状态。
// [资源] 退订只移除监听器，不删除 job，也不取消任何后台任务。
// [并发] subscribeFeedbackSubmissionJobs 先把 listener 加进 globalListeners 再回调一次，之后才随广播收到增量通知。
export function subscribeFeedbackSubmissionJobs(
  listener: (jobs: FeedbackSubmissionJobSnapshot[]) => void,
): { dispose: () => void } {
  globalListeners.add(listener);
  listener(getSubmissionJobSnapshots());
  return {
    dispose: () => {
      globalListeners.delete(listener);
    },
  };
}

// [契约] dismissFeedbackSubmissionJob 只从 submissionJobs 移除展示项，不调用 cancelUpload 也不改作业状态。
// [失败路径] 没有真正删除时不广播，避免订阅者收到一次毫无变化的通知。
export function dismissFeedbackSubmissionJob(jobId: string): void {
  const job = submissionJobs.get(jobId);
  // paused-log 正在等待用户继续上传。此时如果把 job 从全局队列删除，
  // waitForLogUploadAction 会永久悬挂，日志压缩包清理和最终状态都不会再推进。
  if (job?.getState().status === "paused-log") {
    return;
  }
  if (submissionJobs.delete(jobId)) {
    notifySubmissionJobSnapshots();
  }
}

export function getFeedbackSubmissionJob(jobId: string): FeedbackSubmissionJob | null {
  return submissionJobs.get(jobId) ?? null;
}

// [契约] 只处理尚未拿到工单号的运行中 job，其余情况一律返回假。
// [失败路径] 取消创建是跨 RPC 的 host 命令，失败不能按成功处理，更不能顺手隐藏后台 job。
// [并发] 用户可能连点，提示去重交给 job 内的取消闸门，这里不重复加锁。
// [权衡] 返回布尔值而不是抛错，让上层菜单决定是否提示，抛错会把取消失败升级成整页错误。
export async function cancelFeedbackCreateSubmissionJob(
  job: FeedbackSubmissionJob,
  options: { onCancelError?: (message: string) => void } = {},
): Promise<boolean> {
  const state = job.getState();
  if (state.status !== "running" || state.ticketId) {
    return false;
  }
  try {
    await job.cancelSubmission();
    dismissFeedbackSubmissionJob(job.id);
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    // cancelCreate 是跨 RPC 的 host 命令，host 断开或调用失败时不能把
    // fire-and-forget rejection 漏到全局，也不能按成功取消把后台 job 隐藏掉。
    logger.warn("[FeedbackSubmissionJob] 取消反馈创建命令失败", {
      jobId: job.id,
      error: message,
    });
    options.onCancelError?.(message);
    return false;
  }
}

// [契约] 每次调用都创建一个全新 job，没有按表单内容复用的路径。
// [并发] 同一份表单连提两次会得到两个 job，这是刻意的：改完描述再提交不能被旧任务吞掉。
// [失败路径] 函数本身不抛错，所有失败都通过完成信号的失败与回调上报。
export function startFeedbackSubmissionJob(
  options: StartFeedbackSubmissionJobOptions,
): FeedbackSubmissionJob {
  const copy = options.copy ?? DEFAULT_SUBMISSION_COPY;
  // [并发] 序号必须在任何异步等待之前取到，保证并发启动的两个 job 一定拿到不同序号。
  // [契约] job 标识与创建幂等号由同一序号派生，二者对同一次提交恒等对应。
  // [失败路径] 取值挪到异步之后，同一毫秒内的两次提交会撞号，日志与工单再也对不上。
  const jobSeq = nextJobSeq++;
  const now = Date.now();
  const jobId = `feedback-submit-${now}-${jobSeq}`;
  const createOperationId = `feedback-create-${now}-${jobSeq}`;
  // 后端工单描述已经混入诊断信息，无法用于恢复用户原始输入。
  // 每个后台 job 必须在启动时复制自己的表单快照，避免多个并发反馈互相覆盖。
  // [事务] 表单快照在启动瞬间同步拍下，之后用户再编辑描述或附件都不影响本次提交。
  // [并发] 每个 job 持有独立快照，是这个模块能同时跑多个反馈的前提。
  // [失败路径] 直接保存入参对象会让多个 job 共享同一份内容，恢复出错误的反馈。
  const formDraft = createFeedbackSubmitDraftSnapshot(options.formDraft);
  const listeners = new Set<(state: FeedbackSubmissionJobState) => void>();
  let state: FeedbackSubmissionJobState = {
    id: jobId,
    status: "running",
    progress: {
      kind: "working",
      label: copy.connectingLabel,
      detail: copy.connectingDetail,
      indeterminate: true,
    },
  };
  // [并发] 同一时刻只允许一个活跃上传进度标识，日志阶段会覆盖截图阶段的占位值。
  // [契约] 暂停上传只认这个标识，为空时必须直接返回，不能凭空发取消命令。
  // [资源] activeUploadProgressId 必须在结束、暂停、异常三条路上清回 null，否则取消命令会打到旧通道。
  // [失败路径] 残留旧标识的表现是静默无效而不是报错，所以三个清理点缺一不可。
  let activeUploadProgressId: string | null = null;
  let resolveLogUploadAction: ((action: LogUploadAction) => void) | null = null;
  let cancelRequested = false;
  let cancelNotified = false;

  // [事务] job 状态的唯一写入口，同时通知本地监听器与全局快照。
  // [契约] 这里是浅合并，进度这类嵌套对象必须整份替换，不能指望深度合并。
  // [并发] 同步循环通知，不要改成微任务或异步，否则订阅顺序会变。
  function setState(patch: Partial<FeedbackSubmissionJobState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
    notifySubmissionJobSnapshots();
  }

  function setProgress(progress: FeedbackSubmissionProgressState) {
    setState({ progress });
  }

  // [契约] 取消提示最多出现一次，无论取消被触发几次、回滚几次。
  // [失败路径] 取消创建失败恢复进度后用户再点取消，仍要走到这里，但提示不能重复。
  // [事务] 状态写成失败而不是成功：取消是终态，不能让完成信号看起来像提交成功。
  function markCreateCanceled() {
    if (cancelNotified) return;
    cancelNotified = true;
    setState({
      status: "error",
      error: copy.canceledDetail,
      progress: {
        kind: "working",
        label: copy.canceledLabel,
        detail: copy.canceledDetail,
        indeterminate: false,
      },
    });
    options.onError?.(copy.canceledDetail);
  }

  // [契约] 这次 job 的唯一执行体，只执行一次，没有外层重试循环。
  // [失败路径] 需要重试的只有日志上传，重试收在日志函数内部，不要在这里加循环。
  async function run(): Promise<{ ticketId: string }> {
    try {
      logger.info("[FeedbackSubmissionJob] 开始后台提交反馈", { jobId });
      // [事务] 创建请求带幂等号交给 host 去重，同一次提交即使重发也只应落一张工单。
      // [契约] 幂等号必须与 job 同源，不能每次重试重新生成，否则幂等语义失效。
      // [失败路径] 这里抛出的网络错误会走统一映射，界面上给的是可执行的排查提示。
      const ticket = await options.feedbackService.create(options.ticketInput, {
        operationId: createOperationId,
      });
      // [契约] 取消标记优先于后端返回值：用户点过取消，即使工单已建也不再继续。
      // [失败路径] 顺序反过来先看工单再判取消，会让取消后仍传出截图与日志。
      if (cancelRequested) {
        // 取消创建以用户点击为准；即使后端稍后返回 ticket，
        // 也不恢复旧提交 job 或继续上传附件，避免用户认为取消后还在后台运行。
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      // [事务] 写入工单号是整条链路的分水岭：之前的失败按没建成处理，之后按已建但材料没传完处理。
      // [契约] 这里显式清空错误，否则取消后重试时旧错误文案会残留在卡片上。
      // [失败路径] 一旦写入工单号，后续任何分支都不允许再把它改回空。
      setState({ status: "running", ticketId: ticket.id, error: undefined });
      // 工单创建成功后前台弹窗可以收起；截图和日志继续由后台 job 负责上传。
      options.onTicketCreated?.(ticket.id);

      // [权衡] 截图逐张上传、逐张吞掉错误：一张失败不该拖垮其余截图和后面的日志。
      // [失败路径] 失败清单只用于汇报，不参与决定 job 最终状态。
      const failedScreenshots: string[] = [];
      for (const [index, screenshot] of options.screenshots.entries()) {
        try {
          setProgress({
            kind: "working",
            label: copy.uploadingScreenshotLabel,
            detail: `${index + 1}/${options.screenshots.length} · ${formatBytes(screenshot.size)}`,
            indeterminate: true,
          });
          await options.feedbackService.uploadAttachmentData(ticket.id, "image", {
            dataBase64: screenshot.dataBase64,
            filename: screenshot.filename,
            contentType: screenshot.contentType,
          });
        } catch (screenshotError) {
          failedScreenshots.push(`${screenshot.filename}: ${getErrorMessage(screenshotError)}`);
        }
      }

      // [失败路径] 部分截图失败通过工单评论告知后端，评论自身的错误再单独吞掉，避免二次失败放大。
      // [契约] 这条评论是研发侧唯一的失败线索，必须带文件名与原因。
      if (failedScreenshots.length > 0) {
        await options.feedbackService
          .comment(ticket.id, `系统提示：部分截图上传失败：${failedScreenshots.join("；")}`)
          .catch(() => undefined);
      }

      // [事务] 日志在截图之后串行上传，不能与截图并发，两条流会抢同一个进度通道。
      // [契约] 不开日志时直接收尾到成功态，job 仍要给出完整可展示状态。
      if (options.includeLogs) {
        await uploadLogsUntilComplete(options.feedbackService, ticket.id, copy, {
          setState,
          setProgress,
          getActiveProgressId: () => activeUploadProgressId,
          setActiveProgressId: (id) => {
            activeUploadProgressId = id;
          },
          waitForLogUploadAction: () =>
            new Promise<LogUploadAction>((resolve) => {
              resolveLogUploadAction = resolve;
            }),
        });
      }

      setState({
        status: "success",
        ticketId: ticket.id,
        progress: {
          kind: "success",
          label: copy.submittedLabel,
          detail: copy.submittedDetail,
          progress: 100,
        },
      });
      options.onCompleted?.(ticket.id);
      logger.info("[FeedbackSubmissionJob] 后台反馈提交完成", {
        jobId,
        ticketId: ticket.id,
      });
      return { ticketId: ticket.id };
    } catch (error) {
      if (
        !state.ticketId &&
        (cancelRequested || error instanceof FeedbackSubmissionCanceledError)
      ) {
        markCreateCanceled();
        logger.info("[FeedbackSubmissionJob] 反馈提交已取消", { jobId });
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      // [失败路径] RPC 只把网络错误的顶层消息带回界面，底层建连原因到这里已经丢失。
      // [契约] 原始消息必须原样进日志，展示层只做关键词替换，不能反写日志字段。
      // [权衡] 映射只认整串网络特征，宁可漏判保留原文，也不要编造一个笼统错误。
      // [失败路径] 是否已建工单决定文案走检查网络还是去补充材料，判错会诱导用户重复提交。
      const rawMessage = getErrorMessage(error);
      // RPC 只把 Node fetch 的顶层消息带到 UI，底层建连错误会退化成 fetch failed。
      // 用户需要可执行的网络排查提示，原始错误仍保留在日志中供定位。
      const message = getFeedbackSubmissionErrorMessage(rawMessage, copy, {
        ticketCreated: Boolean(state.ticketId),
      });
      setState({
        status: "error",
        error: message,
        progress: {
          kind: "working",
          label: copy.failedLabel,
          detail: message,
          indeterminate: false,
        },
      });
      options.onError?.(message);
      logger.warn("[FeedbackSubmissionJob] 后台反馈提交失败", {
        jobId,
        error: rawMessage,
        displayError: message,
      });
      throw error;
    } finally {
      activeUploadProgressId = null;
      resolveLogUploadAction = null;
    }
  }

  // [并发] 这里同步调用执行体，job 还没返回给调用方就已经在跑，不要改成延迟启动。
  // [契约] 完成信号必须在构造 job 对象之前拿到，对外暴露的与这次执行是同一个。
  // [失败路径] 改成微任务启动会让首帧以空状态渲染，取消按钮在那一刻点不到任何东西。
  const done = run();
  // 反馈日志上传是 host service 里的长耗时任务，不能被提交弹窗卸载牵着走。
  // job 保存在模块闭包里继续执行，前台组件只订阅状态；右上角关闭弹窗只会移除订阅者，不会取消后台上传。
  const job: FeedbackSubmissionJob = {
    id: jobId,
    formDraft,
    done,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    // [契约] 只请求 host 取消当前上传，并把进度改成正在暂停，不直接改 job 状态。
    // [失败路径] 暂停真正生效要等上传侧抛取消错误，再由上传循环切到暂停态。
    // [并发] 没有活跃标识时静默返回，避免对已经结束的传输发取消命令。
    cancelActiveUpload: async () => {
      const progressId = activeUploadProgressId;
      if (!progressId) return;
      setProgress({
        kind: "working",
        label: copy.pausingLogLabel,
        detail: copy.pausingLogDetail,
        indeterminate: true,
      });
      await options.feedbackService.cancelUpload(progressId);
    },
    // [契约] 两个分支互斥：没有工单号走取消创建，已有工单号只暂停日志上传。
    // [事务] 取消标记先置位再发命令，host 响应慢时本地也不会继续推进流程。
    // [失败路径] 取消创建失败要把进度恢复成取消前的样子，否则界面停在一个不会前进的正在取消。
    // [权衡] 已有 ticketId 时只能调 cancelUpload 停止上传，工单已落库无法删除。
    cancelSubmission: async () => {
      if (state.status !== "running" && state.status !== "paused-log") return;
      cancelRequested = true;
      if (!state.ticketId) {
        const previousProgress = state.progress;
        setProgress({
          kind: "working",
          label: copy.cancelingCreateLabel,
          detail: copy.cancelingCreateDetail,
          indeterminate: true,
        });
        try {
          await options.feedbackService.cancelCreate(createOperationId);
        } catch (error) {
          if (!cancelNotified && !state.ticketId) {
            setProgress(previousProgress);
          }
          throw error;
        }
        markCreateCanceled();
        return;
      }
      await job.cancelActiveUpload();
    },
    // [契约] 只有暂停态的等待会被这次调用唤醒，其他时候没有可唤醒的回调。
    // [资源] 唤醒后立刻清空回调，防止重复点击对同一个等待二次结算。
    continueLogUpload: () => {
      resolveLogUploadAction?.("continue");
      resolveLogUploadAction = null;
    },
  };
  // [事务] 先写注册表再广播，保证监听器收到通知时一定能按标识取到这个 job。
  // [并发] 顺序反过来会出现通知里有一个查不到的 job。
  submissionJobs.set(job.id, job);
  notifySubmissionJobSnapshots();
  return job;
}

// [事务] 浅层深拷贝：截图数组与每个截图对象都换新，再整体冻结。
// [契约] 冻结是为了让全局卡片与弹窗共享同一份只读内容，任何一方改写都会立刻暴露。
// [失败路径] 省略冻结不会报错，但一次误改会让之后恢复出的反馈丢掉附件。
function createFeedbackSubmitDraftSnapshot(draft: FeedbackSubmitDraft): FeedbackSubmitDraft {
  const screenshots = draft.screenshots
    ? Object.freeze(draft.screenshots.map((screenshot) => Object.freeze({ ...screenshot })))
    : undefined;
  // job 暴露给全局卡片和弹窗共同读取，必须冻结复制后的快照，
  // 防止任一订阅者改写描述或附件后污染同一后台任务的恢复内容。
  return Object.freeze({
    ...draft,
    ...(screenshots ? { screenshots } : {}),
  });
}

// [契约] 纯函数，只依赖入参与文案表，不读模块状态，便于单独覆盖各分支。
// [失败路径] 只匹配整串网络特征，不做包含匹配，避免把业务错误误判成断网。
// [权衡] 超时与建连失败各有一条规则，这三种是线上真实退化成同一句错误的形态。
function getFeedbackSubmissionErrorMessage(
  rawMessage: string,
  copy: FeedbackSubmissionCopy,
  options: { ticketCreated: boolean },
): string {
  if (
    /^(?:fetch failed|failed to fetch|network request failed)$/i.test(rawMessage) ||
    /^request timed out after \d+ms$/i.test(rawMessage) ||
    /connect timeout error/i.test(rawMessage)
  ) {
    return options.ticketCreated ? copy.postCreateNetworkErrorDetail : copy.networkErrorDetail;
  }
  return rawMessage;
}

// [契约] 取消用独立错误类型表达，调用方才能把用户取消与提交失败分开。
// [失败路径] 改成普通错误加文案比较，任何文案调整都会让取消分支失效。
class FeedbackSubmissionCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackSubmissionCanceledError";
  }
}

// [事务] uploadLogsUntilComplete 先 prepareCompactLogArchive 打包，再循环上传，被取消时转 paused-log 等用户继续。
// [契约] 只有取消能触发循环重试，其他错误一律向上抛给 job 统一处理。
// [资源] 压缩包与进度订阅的生命周期都用 finally 兜住，成功失败取消三条路一致。
async function uploadLogsUntilComplete(
  feedbackService: IFeedbackService,
  ticketId: string,
  copy: FeedbackSubmissionCopy,
  callbacks: {
    setState: (patch: Partial<FeedbackSubmissionJobState>) => void;
    setProgress: (progress: FeedbackSubmissionProgressState) => void;
    getActiveProgressId: () => string | null;
    setActiveProgressId: (id: string | null) => void;
    waitForLogUploadAction: () => Promise<LogUploadAction>;
  },
): Promise<void> {
  let archive: { path: string; size: number } | null = null;
  // [契约] 每次日志上传新建进度标识，避免与上一次取消残留的通道串线。
  // [并发] 它同时用于进度订阅与上传调用，两处必须传同一个值。
  // [失败路径] 若按工单号复用，重试时旧订阅仍会收到新上传的事件。
  const progressId = `feedback-log-${ticketId}-${Date.now()}`;
  // 完整日志需要先在本机压缩成 zip，只显示不确定进度会让用户误以为导出已经瞬间完成。
  // [资源] 订阅必须在准备压缩之前建立，否则压缩阶段的进度会整段丢失。
  // [契约] 回调只负责把进度格式化成展示状态，不参与状态机判断。
  // [失败路径] 建订阅本身不抛错，但漏掉释放会让每次重试多一个监听者。
  const progressSubscription = feedbackService.onDynamicUploadProgress(progressId)((progress) => {
    callbacks.setProgress(formatUploadProgress(progress, copy));
  });
  try {
    callbacks.setActiveProgressId(progressId);
    callbacks.setProgress({
      kind: "working",
      label: copy.exportingLogLabel,
      detail: copy.exportingLogDetail,
      indeterminate: true,
    });
    // [事务] 先拿到压缩包再赋给外层变量，finally 靠它决定是否需要清理。
    // [契约] 必须是完整日志：它是排障必需材料，不能退化成精简日志。
    archive = await feedbackService.prepareCompactLogArchive({ full: true, progressId });
    // [并发] shouldRetryLogUpload 只在收到 FeedbackSubmissionCanceledError 时保持为真，其他错误直接抛出结束循环。
    // [契约] 每轮重试都要重设上传进度，不能沿用上一轮的百分比。
    // [失败路径] 把非取消错误也算可重试，会让资源超限的请求无休止重发。
    let shouldRetryLogUpload = true;
    while (shouldRetryLogUpload) {
      try {
        callbacks.setActiveProgressId(progressId);
        callbacks.setProgress({
          kind: "uploading-log",
          label: copy.uploadingLogLabel,
          detail: `0 / ${formatBytes(archive.size)}`,
          progress: 0,
          uploadedBytes: 0,
          totalBytes: archive.size,
        });
        await feedbackService.uploadAttachmentWithProgress(
          ticketId,
          "log" satisfies FeedbackAttachmentKind,
          {
            path: archive.path,
            contentType: "application/zip",
          },
          progressId,
        );
        shouldRetryLogUpload = false;
        callbacks.setProgress({
          kind: "success",
          label: copy.logUploadSuccessLabel,
          detail: copy.submittedDetail,
          progress: 100,
          uploadedBytes: archive.size,
          totalBytes: archive.size,
        });
      } catch (logUploadError) {
        // [失败路径] 非取消错误必须原样抛出，由上层写评论并让整个 job 失败。
        // [权衡] 不能降级成精简日志继续报成功，否则研发会以为拿到了完整现场。
        // [契约] 判定只看错误名不看文案，跨包传递时文案会变而类型不会。
        if (!isUploadCanceledError(logUploadError)) {
          // 完整日志是排障必需附件，413/断网等自动上传失败不能降级成 compact 日志并继续成功。
          // 否则研发侧会误以为拿到了完整现场，实际关键日志已经被客户端跳过。
          throw logUploadError;
        }
        callbacks.setActiveProgressId(null);
        callbacks.setState({
          status: "paused-log",
          progress: {
            kind: "paused-log",
            label: copy.logUploadPausedLabel,
            detail: copy.logUploadPausedDetail,
            progress: 0,
            uploadedBytes: 0,
            totalBytes: archive.size,
          },
        });
        // [资源] 这里挂起整个上传循环，界面上的继续上传是唯一出口。
        // [失败路径] 挂起期间 job 不能被关闭，否则这个等待永远不会被唤醒。
        // [并发] 重复进入会在同一 job 上排两个等待，状态机会卡在暂停态。
        await callbacks.waitForLogUploadAction();
        callbacks.setState({ status: "running" });
        shouldRetryLogUpload = true;
      } finally {
        callbacks.setActiveProgressId(null);
      }
    }
  // [失败路径] 先把失败写进工单评论再向上抛，保证后端留下痕迹。
  // [契约] 评论失败不能覆盖原始错误，所以这里单独吞掉评论的异常。
  // [权衡] 这段文案是给用户的操作指引，不能删掉只留日志。
  } catch (logError) {
    const message = getErrorMessage(logError);
    await feedbackService
      .comment(
        ticketId,
        `系统提示：完整日志自动上传失败，请必要时让用户手动导出日志。错误：${message}`,
      )
      .catch(() => undefined);
    // 日志上传是提交链路的一部分，非用户主动跳过时不能吞掉异常继续显示“提交成功”。
    // 否则用户会以为完整日志已经交付，但研发侧实际只收到缺日志的工单。
    throw logError;
  } finally {
    // [资源] 清理压缩包放 finally，成功、失败、取消都要执行。
    // [契约] 清理失败不再抛错，否则会掩盖真正的上传错误。
    // [失败路径] 漏掉清理会在用户机器上堆积压缩包，且没有其他路径能回收。
    if (archive) {
      await feedbackService.cleanupPreparedLogArchive(archive.path).catch(() => undefined);
    }
    callbacks.setActiveProgressId(null);
    progressSubscription.dispose();
  }
}

// [契约] 纯展示换算，只按 1024 进制输出，不处理负数也不做本地化。
// [权衡] 精度随量级变化，小文件给一位小数、大文件给两位，够读即可。
export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

// [契约] 纯函数：进度对象进、展示状态出，不读 job 状态也不发通知。
// [失败路径] 准备阶段的文案与上传阶段不同，混用会让用户以为已经开始传输。
// [权衡] 完成态复用成功文案，避免日志传完后还要再等一次状态切换。
export function formatUploadProgress(
  progress: FeedbackUploadProgress,
  copy: FeedbackSubmissionCopy = DEFAULT_SUBMISSION_COPY,
): FeedbackSubmissionProgressState {
  const totalBytes = Math.max(progress.totalBytes, 0);
  const uploadedBytes = Math.min(Math.max(progress.uploadedBytes, 0), totalBytes);
  // [契约] 百分比按夹紧后的字节数算，先防负值再防超出总量。
  // [失败路径] 总量为零时直接给零，避免除零得到非法值让进度条整条消失。
  const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
  if (progress.phase === "preparing") {
    return {
      kind: "working",
      label: copy.exportingLogLabel,
      detail:
        totalBytes > 0
          ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
          : copy.exportingLogDetail,
      progress: percent,
      uploadedBytes,
      totalBytes,
    };
  }
  return {
    kind: progress.phase === "complete" ? "success" : "uploading-log",
    label: progress.phase === "complete" ? copy.logUploadSuccessLabel : copy.uploadingLogLabel,
    detail:
      totalBytes > 0
        ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
        : copy.preparingUploadDetail,
    progress: percent,
    uploadedBytes,
    totalBytes,
  };
}

// [契约] 取消错误来自服务包，这里只按错误名识别，跨包实例判断会失效。
// [权衡] 只有上传层会抛这个名字，其他错误即使文案含取消也不能算取消。
function isUploadCanceledError(error: unknown): boolean {
  return error instanceof Error && error.name === "FeedbackUploadCanceledError";
}
