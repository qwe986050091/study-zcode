// INV-01 类型枚举覆盖四类：守住位置 FeedbackTicketType；改错故障 后端新增类型被拒。
// INV-02 状态枚举覆盖九态：守住位置 FeedbackTicketStatus；改错故障 状态显示回退为未知。
// INV-03 模块枚举与下拉一致：守住位置 FeedbackTicketModule；改错故障 选项与校验不一致。
// INV-04 空字符串用哨兵替代：守住位置 FEEDBACK_FRAMEWORK_NONE；改错故障 Radix Select 抛错。
// INV-05 提交前转回未指定：守住位置 选择值类型；改错故障 后端收到 none。
// INV-06 采集字段全部可选：守住位置 FeedbackDeviceInfo；改错故障 缺字段构造失败。
// INV-07 描述必填标题必填：守住位置 CreateFeedbackTicketInput；改错故障 空工单入库。
// INV-08 语言仅走请求头：守住位置 locale 注释；改错故障 中文标识写入正文。
// INV-09 摘要不含正文：守住位置 FeedbackTicketSummary；改错故障 列表响应体积翻倍。
// INV-10 未读与活动时间可选：守住位置 unread 与 last_user_activity_at；改错故障 旧后端解析失败。
// INV-11 事件载荷可选：守住位置 payload；改错故障 缺载荷事件被丢弃。
// INV-12 附件含脱敏标志：守住位置 redacted；改错故障 前端误展示敏感内容。
// INV-13 评论附件与工单附件分离：守住位置 两个附件类型；改错故障 字段混用。
// INV-14 详情继承摘要：守住位置 extends；改错故障 字段重复定义漂移。
// INV-15 列表查询分页可选：守住位置 FeedbackListQuery；改错故障 默认全量拉取。
// INV-16 模块顺序与后端一致：守住位置 FEEDBACK_TICKET_MODULES；改错故障 下拉顺序漂移。
// INV-17 类型值文案成对：守住位置 FEEDBACK_TICKET_TYPES；改错故障 表单渲染错位。
// INV-18 含未指定的完整列表单独导出：守住位置 FEEDBACK_TICKET_FRAMEWORKS；改错故障 管理端缺选项。
//
// 模块职责：声明反馈工单的类型、状态、模块、请求体与响应结构。
// 状态所有权：纯类型与常量，不持有运行状态。
// 阅读顺序：先看三个枚举，再看请求与响应结构，最后看常量表。
export type FeedbackTicketType = "bug" | "usage" | "feature" | "performance";

export type FeedbackTicketStatus =
  | "已提交"
  | "信息不足"
  | "已采纳"
  | "答复关闭"
  | "已归档"
  | "已拒绝"
  | "开发中"
  | "已解决"
  | "已上线";

export type FeedbackAttachmentKind = "log" | "image" | "other";

export type FeedbackTicketModule =
  | "Plugin / MCP"
  | "Agent任务执行失败"
  | "模型配置 / API Key"
  | "模型调用报错"
  | "权限 / 配置保存"
  | "SSH连接失败"
  | "WSL连接失败"
  | "UI布局 / 交互"
  | "模型响应慢 / 额度"
  | "崩溃 / Internal Error"
  | "文档 / 使用咨询"
  | "其它";

export type FeedbackTicketFramework = "zcode-agent";

/**
 * UI 层 Select 不允许空字符串作为可选项 value（Radix 会抛错），
 * 这里给『未指定』提供一个 sentinel；提交工单前会被转换成 undefined。
 */
export const FEEDBACK_FRAMEWORK_NONE = "none" as const;
export type FeedbackTicketFrameworkSelectValue =
  | FeedbackTicketFramework
  | typeof FEEDBACK_FRAMEWORK_NONE;

export type FeedbackTicketSeverity = "P1-高" | "P2-中" | "P3-低";

export interface FeedbackReporter {
  user_id?: string;
  username?: string;
  display_name?: string;
}

// FeedbackDeviceInfo 的所有字段可选：旧客户端可能只上报 appVersion 与 osPlatform。
// agentModelDisplay 缺失时回退到 agentModel，界面不展示空串。
// buildTime 记录构建时刻，osRelease/osVersion 记录运行环境，两类字段由不同来源采集。
export interface FeedbackDeviceInfo {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronVersion?: string;
  nodeVersion?: string;
  osType?: string;
  osPlatform?: string;
  osRelease?: string;
  osVersion?: string;
  osArch?: string;
  /** 提交反馈时的当前 Agent。单 ZCode Agent 模式下固定为 ZCode Agent。 */
  agentProvider?: string;
  /** 提交反馈时归一到反馈平台的框架标识，当前固定为 zcode-agent。 */
  agentFramework?: FeedbackTicketFramework;
  /** 提交反馈时当前模型配置里的原始选中值。 */
  agentModel?: string;
  /** 提交反馈时从模型列表匹配到的展示名；没有时回退到 agentModel。 */
  agentModelDisplay?: string;
  /** 提交反馈时当前模型列表的可选项数量。 */
  agentModelOptionCount?: number;
  /** 提交反馈时当前模型列表的展示名预览，用于排查配置上下文。 */
  agentModelOptionsPreview?: string[];
  hostname?: string;
  deviceMid?: string;
}

// title 与 description 必填，type 决定工单分类，severity/module 由调用方按需补充。
// reporter 与 device 可选；contact 为空时后端按匿名反馈处理。
// locale 只用于请求头透传，不写入后端工单正文。
export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  framework?: FeedbackTicketFramework;
  source?: string;
  reporter?: FeedbackReporter;
  device?: FeedbackDeviceInfo;
  /** 用户选填的联系方式（邮箱或其他社交账号），后端不强制要求。 */
  contact?: string;
  /** 当前界面语言，仅用于请求头透传，不写入后端工单正文。 */
  locale?: "zh-CN" | "en-US";
}

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  status: FeedbackTicketStatus;
  assignee_id?: string | null;
  /** 当前处理人的展示名（由后端填充）；未指派为 null */
  assignee_display?: string | null;
  /** 后端返回的报告人展示名 */
  reporter_display?: string | null;
  /** 自上次查看以来是否有新动作 */
  unread?: boolean;
  /** 最近一次用户动作时间 */
  last_user_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackTicketEventType =
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "staff_replied"
  | "user_replied";

export interface FeedbackTicketEvent {
  id: number;
  type: FeedbackTicketEventType;
  summary: string;
  actor_display_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackAttachment {
  id: number;
  kind: FeedbackAttachmentKind;
  filename: string;
  size: number;
  sha256?: string | null;
  redacted: boolean;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at: string;
}

export interface FeedbackCommentAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
}

export interface FeedbackComment {
  id: number;
  /** 后端 message_id，用于补充消息创建后继续把附件绑定到该 message。 */
  message_id?: string;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  attachments?: FeedbackCommentAttachment[];
  is_staff: boolean;
  created_at: string;
}

// FeedbackTicketDetail 复用 FeedbackTicketSummary 的列表字段，不重复声明。
// description 只在详情返回，列表接口不携带正文。
// attachments 与 comments 分开声明：附件随工单，评论带 is_staff 与 created_at。
export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  framework?: FeedbackTicketFramework;
  reporter?: FeedbackReporter | null;
  device?: FeedbackDeviceInfo | null;
  attachments: FeedbackAttachment[];
  comments: FeedbackComment[];
  events: FeedbackTicketEvent[];
  lark_record_id?: string | null;
}

export interface FeedbackListQuery {
  mine?: boolean;
  status?: FeedbackTicketStatus;
  type?: FeedbackTicketType;
  offset?: number;
  limit?: number;
}

export interface FeedbackListResult {
  items: FeedbackTicketSummary[];
  total: number;
}

// FEEDBACK_TICKET_MODULES 的顺序与后端枚举一致，前端不自行重排。
// 列表覆盖插件、Agent、模型、权限、SSH、WSL、UI、崩溃等全部模块。
// FEEDBACK_TICKET_MODULES 供下拉选项与提交校验共用，避免两处文案分叉。
// 新增模块必须同步 FeedbackTicketModule 联合类型，否则类型检查失败。
export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [
  "Plugin / MCP",
  "Agent任务执行失败",
  "模型配置 / API Key",
  "模型调用报错",
  "权限 / 配置保存",
  "SSH连接失败",
  "WSL连接失败",
  "UI布局 / 交互",
  "模型响应慢 / 额度",
  "崩溃 / Internal Error",
  "文档 / 使用咨询",
  "其它",
];

// FEEDBACK_TICKET_TYPES 每项由 value 与 label 成对组成，value 参与提交。
// 数组顺序固定为 bug/usage/feature/performance，下拉按此顺序渲染。
// FEEDBACK_TICKET_TYPES 直接驱动表单渲染，不再维护第二份文案表。
export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [
  { value: "bug", label: "Bug 反馈" },
  { value: "usage", label: "使用问题" },
  { value: "feature", label: "功能建议" },
  { value: "performance", label: "性能问题" },
];

export const FEEDBACK_TICKET_SEVERITIES: FeedbackTicketSeverity[] = ["P1-高", "P2-中", "P3-低"];

export const DEFAULT_FEEDBACK_TICKET_FRAMEWORK: FeedbackTicketFramework = "zcode-agent";

export const FEEDBACK_TICKET_FRAMEWORK_OPTIONS: {
  value: FeedbackTicketFramework;
  label: string;
}[] = [{ value: "zcode-agent", label: "ZCode Agent" }];

/** 含「未指定」的完整列表，供管理端等场景使用。 */
export const FEEDBACK_TICKET_FRAMEWORKS: {
  value: FeedbackTicketFrameworkSelectValue;
  label: string;
}[] = [{ value: FEEDBACK_FRAMEWORK_NONE, label: "未指定" }, ...FEEDBACK_TICKET_FRAMEWORK_OPTIONS];
