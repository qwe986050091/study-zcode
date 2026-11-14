// INV-01 摘要先去首尾空白：守住位置 trim；改错故障 空格导致匹配失败。
// INV-02 只翻译已知系统摘要：守住位置 白名单；改错故障 用户原文被改写。
// INV-03 已知摘要直出文案键：守住位置 映射表；改错故障 同类事件出现多种说法。
// INV-04 状态变更需状态可识别：守住位置 toKnownFeedbackStatus；改错故障 未知状态被当已知。
// INV-05 指派事件只换身份说法：守住位置 正则；改错故障 开发姓名被透出。
// INV-06 匹配失败即原样返回：守住位置 各分支早退；改错故障 未匹配文本被吞掉。
// INV-07 进度更新可带状态：守住位置 复合正则；改错故障 状态与正文混成一串。
// INV-08 标记事件保留正文：守住位置 markedStatus；改错故障 处理结论丢失。
// INV-09 代理提交提取名字：守住位置 agentSubmitted；改错故障 名字与模板硬拼。
// INV-10 已知状态集合来自元数据：守住位置 FEEDBACK_STATUS_MESSAGE_IDS；改错故障 新增状态前端不认。
// INV-11 状态标签统一走格式化：守住位置 formatStatusLabel；改错故障 中英文案混排。
// INV-12 无格式化器时用回退串：守住位置 formatOptionalMessage；改错故障 纯函数抛异常。
// INV-13 回退串与历史中文一致：守住位置 fallback 入参；改错故障 老数据展示错乱。
// INV-14 消息标识集中在一处：守住位置 getKnownSystemSummaryMessageId；改错故障 键散落难维护。
// INV-15 未知摘要一律原样：守住位置 末尾返回；改错故障 猜测性翻译误导用户。
// INV-16 纯函数不读全局状态：守住位置 模块顶层；改错故障 测试依赖运行时。
// INV-17 事件类型只影响个别分支：守住位置 assignee_changed；改错故障 所有事件被同等处理。
// INV-18 状态参数允许为空：守住位置 toKnownFeedbackStatus 入参；改错故障 空值直接抛错。
//
// 模块职责：把反馈工单事件摘要翻译为可国际化的用户文案。
// 状态所有权：纯函数与消息标识映射；无运行时状态。
// 阅读顺序：先看入口函数的四条分支，再看已知摘要表，最后看格式化辅助。
import type { FeedbackTicketEvent, FeedbackTicketStatus } from "@zcode/shared";
import {
  FEEDBACK_STATUS_MESSAGE_IDS,
  formatFeedbackStatusLabel,
} from "@/feedback/feedbackMeta.js";

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

export function getUserFacingEventSummary(
  event: FeedbackTicketEvent,
  formatMessage?: MessageFormatter,
) {
  // normalizedSummary 只对 event.summary 做 trim。
  // 后续所有匹配都基于 normalizedSummary。
  // trim 不改动大小写与标点。
  const normalizedSummary = event.summary.trim();
  // Bugfix: 后端事件摘要会持久化为中文，切到英文后历史数据仍会原样透出。
  // 这里仅翻译已知系统摘要，保留用户/运营手写内容，避免误改真实回复。
  const knownSummary = formatKnownSystemEventSummary(normalizedSummary, formatMessage);
  if (knownSummary) {
    return knownSummary;
  }
  // Bugfix: 用户侧只需要理解「产品经理 / 研发」两个处理身份，不能把具体开发姓名透出。
  if (event.type === "assignee_changed" && /^已交由 .+ 跟进$/.test(normalizedSummary)) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.assignedToDev",
      "已交由研发跟进",
    );
  }
  return event.summary;
}

function formatKnownSystemEventSummary(
  summary: string,
  formatMessage?: MessageFormatter,
) {
  // getKnownSystemSummaryMessageId 命中时直接翻译。
  // 未命中时继续走下面的 pattern 匹配。
  // 两条路径都经 formatOptionalMessage 输出。
  const directMessageId = getKnownSystemSummaryMessageId(summary);
  if (directMessageId) {
    return formatOptionalMessage(formatMessage, directMessageId, summary);
  }

  const statusChanged = summary.match(/^状态更新为「(.+)」$/);
  if (statusChanged) {
    const status = toKnownFeedbackStatus(statusChanged[1]);
    if (!status) return summary;
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.statusChanged",
      `状态更新为「${status}」`,
      { status: formatStatusLabel(status, formatMessage) },
    );
  }

  const agentSubmitted = summary.match(/^(.+) 通过 Agent 提交反馈$/);
  if (agentSubmitted) {
    const name = agentSubmitted[1] ?? "";
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.agentSubmitted",
      summary,
      { name },
    );
  }

  const progressWithStatus = summary.match(/^进度更新（状态→(.+)）：(.+)$/);
  if (progressWithStatus) {
    const status = toKnownFeedbackStatus(progressWithStatus[1]);
    const message = progressWithStatus[2] ?? "";
    if (!status) return formatProgressWithMessage(message, formatMessage);
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.progressUpdatedWithStatus",
      summary,
      { status: formatStatusLabel(status, formatMessage), message },
    );
  }

  const progressWithMessage = summary.match(/^进度更新：(.+)$/);
  if (progressWithMessage) {
    return formatProgressWithMessage(progressWithMessage[1] ?? "", formatMessage);
  }

  const markedStatus = summary.match(/^标记为「(.+)」：(.+)$/);
  if (markedStatus) {
    const status = toKnownFeedbackStatus(markedStatus[1]);
    const message = markedStatus[2] ?? "";
    if (!status) return summary;
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.markedStatus",
      summary,
      { status: formatStatusLabel(status, formatMessage), message },
    );
  }

  return null;
}

// switch 每个 case 对应一条固定摘要。
// 两种日志上传文案共用 fullLogUploaded 键。
// default 分支返回 null，表示未知摘要。
// 新增固定文案在 formatKnownSystemEventSummary 内追加 case。
function getKnownSystemSummaryMessageId(summary: string) {
  switch (summary) {
    case "反馈已提交":
      return "feedback.timeline.event.submitted";
    case "你补充了信息":
      return "feedback.timeline.yourSupplement";
    case "官方回复":
      return "feedback.timeline.officialReply";
    case "处理进度更新":
      return "feedback.timeline.event.progressUpdated";
    case "处理结论":
      return "feedback.timeline.event.conclusion";
    case "完整日志已上传，反馈进入待评估":
    case "完整日志已上传，反馈进入已提交":
      return "feedback.timeline.event.fullLogUploaded";
    default:
      return null;
  }
}

// formatProgressWithMessage 把 message 作为插值参数传入。
// fallback 保持历史中文文案。
// 带 status 与不带 status 两条入口共用本函数。
function formatProgressWithMessage(
  message: string,
  formatMessage?: MessageFormatter,
) {
  return formatOptionalMessage(
    formatMessage,
    "feedback.timeline.event.progressUpdatedWithMessage",
    `进度更新：${message}`,
    { message },
  );
}

function toKnownFeedbackStatus(value: string | undefined): FeedbackTicketStatus | null {
  if (!value) return null;
  return value in FEEDBACK_STATUS_MESSAGE_IDS ? (value as FeedbackTicketStatus) : null;
}

function formatStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage?: MessageFormatter,
) {
  if (!formatMessage) return status;
  return formatFeedbackStatusLabel(status, formatMessage);
}

// 有 formatMessage 时走 formatFeedbackStatusLabel。
// 缺席时返回 status 原值。
// values 原样传给 formatMessage。
// formatOptionalMessage 是纯函数，可独立测试。
function formatOptionalMessage(
  formatMessage: MessageFormatter | undefined,
  id: string,
  fallback: string,
  values?: Record<string, string>,
) {
  return formatMessage ? formatMessage({ id }, values) : fallback;
}
