// INV-01 文本必须以任务通知标签开头：守住位置 前缀判断；改错故障 普通消息被当成通知。
// INV-02 缺少工具调用标识即视为无效：守住位置 空值判断；改错故障 无法与工具结果对齐。
// INV-03 各字段独立读取：守住位置 标签取值；改错故障 缺一项导致整条解析失败。
// INV-04 标签内容做实体解码：守住位置 返回前处理；改错故障 结果里残留转义字符。
// INV-05 只收集用户角色消息：守住位置 角色判断；改错故障 助手回显被重复计入。
// INV-06 同一标识后写覆盖先写：守住位置 映射赋值；改错故障 重试结果保留旧状态。
// INV-07 丢失与失败都映射为失败：守住位置 分支合并；改错故障 中断任务显示为完成。
// INV-08 停止与终止都映射为停止：守住位置 分支合并；改错故障 被停任务显示为完成。
// INV-09 其余状态一律完成：守住位置 兜底返回；改错故障 未知状态让卡片卡住。
// INV-10 无通知时原样返回负载：守住位置 空值判断；改错故障 所有结果都附加空元数据。
// INV-11 元数据逐层补全不覆盖：守住位置 展开顺序；改错故障 既有元数据被清空。
// INV-12 原负载不是记录时按空对象处理：守住位置 类型归一；改错故障 展开原始值抛错。
// INV-13 标签正则按标签名构造：守住位置 拼接方式；改错故障 标签无法匹配。
// INV-14 正则跨行匹配标签内容：守住位置 字符类；改错故障 多行输出被截断。
// INV-15 空白内容视为缺省：守住位置 取值判断；改错故障 通知出现空字符串字段。
// INV-16 实体解码先处理引号：守住位置 替换顺序；改错故障 双重转义还原错误。
// INV-17 解析函数不修改入参：守住位置 纯函数约束；改错故障 调用方文本被改写。
// INV-18 导出的辅助函数保持窄类型：守住位置 返回类型；改错故障 调用方需要再做断言。
//
// 模块职责：后台任务通知文本的解析、聚合与元数据附加。
// 状态所有权：无状态；聚合结果由调用方持有。
// 阅读顺序：先看单条解析，再看批量聚合，最后看状态映射与元数据附加。
import type { ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";
import { textFromZCodeMessageParts } from "./zcode-protocol-legacy-types.js";
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";

export interface ZCodeBackgroundTaskNotificationInfo {
  error?: string;
  outputFile?: string;
  result?: string;
  status?: string;
  summary?: string;
  taskId?: string;
}

// 不含 <task-notification> 前缀的文本直接返回 null。
// tool-use-id 缺失即视为无效通知。
// 各标签经 readTaskNotificationTag 独立读取，互不影响。
// readTaskNotificationTag 返回的标签原文先做实体解码再写入字段。
export function parseZCodeBackgroundTaskNotificationText(
  text: string | undefined,
): { notification: ZCodeBackgroundTaskNotificationInfo; toolUseId: string } | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("<task-notification>")) {
    return null;
  }
  const toolUseId = readTaskNotificationTag(trimmed, "tool-use-id");
  if (!toolUseId) {
    return null;
  }
  return {
    toolUseId,
    notification: {
      error: readTaskNotificationTag(trimmed, "error"),
      outputFile: readTaskNotificationTag(trimmed, "output-file"),
      result: readTaskNotificationTag(trimmed, "result"),
      status: readTaskNotificationTag(trimmed, "status"),
      summary: readTaskNotificationTag(trimmed, "summary"),
      taskId: readTaskNotificationTag(trimmed, "task-id"),
    },
  };
}

// 只扫描 info.role === "user" 的消息。
// 解析失败返回 null 的消息跳过。
// 同一 toolUseId 后写覆盖先写。
export function collectZCodeBackgroundTaskNotificationsByToolUseId(
  messages: readonly ZCodeMessageWithParts[],
): Map<string, ZCodeBackgroundTaskNotificationInfo> {
  const notifications = new Map<string, ZCodeBackgroundTaskNotificationInfo>();
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }
    const parsed = parseZCodeBackgroundTaskNotificationText(
      textFromZCodeMessageParts(message.parts),
    );
    if (!parsed) {
      continue;
    }
    notifications.set(parsed.toolUseId, parsed.notification);
  }
  return notifications;
}

export function zcodeBackgroundTaskNotificationToolUpdateStatus(
  status: string | undefined,
): Extract<
  Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  "completed" | "failed" | "stopped"
> {
  if (status === "failed" || status === "lost") {
    return "failed";
  }
  // task-notification 的 killed/stopped 都表示被停止，不能折成 completed。
  if (status === "stopped" || status === "killed") {
    return "stopped";
  }
  return "completed";
}

// notification 为空时原样返回 raw。
// 元数据经 asPlainRecord 逐层补全，不覆盖已有字段。
// asPlainRecord 对非纯对象负载返回空记录。
export function attachZCodeBackgroundTaskNotificationToRaw(
  raw: unknown,
  notification: ZCodeBackgroundTaskNotificationInfo | undefined,
): unknown {
  if (!notification) {
    return raw;
  }
  const record = asPlainRecord(raw);
  const meta = asPlainRecord(record._meta);
  const zcode = asPlainRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcode,
        taskNotification: notification,
      },
    },
  };
}

function readTaskNotificationTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  const value = match?.[1]?.trim();
  return value ? decodeTaskNotificationXmlText(value) : undefined;
}

function decodeTaskNotificationXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
