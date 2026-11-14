// ============================================================
// Session store row codecs
// ============================================================
// 定位：SQLite 行（snake_case + JSON 字符串）与 @zcode/contracts 领域对象的
// 唯一转换边界。仓储层只搬行，读出的协议对象都在这里解包，避免核心层依赖磁盘格式。
// 输入输出：输入是 rows.ts 定义的行类型；输出为 SessionInfo / MessageInfo /
// MessagePart / SessionEntryInfo / TodoItem；缺失字段按 undefined 处理。
// 副作用：无（纯函数），不写库、不改磁盘内容。
// 失败语义：JSON.parse 对损坏 data 会 throw，由仓储/上层处理；枚举值非法时
// 回落到默认值（taskType=interactive、titleSource=first_input），不阻断读取。
// 不变量：旧字段（model/providerID/variant 等平铺字段）在解码时丢弃，只输出
// 新结构；id/sessionID 由行主键回填，绝不让 data 内的值覆盖。

import {
  SESSION_TASK_TYPES,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_TITLE_SOURCES,
  parseModelSelectionValue,
  type CollaborationMode,
  type FileDiff,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type PartId,
  type PermissionRuleset,
  type ProjectId,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type SessionTitleSource,
  type SessionEntryType,
  type TodoItem,
  type TraceId,
  type WorkspaceId,
  type SessionTaskType,
} from "@zcode/contracts";
import { decodeJson } from "./json.js";
import type { MessageRow, PartRow, SessionEntryRow, SessionRow, TodoRow } from "./rows.js";

// 运行时校验协作模式枚举；未知字符串返回 false，调用方应回落默认模式。
export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

// task_type 非法/缺失时回落 interactive：旧库或手工写入不应让整个会话不可读。
function decodeSessionTaskType(value: string | null | undefined): SessionTaskType {
  return SESSION_TASK_TYPES.includes(value as SessionTaskType)
    ? (value as SessionTaskType)
    : "interactive";
}

// title_source 缺失时回落 first_input（历史数据早于该字段）。
function decodeSessionTitleSource(value: string | null | undefined): SessionTitleSource {
  return SESSION_TITLE_SOURCES.includes(value as SessionTitleSource)
    ? (value as SessionTitleSource)
    : "first_input";
}

/**
 * session 行 → SessionInfo。可空列统一映射为 undefined（而非 null），
 * summary_diffs/revert/permission 是 JSON 列，空串/空值解为 undefined。
 * 时间字段聚合成 time{created,updated,titleUpdated,compacting,deleted}。
 */
export function decodeSessionRow(row: SessionRow): SessionInfo {
  return {
    id: row.id as SessionId,
    projectID: row.project_id as ProjectId,
    workspaceID: row.workspace_id ? (row.workspace_id as WorkspaceId) : undefined,
    parentID: row.parent_id ? (row.parent_id as SessionId) : undefined,
    traceID: row.trace_id ? (row.trace_id as TraceId) : undefined,
    taskType: decodeSessionTaskType(row.task_type),
    slug: row.slug,
    directory: row.directory,
    path: row.path ?? undefined,
    title: row.title,
    lastOutcome: row.last_outcome ?? undefined,
    titleSource: decodeSessionTitleSource(row.title_source),
    titleMessageID: row.title_message_id ? (row.title_message_id as MessageId) : undefined,
    version: row.version,
    shareURL: row.share_url ?? undefined,
    summaryAdditions: row.summary_additions ?? undefined,
    summaryDeletions: row.summary_deletions ?? undefined,
    summaryFiles: row.summary_files ?? undefined,
    summaryDiffs: decodeJson<FileDiff[]>(row.summary_diffs),
    revert: decodeJson<SessionRevert>(row.revert),
    permission: decodeJson<PermissionRuleset>(row.permission),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      titleUpdated: row.time_title_updated ?? undefined,
      compacting: row.time_compacting ?? undefined,
      deleted: row.time_deleted ?? undefined,
    },
  };
}

/**
 * message 行 → MessageInfo：data 列存整条消息 JSON，解包后强制回填
 * 行主键 id/sessionID，保证磁盘 data 与索引列不一致时以列值为准。
 */
export function decodeMessageRow(row: MessageRow): MessageInfo {
  return {
    ...decodeStoredMessage(JSON.parse(row.data) as unknown),
    id: row.id as MessageId,
    sessionID: row.session_id as SessionId,
  } as MessageInfo;
}

// 按 role 剥离历史平铺字段并重建 modelSelection；未知 role 原样返回。
// 这是为了兼容迁移前/回滚后的混合数据，不改变磁盘内容（读时投影）。
function decodeStoredMessage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.role === "user") {
    const { model: _legacyModel, modelSelection: rawSelection, ...message } = value;
    // 迁移无法确定身份时可能留下 null；回滚后也可能缺字段。不能让配置残缺阻断整条消息的协议读取。
    // 这里只校验新结构，不查执行资格、不回读旧快照，磁盘内容保持不变。
    const modelSelection = parseModelSelectionValue(rawSelection);
    return { ...message, ...(modelSelection ? { modelSelection } : {}) };
  }
  if (value.role === "assistant") {
    const {
      providerID: _legacyProviderId,
      modelID: _legacyModelId,
      variant: _legacyReasoningLevel,
      ...message
    } = value;
    return message;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// part 行 → MessagePart：同样强制用行主键覆盖 data 内的 id/sessionID/messageID，
// 确保 part 的父子归属与数据库索引一致。
export function decodePartRow(row: PartRow): MessagePart {
  return {
    ...decodeStoredPart(JSON.parse(row.data) as unknown),
    id: row.id as PartId,
    sessionID: row.session_id as SessionId,
    messageID: row.message_id as MessageId,
  } as MessagePart;
}

// 两类 part 需要旧字段兼容：timeline(model_change) 与 subtask 的 modelSelection。
function decodeStoredPart(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.type === "timeline" && value.timelineType === "model_change") {
    const {
      fromModel: _oldFrom,
      toModel: _oldTo,
      fromModelSelection,
      toModelSelection,
      ...part
    } = value;
    const fromModel = decodeTimelineSelection(fromModelSelection);
    const toModel = decodeTimelineSelection(toModelSelection);
    return {
      ...part,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
    };
  }
  if (value.type === "subtask") {
    const { model: _oldModel, modelSelection, ...part } = value;
    const model = parseModelSelectionValue(modelSelection);
    return { ...part, ...(model ? { model } : {}) };
  }
  return value;
}

// 校验严格 Selection 后单独保留 label（展示字段不属于 Selection 结构）。
function decodeTimelineSelection(value: unknown) {
  if (!isRecord(value)) return undefined;
  // label 仅是 Timeline 展示信息，不属于严格的 Selection；不能误删合法的带标签历史。
  const { label, ...rawSelection } = value;
  const selection = parseModelSelectionValue(rawSelection);
  return selection ? { ...selection, ...(typeof label === "string" ? { label } : {}) } : undefined;
}

/**
 * session entry 行 → SessionEntryInfo。type=model_selection 时额外解包
 * data.modelSelection；其余 type 原样返回。type 不强校验（允许扩展类型）。
 */
export function decodeSessionEntryRow(row: SessionEntryRow): SessionEntryInfo {
  const rawData = JSON.parse(row.data) as unknown;
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    type: row.type as SessionEntryType | string,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    data:
      row.type === SESSION_ENTRY_MODEL_SELECTION
        ? decodeStoredSessionModelSelection(rawData)
        : rawData,
  };
}

// 模型选择 entry 的解包：只认 value.modelSelection，非法时原样保留（不补旧值）。
function decodeStoredSessionModelSelection(value: unknown): unknown {
  // 旧平铺字段只属于升级入口。新成员即使为空/非法也不能借旧快照补值。
  // 解包在存储边界完成，core/bootstrap/fork 只消费 port 的当前逻辑 Selection。
  if (!isRecord(value)) return undefined;
  return parseModelSelectionValue(value.modelSelection) ?? value.modelSelection;
}

// todo 行 → TodoItem；status/priority 直接 cast（由数据库写入侧保证合法值）。
export function decodeTodoRow(row: TodoRow): TodoItem {
  return {
    content: row.content,
    status: row.status as TodoItem["status"],
    priority: row.priority as TodoItem["priority"],
  };
}

/**
 * part 的创建时间：按 part 类型取不同时间字段（text/reasoning/compaction/
 * timeline/retry 用 time.start 或 time.created，tool 用 state.time.start）。
 * 取不到则回落到 fallback，保证排序键永不为 undefined。
 */
export function partCreatedAt(part: MessagePart, fallback: number): number {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start ?? fallback;
  if (part.type === "compaction") return part.time?.start ?? fallback;
  if (part.type === "timeline") return part.time?.start ?? fallback;
  if (part.type === "tool") {
    if (part.state.status === "running") return part.state.time.start;
    if (part.state.status === "completed" || part.state.status === "error") {
      return part.state.time.start;
    }
  }
  if (part.type === "retry") return part.time.created;
  return fallback;
}
