// INV-01 状态提示固定九种：守住位置 映射表；改错故障 新状态显示空白。
// INV-02 文案走消息标识：守住位置 标识表；改错故障 中文硬编码进组件。
// INV-03 两表键集合一致：守住位置 同类型记录；改错故障 某状态取不到键。
// INV-04 非法时间为空串：守住位置 非数判断；改错故障 显示无效日期。
// INV-05 一分钟内显示刚刚：守住位置 首档判断；改错故障 刚提交显示零分钟前。
// INV-06 逐档放大单位：守住位置 常量换算；改错故障 小时档按分钟计。
// INV-07 七天外退日期：守住位置 末档回退；改错故障 久远反馈显示超大天数。
// INV-08 提交时间基于相对值：守住位置 嵌套调用；改错故障 两处格式不一致。
// INV-09 相对值为空则整体为空：守住位置 早退判断；改错故障 只剩前缀的残缺文案。
// INV-10 系统评论前缀固定：守住位置 前缀常量；改错故障 内部提示混进用户列表。
// INV-11 前缀比较忽略前导空白：守住位置 左侧裁剪；改错故障 缩进的系统提示漏过滤。
// INV-12 用户描述优先原文：守住位置 原文分支；改错故障 原文被结构化字段覆盖。
// INV-13 原文缺失退问题概述：守住位置 第二分支；改错故障 只剩空描述。
// INV-14 结构化描述不外泄：守住位置 兜底判断；改错故障 内部整理模板直接展示。
// INV-15 纯空描述返回空：守住位置 裁剪判断；改错故障 组件渲染空白块。
// INV-16 章节按固定标题切分：守住位置 标题集合；改错故障 用户正文被误当标题。
// INV-17 首个标题前内容归内容区：守住位置 兜底分区；改错故障 开头正文丢失。
// INV-18 空内容区按标题保留：守住位置 过滤条件；改错故障 空章节被整段删除。
//
// 模块职责：反馈工单的状态文案、时间展示与描述评论的展示层过滤。
// 状态所有权：无状态；工单与格式化函数由调用方提供。
// 阅读顺序：先看状态映射，再读时间格式，最后看描述解析与评论过滤。
import type { FeedbackComment, FeedbackTicketStatus } from "@zcode/shared";

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

const TOP_DESCRIPTION_SECTIONS = new Set([
  "结构化反馈",
  "开发复现信息",
  "用户原始描述",
]);
const REPRO_DESCRIPTION_SECTIONS = new Set([
  "问题概述",
  "复现步骤",
  "期望结果",
  "实际结果",
  "报错信息",
  "补充线索",
]);

const SYSTEM_COMMENT_PREFIX = "系统提示：";

export const STATUS_USER_HINT: Record<FeedbackTicketStatus, string> = {
  已提交: "我们已收到，会尽快处理。",
  信息不足: "还需要你补充一点信息，请看下方官方回复。",
  已采纳: "你的反馈已被采纳，我们会安排修复或改进。",
  答复关闭: "产品经理已回复并关闭此反馈，如仍有问题可以重新提交。",
  已归档: "产品经理已回复并关闭此反馈，如仍有问题可以重新提交。",
  已拒绝: "这条反馈暂未纳入处理，如有疑问可看下方说明。",
  开发中: "正在处理中，有进展会通过下方回复同步。",
  已解决: "问题已经处理完成，正在等待版本上线。",
  已上线: "相关修复或改进已上线，感谢你的反馈。",
};

export const STATUS_USER_HINT_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  已提交: "feedback.statusHint.pendingReview",
  信息不足: "feedback.statusHint.needInfo",
  已采纳: "feedback.statusHint.accepted",
  答复关闭: "feedback.statusHint.closedByReply",
  已归档: "feedback.statusHint.archived",
  已拒绝: "feedback.statusHint.rejected",
  开发中: "feedback.statusHint.inDevelopment",
  已解决: "feedback.statusHint.resolved",
  已上线: "feedback.statusHint.released",
};

// formatFeedbackStatusHint 用 STATUS_USER_HINT_MESSAGE_IDS[status] 查标识。
// 文案由调用方注入的 formatMessage 格式化。
// status 受 FeedbackTicketStatus 类型约束兜底。
// 不拼接前缀也不缓存结果，直接返回 formatMessage 输出。
// 每次调用都跟随最新 locale，不在模块级缓存文案。
export function formatFeedbackStatusHint(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: STATUS_USER_HINT_MESSAGE_IDS[status] });
}

// Number.isNaN(ts) 时 formatRelativeTime 直接返回空串。
// offset 依次落在 minute / hour / day 三档换算。
// Math.floor 向下取整，避免提前进位。
// diff 小于 7 * day 时仍用相对表达。
// 超过七天退回 toLocaleDateString 的本地日期。
export function formatRelativeTime(iso: string, formatMessage: MessageFormatter) {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return formatMessage({ id: "feedback.time.justNow" });
  if (diff < hour) {
    return formatMessage(
      { id: "feedback.time.minutesAgo" },
      { count: String(Math.floor(diff / minute)) },
    );
  }
  if (diff < day) {
    return formatMessage(
      { id: "feedback.time.hoursAgo" },
      { count: String(Math.floor(diff / hour)) },
    );
  }
  if (diff < 7 * day) {
    return formatMessage(
      { id: "feedback.time.daysAgo" },
      { count: String(Math.floor(diff / day)) },
    );
  }
  return new Date(iso).toLocaleDateString();
}

export function formatSubmittedAt(iso: string, formatMessage: MessageFormatter) {
  const relative = formatRelativeTime(iso, formatMessage);
  if (!relative) return "";
  return formatMessage({ id: "feedback.time.submittedAt" }, { time: relative });
}

function isSystemComment(body: string) {
  return body.trimStart().startsWith(SYSTEM_COMMENT_PREFIX);
}

export function filterUserVisibleComments(comments: FeedbackComment[]) {
  return comments.filter((item) => !isSystemComment(item.body));
}

// parsed.raw 存在时优先返回其 trim 结果。
// 其次取 parsed.reproOverview 的问题概述。
// looksLikeStructuredTicketDescription 命中的模板不外露。
// trimmed 为空时直接返回空串。
// 普通描述经 trim 后原样返回。
export function getUserFacingDescription(description: string) {
  const parsed = parseTicketDescription(description);
  if (parsed.raw) return parsed.raw.trim();
  if (parsed.reproOverview) return parsed.reproOverview.trim();
  const trimmed = description.trim();
  if (!trimmed || looksLikeStructuredTicketDescription(trimmed)) {
    return "";
  }
  return trimmed;
}

function parseTicketDescription(description: string) {
  const topSections = splitSections(description, TOP_DESCRIPTION_SECTIONS);
  const reproBody =
    topSections.find((item) => item.title === "开发复现信息")?.body ?? null;
  const reproOverview = reproBody
    ? splitSections(reproBody, REPRO_DESCRIPTION_SECTIONS).find(
        (item) => item.title === "问题概述",
      )?.body ?? null
    : null;
  return {
    raw: topSections.find((item) => item.title === "用户原始描述")?.body ?? null,
    reproOverview,
  };
}

function looksLikeStructuredTicketDescription(description: string) {
  return (
    description.includes("结构化反馈") ||
    description.includes("开发复现信息") ||
    description.includes("整理方式:")
  );
}

// headings.has(title) 命中时才开新段。
// 首个标题前的内容归入 title 为 "内容" 的段。
// 段内 body 保留原始换行，不重新排版。
// 空段在 title 非 "内容" 时保留，不因 body 为空丢弃。
// 输出对每段 body 做 trim 后拼接。
function splitSections(raw: string, headings: Set<string>) {
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const title = line.trim();
    if (headings.has(title)) {
      if (current) sections.push(current);
      current = { title, lines: [] };
      continue;
    }
    if (!current) current = { title: "内容", lines: [] };
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections
    .map((section) => ({ title: section.title, body: section.lines.join("\n").trim() }))
    .filter((section) => section.body || section.title !== "内容");
}
