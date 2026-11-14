// INV-01 描述是唯一必填：守住位置 参数类型；改错故障 空描述生成空工单。
// INV-02 标题缺省由描述派生：守住位置 空值合并；改错故障 列表出现无标题条目。
// INV-03 三档分类各有默认：守住位置 导出常量；改错故障 调用方漏传导致分类为空。
// INV-04 联系偏好与提交解耦：守住位置 持久化调用位置；改错故障 存储失败阻断提交。
// INV-05 联系人为空不写字段：守住位置 条件展开；改错故障 出现空字符串联系人。
// INV-06 截图只保留数据字段：守住位置 解构剔除本地标识；改错故障 本地句柄随工单外泄。
// INV-07 草稿保留原始输入：守住位置 草稿对象；改错故障 回看时看到被改写的内容。
// INV-08 设备快照只读一次：守住位置 提交前读取；改错故障 两次读取出现版本不一致。
// INV-09 智能体标识与框架必填：守住位置 设备字段合并；改错故障 工单无法归因到产品。
// INV-10 模型显示名可选：守住位置 条件展开；改错故障 出现未定义显示名。
// INV-11 来源固定为桌面应用：守住位置 常量字段；改错故障 统计口径混入其他端。
// INV-12 语言跟随调用方：守住位置 入参透传；改错故障 工单语言与界面不一致。
// INV-13 面向开发的正文由纯函数构建：守住位置 构建调用；改错故障 正文拼接散落在组件。
// INV-14 提交返回任务句柄：守住位置 返回类型；改错故障 调用方误以为已完成。
// INV-15 票据标识回调可选：守住位置 参数声明；改错故障 调用方被迫实现空函数。
// INV-16 完成与失败回调必填：守住位置 参数声明；改错故障 任务结果无人接收。
// INV-17 默认值集中导出：守住位置 顶部常量；改错故障 各入口默认值漂移。
// INV-18 本模块不触碰界面状态：守住位置 无 store 引用；改错故障 提交逻辑与界面耦合。
//
// 模块职责：把简化反馈表单的输入整理成工单并启动提交任务。
// 状态所有权：无状态；设备快照与联系偏好都是一次性读取。
// 阅读顺序：先看默认常量，再看输入归一，最后看工单组装与任务启动。
import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type FeedbackTicketModule,
  type FeedbackTicketSeverity,
  type FeedbackTicketType,
} from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { persistFeedbackContactPreference } from "@/feedback/feedbackContactPreference.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import type { ScreenshotAttachmentDraft } from "@/feedback/FeedbackScreenshotPicker.js";
import {
  buildDeveloperFacingDescription,
  buildFeedbackTitle,
} from "@/feedback/feedbackSubmitDescription.js";
import type { FeedbackAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";
import {
  startFeedbackSubmissionJob,
  type FeedbackSubmissionCopy,
  type FeedbackSubmissionJob,
} from "@/feedback/feedbackSubmissionJob.js";

const FEEDBACK_ZCODE_AGENT_LABEL = "ZCode Agent";

export const DEFAULT_FEEDBACK_TYPE: FeedbackTicketType = "bug";
export const DEFAULT_FEEDBACK_SEVERITY: FeedbackTicketSeverity = "P2-中";
export const DEFAULT_FEEDBACK_MODULE: FeedbackTicketModule = "其它";

// startSimplifiedFeedbackSubmission() 直接解构入参，调用方不必拼对象。
// description 必填，title 可以为空。
// persistFeedbackContactPreference() 与提交互不阻塞。
// ticketType/ticketSeverity/ticketModule 三档都有默认值。
// 返回 FeedbackSubmissionJob 句柄，不是完成后的票据。
export async function startSimplifiedFeedbackSubmission({
  feedbackService,
  title,
  description,
  contact,
  screenshots,
  includeLogs,
  ticketType,
  ticketSeverity,
  ticketModule,
  modelContext,
  locale,
  copy,
  formatMessage,
  onTicketCreated,
  onCompleted,
  onError,
}: {
  feedbackService: IFeedbackService;
  title?: string;
  description: string;
  contact: string;
  screenshots: ScreenshotAttachmentDraft[];
  includeLogs: boolean;
  ticketType: FeedbackTicketType;
  ticketSeverity: FeedbackTicketSeverity;
  ticketModule: FeedbackTicketModule;
  modelContext: FeedbackAgentModelContext;
  locale: "zh-CN" | "en-US";
  copy: FeedbackSubmissionCopy;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
  onTicketCreated?: (ticketId: string) => void;
  onCompleted: (ticketId: string) => void;
  onError: (message: string) => void;
}): Promise<FeedbackSubmissionJob> {
  // getDeviceSnapshot() 在提交前一次性读取。
  // normalizedDescription 与 trimmedContact 都先 trim。
  // 截图映射时用 { id: _id, ...screenshot } 丢掉本地 id。
  // formDraft.description 保留原始输入便于回看。
  const device = await feedbackService.getDeviceSnapshot();
  const framework = DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
  const normalizedDescription = description.trim();
  const trimmedContact = contact.trim();
  persistFeedbackContactPreference(trimmedContact);
  const attachmentDrafts = screenshots.map(({ id: _id, ...screenshot }) => ({ ...screenshot }));
  const formDraft: FeedbackSubmitDraft = {
    ...(title !== undefined ? { title } : {}),
    description,
    contact,
    screenshots: attachmentDrafts,
    includeLogs,
    type: ticketType,
    severity: ticketSeverity,
    module: ticketModule,
  };
  // title 为空时由 buildFeedbackTitle() 取描述首段。
  // buildDeveloperFacingDescription() 接收 modelContext。
  // device 里补 agentProvider 与 agentFramework。
  // modelContext.model 缺失时不写 agentModel 字段。
  return startFeedbackSubmissionJob({
    feedbackService,
    ticketInput: {
      title: buildFeedbackTitle(title ?? normalizedDescription, formatMessage),
      description: buildDeveloperFacingDescription({
        raw: normalizedDescription,
        modelContext,
        ticketType,
        ticketModule,
        ticketSeverity,
        formatMessage,
      }),
      type: ticketType,
      severity: ticketSeverity,
      module: ticketModule,
      framework,
      device: {
        ...device,
        agentProvider: FEEDBACK_ZCODE_AGENT_LABEL,
        agentFramework: framework,
        ...(modelContext.model ? { agentModel: modelContext.model } : {}),
        ...(modelContext.display ? { agentModelDisplay: modelContext.display } : {}),
      },
      source: "desktop-app",
      contact: trimmedContact || undefined,
      locale,
    },
    screenshots: attachmentDrafts,
    includeLogs,
    formDraft,
    copy,
    onTicketCreated,
    onCompleted,
    onError,
  });
}
