import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  ToolPart,
} from "@zcode/contracts";
import {
  parseReadFileStateMetadata,
  type PersistedReadFileStateTool,
} from "../tool/read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../tool/read-file-state.js";
import type { ReadFileStateMap } from "../tool/types.js";
import { activeSessionMessages } from "./session-history-hydrator.js";

// Read/Write/Edit 类工具历史恢复进 readFileState 后的统计汇总，供上层日志与测试断言覆盖面。
// 三个计数互不重叠；只统计“已完成”的 tool part，未完成或失败的调用不计入。
export interface ReadFileStateHydrationResult {
  // 成功写入 readFileState 的 part 数量；同一文件可被多次覆盖，重复恢复也各计一次。
  restoredCount: number;
  // 因是 range Read 而被跳过的数量；跨 resume 不恢复局部窗口，避免把片段当成全文。
  skippedRangeReadCount: number;
  // 因缺结构化 metadata 而无法恢复的 Edit 数量；当前实现只初始化、未递增，字段保留以稳定契约。
  skippedUnreadableEditCount: number;
}

// 已完成工具的 part 收窄：要求 status=completed 且带 output，output 内容不参与恢复判定。
type CompletedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    output: unknown;
    status: "completed";
  };
};

// 冷恢复：扫描 active 历史里的已完成工具调用，重建“agent 已读过哪些文件”的内存态。
// 入参 readFileState 会被原地 clear() 后全量重建，调用方须保证它是当前 session 的唯一 owner。
// 消息先经 activeSessionMessages 过滤（分支裁剪/rewind），且不含压缩保留组，避免旧态被复活。
// 副作用：清空并写入 readFileState（Map）；不读磁盘、不发事件、不写持久化，因此无法“补全”缺失内容。
// 失败语义：单条 part 解析失败只跳过该条，不中断整体；函数本身不抛错，返回计数供上层观测。
// 不变量：恢复出的每条记录都带结构化 mtime/revision/size，能支撑后续 stale guard。
export async function hydrateReadFileStateFromSession(input: {
  branchCutAfterMessageId?: MessageId;
  messages: MessageWithParts[];
  readFileState: ReadFileStateMap;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<ReadFileStateHydrationResult> {
  // 每次恢复都是全量重建，先清空，避免上次 rewind 遗留的条目污染 stale 判定。
  input.readFileState.clear();
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });

  const result: ReadFileStateHydrationResult = {
    restoredCount: 0,
    skippedRangeReadCount: 0,
    skippedUnreadableEditCount: 0,
  };

  for (const message of activeMessages) {
    // 只有 assistant 轮承载工具结果；user 轮即便带 part 也不是 agent 动作，不参与恢复。
    if (message.info.role !== "assistant") continue;

    // 同一 part 可能被重复追加（断流重放），按 id 去重后只保留最后一份。
    for (const part of dedupeParts(message.parts)) {
      if (!isCompletedToolPart(part)) continue;

      if (part.tool === "Read") {
        const restored = restoreReadToolState(input, part, result);
        if (restored) result.restoredCount++;
        continue;
      }

      if (part.tool === "Write") {
        const restored = restoreMetadataToolState(input.readFileState, part, "Write");
        if (restored) result.restoredCount++;
        continue;
      }

      if (part.tool === "Edit") {
        const restored = restoreMetadataToolState(input.readFileState, part, "Edit");
        if (restored) result.restoredCount++;
        continue;
      }

      // 内联草稿：模型亲手写的字节，与 Write 同一条恢复路径。不带 metadata 的 part（saved 拷贝、
      // `path` 提交、沿用的脚本）在 restoreMetadataToolState 里自然落空。
      if (
        part.tool === "CreateWorkflow" ||
        part.tool === "AmendWorkflow" ||
        part.tool === "FillWorkflowHole"
      ) {
        const restored = restoreMetadataToolState(input.readFileState, part, part.tool);
        if (restored) result.restoredCount++;
      }
    }
  }

  return result;
}

// 恢复单条 Read 调用的文件状态；成功返回 true 并写入 readFileState，否则 false 且不写。
// 要求同时满足：调用参数是全文窗口、metadata 工具名匹配、metadata 也是全文窗口。
// range Read 会被计入 skippedRangeReadCount 后跳过；无 metadata 则静默跳过，不计数。
function restoreReadToolState(
  input: {
    readFileState: ReadFileStateMap;
  },
  part: CompletedToolPart,
  result: ReadFileStateHydrationResult,
): boolean {
  const toolInput = asRecord(part.state.input);
  if (!toolInput) return false;
  if (!isHistoricalFullReadWindow(toolInput as HistoricalReadWindow)) {
    // 真正的 range Read 只在同一 runtime 内作为最新水位，跨 resume 不恢复。
    result.skippedRangeReadCount++;
    return false;
  }

  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata) return false;
  if (metadata.tool !== "Read") return false;
  if (!isHistoricalFullReadWindow(metadata)) {
    return false;
  }
  setFullReadState(input.readFileState, metadata.path, metadata.content, {
    // resume 不再从 provider-visible cat-n 文本恢复 Read 状态；只有带
    // mtimeMs/revisionId/sizeBytes 的结构化 metadata 才能支撑后续 stale guard。
    isPartialView: metadata.isPartialView,
    mtimeMs: normalizeReadFileStateMtimeMs(metadata.mtimeMs),
    readAt: new Date(metadata.readAtMs),
    revisionId: metadata.revisionId,
    sizeBytes: metadata.sizeBytes,
    sourceTool: metadata.tool,
  });
  return true;
}

// 按 part 的持久化 metadata 恢复 Write/Edit（及内联草稿类工具）的文件状态。
// metadata 缺失或工具名不匹配时返回 false，不写状态；只恢复成功时落盘的完整快照。
function restoreMetadataToolState(
  readFileState: ReadFileStateMap,
  part: CompletedToolPart,
  expectedTool: PersistedReadFileStateTool,
): boolean {
  const metadata = parseReadFileStateMetadata(part.state.metadata);
  if (!metadata || metadata.tool !== expectedTool) return false;
  if (!isHistoricalFullReadWindow(metadata)) return false;

  // Write/Edit 的历史 tool part 不能在 resume 时读取当前磁盘来“补全”状态；
  // 外部手动保存会被误认证为 agent 已读。这里只恢复成功时持久化的完整快照。
  setFullReadState(readFileState, metadata.path, metadata.content, {
    isPartialView: metadata.isPartialView,
    mtimeMs: normalizeReadFileStateMtimeMs(metadata.mtimeMs),
    readAt: new Date(metadata.readAtMs),
    revisionId: metadata.revisionId,
    sizeBytes: metadata.sizeBytes,
    sourceTool: metadata.tool,
  });
  return true;
}

// 以“整文件”口径写入 readFileState：key 用 offset=1、limit=undefined 生成，正好对应全量窗口。
// sizeBytes 缺失时用 content 的 UTF-8 字节数兜底，保证 stale guard 有可比较的尺寸。
function setFullReadState(
  readFileState: ReadFileStateMap,
  filePath: string,
  content: string,
  metadata: {
    isPartialView?: boolean;
    mtimeMs?: number;
    readAt: Date;
    revisionId?: string;
    sizeBytes?: number;
    sourceTool?: PersistedReadFileStateTool;
  },
): void {
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: metadata.isPartialView ?? false,
    readAt: metadata.readAt,
    sourceTool: metadata.sourceTool,
    revisionId: metadata.revisionId,
    mtimeMs: metadata.mtimeMs,
    sizeBytes: metadata.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  });
}

// Read 调用参数的最小窗口描述；字段缺省语义与工具入参一致（offset 默认按 1 处理）。
interface HistoricalReadWindow {
  limit?: number;
  offset?: number;
}

// 全量读判定：offset 缺省视为 1，且 limit 必须未设置；任一不满足即为 range 读取。
function isHistoricalFullReadWindow({ offset, limit }: HistoricalReadWindow): boolean {
  return (offset ?? 1) <= 1 && limit === undefined;
}

// 按 part.id 去重，保留同一 id 最后一次出现的实例（后写覆盖先写），输出顺序取首次插入位置。
function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

// 收窄为“已完成且带 output”的工具 part；失败、取消、运行中的 part 不参与状态恢复。
function isCompletedToolPart(part: MessagePart): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed" && "output" in part.state;
}

// 把未知值收窄为普通对象（排除 null 与数组），用于读取 tool 入参而不信任其类型。
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
