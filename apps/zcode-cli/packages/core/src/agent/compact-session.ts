import type { CompactBoundaryPayload, MessagePart, MessageWithParts } from "@zcode/contracts";
import { invalidateRuntimeTokenUsage } from "./message-history.js";

// 计算压缩后仍对模型可见的消息列表，是 UI 全量历史与模型输入视图的分界点。
// messages 为按时间正序的全量历史（含 compaction 边界消息）；boundaryIndex 指向本次生效的
// 边界消息下标，等于 length 时 slice 得到空数组，由调用方按空会话处理，不抛错。
// includePreservedSegment 为 true 时，把边界声明的保留组（锚点附近的历史）回插进结果。
// 纯函数：不读磁盘、不发事件、不修改入参；返回新数组，普通元素复用原引用，保留组为克隆。
// 不变量：结果以 boundaryIndex 起的内容为主体，保留组内部保持原始时间序。
export function compactActiveSessionMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
  includePreservedSegment: boolean,
): MessageWithParts[] {
  const activeMessages = messages.slice(boundaryIndex);
  // 关闭保留组回插时直接返回切片，省掉边界解析和两轮全量 id 查找。
  if (!includePreservedSegment) return activeMessages;

  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const preservedMessages = compactPreservedSegmentMessages(messages, boundaryIndex);
  // 没声明保留组，或声明了但消息已不可恢复时，退回纯切片结果，保持压缩前语义。
  if (!boundary?.preservedSegment || preservedMessages.length === 0) {
    return activeMessages;
  }

  const anchorIndex = activeMessages.findIndex(
    (message) => message.info.id === boundary.preservedSegment?.anchorMessageId,
  );
  // 锚点消息可能已被裁剪；退化到边界消息之后插入，保证边界仍是可见区间的第一条。
  const insertIndex = anchorIndex >= 0 ? anchorIndex + 1 : 1;
  return [
    ...activeMessages.slice(0, insertIndex),
    ...preservedMessages,
    ...activeMessages.slice(insertIndex),
  ];
}

// 取回压缩边界声明的保留组原始消息（从 head 到 tail，含两端）。
// 返回新数组；边界缺失、未声明保留组、端点找不到时返回空数组，不抛错。
// 结果只包含通过 isCompactPreservableSessionMessage 的消息，可能短于端点区间长度。
// 纯函数：仅读入参；assistant 元素以克隆形式返回，避免上层改到历史原对象。
export function compactPreservedSegmentMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
): MessageWithParts[] {
  // boundaryIndex 越界属调用方违约；非空断言读取失败时由下面的“无边界”分支返回空数组。
  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const segment = boundary?.preservedSegment;
  if (!segment) return [];

  const headIndex = messages.findIndex((message) => message.info.id === segment.headMessageId);
  const tailIndex = messages.findIndex((message) => message.info.id === segment.tailMessageId);
  // 保留组必须完整落在边界之前；跨边界说明记录损坏，宁可不恢复，也不把摘要前的旧轮灌回模型。
  if (headIndex < 0 || tailIndex < headIndex || tailIndex >= boundaryIndex) {
    return [];
  }

  return messages
    .slice(headIndex, tailIndex + 1)
    .filter(isCompactPreservableSessionMessage)
    .map(cloneCompactPreservedSessionMessage);
}

// 克隆保留组里的 assistant 消息，并把运行时 token 用量标记为失效，避免恢复后沿用旧统计。
// user 消息没有 token 字段，直接返回原引用，避免无意义的对象复制。
function cloneCompactPreservedSessionMessage(message: MessageWithParts): MessageWithParts {
  // 保留组是历史快照；assistant 的 tokens 来自当时运行时，跨 resume 视为不可信需重算。
  if (message.info.role !== "assistant") return message;
  return {
    ...message,
    info: {
      ...message.info,
      tokens: invalidateRuntimeTokenUsage(message.info.tokens),
    },
  };
}

// 提取某条消息携带的压缩边界；正常只有 compaction part 会带 compactBoundary。
// 无边界时返回 undefined，调用方需自行区分「没有压缩」与「边界字段损坏」。
// 同一消息理论上至多一个 compaction part，出现多个时以首个为准，避免选出歧义边界。
export function compactBoundaryFromMessage(
  message: MessageWithParts,
): CompactBoundaryPayload | undefined {
  // 只扫描当前消息自身 parts，不回溯历史，保证查找成本为 O(parts)。
  for (const part of message.parts) {
    if (part.type === "compaction" && part.compactBoundary) {
      return part.compactBoundary;
    }
  }
  return undefined;
}

// 判定一条消息能否进入压缩保留组：只有对模型有意义的 user/assistant 轮才可保留。
// hidden 的 UI timeline 消息、compaction 自身、失败的 assistant 一律排除，false 表示“跳过”而非错误。
// 已选中的回信、任务结果、attachment 不能二次丢弃，否则冷恢复会丢掉模型真正看过的上下文。
// 纯判定，无副作用，不读 metadata 之外的任何状态。
export function isCompactPreservableSessionMessage(message: MessageWithParts): boolean {
  // UI timeline 也使用 assistant role，但不属于模型轮，不能让保留组的起点错位。
  if (message.info.semantics?.providerVisibility === "hidden") return false;
  if (message.parts.some((part) => part.type === "compaction")) {
    return false;
  }
  // synthetic/model-only 只描述输入身份和 UI 可见性；已选中的回信、任务结果和
  // attachment 没有进入 summary，冷恢复不能据此再次丢弃它们。
  if (message.info.role === "assistant" && message.info.error) {
    return false;
  }
  return message.info.role === "user" || message.info.role === "assistant";
}

// 判定 part 是否为「当前生效」的压缩边界：带 compactBoundary，或尚未下发 timelineStatus 的
// compaction part。任一成立即视为边界，避免 timeline 中间态被当成普通历史记录过滤掉。
// 纯判定，无副作用；非 compaction 类型一律 false。
export function isActiveCompactionBoundaryPart(part: MessagePart): boolean {
  return part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus);
}
