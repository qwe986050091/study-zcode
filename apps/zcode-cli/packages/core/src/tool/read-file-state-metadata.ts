import { ReadOutputSchema } from "@zcode/contracts";
import { createReadFileStateKey } from "./read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

export const READ_FILE_STATE_METADATA_SCHEMA_VERSION = 1;
// `CreateWorkflow` / `AmendWorkflow` / `FillWorkflowHole`：内联草稿（或 fill 文件）的字节就是模型那次
// 调用的 `script` 入参，与 Write 同理记作完整视图（handlers/workflow-draft-read-state.ts）。
// 注意：写端类型包含 FillWorkflowHole，但 parseReadFileStateMetadata 的
// isPersistedReadFileStateTool 目前未接受该值；若真的持久化了该来源，resume 时会被跳过。
export type PersistedReadFileStateTool =
  | "Read"
  | "Write"
  | "Edit"
  | "CreateWorkflow"
  | "AmendWorkflow"
  | "FillWorkflowHole";

export interface PersistedReadFileStateMetadata {
  /** 持久化格式版本；解析端只接受精确等于 1 的值，升级需显式迁移。 */
  schemaVersion: typeof READ_FILE_STATE_METADATA_SCHEMA_VERSION;
  /** 产生该状态快照的工具来源；决定 resume 时允许恢复到哪类 read-state。 */
  tool: PersistedReadFileStateTool;
  /** 原始路径（未归一化）；解析后仍按当前平台的比较键查表。 */
  path: string;
  /** 成功时看到的完整/窗口内容快照；Edit 用它定位 old_string，resume 用它冒充“已读”。 */
  content: string;
  /** 读取起点（1-based 行号）；缺席表示整文件读取。 */
  offset?: number;
  /** 读取行数上限；缺席表示读到文件末尾。 */
  limit?: number;
  /** true 表示模型只看到部分内容；整文件覆盖写必须额外确认。 */
  isPartialView: boolean;
  /** 快照完成时间（毫秒时间戳）；仅用于排序/诊断，不参与 stale 判定。 */
  readAtMs: number;
  /** adapter 提供的文件 revision；与 mtimeMs 一起构成 stale guard 的 freshness 事实。 */
  revisionId: string;
  /** 快照时的文件修改时间（毫秒）；缺失时整条 metadata 视为不可恢复。 */
  mtimeMs: number;
  /** 快照时的文件大小（字节）；与 mtime 一起检测“内容已变但时间戳精度不足”。 */
  sizeBytes: number;
}

/**
 * 为一次 Read 工具的完成结果生成可持久化的 read-state metadata。
 * 输入：completedAt、原始 output、readFileState、toolInput、toolName。
 * 输出：仅 Read 且输出为 text/file_unchanged 时返回 metadata；其他工具/输出形态
 * 返回 undefined（Write/Edit 走 createReadFileStateMetadataFromEntry）。
 * 查找口径：用 output.filePath + 入参 offset（缺省 1）/limit 定位 Map 条目，
 * readAtMs 取 completedAt（完成时刻），不是 entry.readAt。
 * 失败语义：不抛错，任何 schema 不匹配或条目缺失都返回 undefined；
 * 消费者必须把 undefined 视为“没有可恢复事实”，不能假装已读。
 */
export function createReadFileStateMetadata(input: {
  completedAt: Date;
  output: unknown;
  readFileState?: ReadFileStateMap;
  toolInput: unknown;
  toolName: string;
}): PersistedReadFileStateMetadata | undefined {
  if (input.toolName !== "Read") return undefined;

  // 为什么只认 text/file_unchanged：其他 Read 输出（图片、二进制等）没有可靠文本快照，
  // 持久化后无法作为 Edit 的 old_string 基准，反而会制造“已读”假象。
  const parsedOutput = ReadOutputSchema.safeParse(input.output);
  if (!parsedOutput.success) return undefined;
  const output = parsedOutput.data;
  if (output.type !== "text" && output.type !== "file_unchanged") return undefined;

  const toolInput = asRecord(input.toolInput);
  const offset = toolInput ? numberField(toolInput, "offset") : undefined;
  const limit = toolInput ? numberField(toolInput, "limit") : undefined;
  const entry = input.readFileState?.get(
    createReadFileStateKey(output.filePath, offset === undefined ? 1 : offset, limit),
  );
  return createReadFileStateMetadataFromEntry({
    completedAt: input.completedAt,
    entry,
    toolName: "Read",
  });
}

/**
 * 把内存中的 ReadFileStateEntry 投影成持久化 metadata（Write/Edit/Workflow 也复用）。
 * 输出 undefined 的条件：entry 缺失，或缺少 mtimeMs/sizeBytes/revisionId 任一 freshness 事实。
 * 为什么严格：resume 的 stale guard 依赖这三个字段；缺字段的历史状态不能“冒充已读”，
 * 否则外部修改过的文件会被 agent 直接覆盖。
 * 纯函数；不读磁盘、不补全缺失字段。
 */
export function createReadFileStateMetadataFromEntry(input: {
  completedAt: Date;
  entry?: ReadFileStateEntry;
  toolName: PersistedReadFileStateTool;
}): PersistedReadFileStateMetadata | undefined {
  const entry = input.entry;
  if (!entry) return undefined;
  if (entry.mtimeMs === undefined || entry.sizeBytes === undefined || !entry.revisionId) {
    // resume stale guard 必须恢复文件时间戳和 adapter revision；
    // 缺 freshness metadata 的历史文件状态不能冒充已读，否则会放过 stale 写入。
    return undefined;
  }

  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool: input.toolName,
    path: entry.path,
    content: entry.content,
    // 可选字段只在存在时写入，避免把 undefined 持久化成 "null" 语义。
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
    isPartialView: entry.isPartialView,
    readAtMs: input.completedAt.getTime(),
    revisionId: entry.revisionId,
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
  };
}

/**
 * 从持久化的 tool part metadata 中解析 read-state。
 * 输入：metadata 的完整 state 对象，真实布局是 `{ readFileState: {...} }`（多一层嵌套）。
 * 输出：字段齐全且版本/工具合法时返回结构；否则 undefined（老数据/损坏数据统一降级）。
 * 严格项：schemaVersion 必须精确等于 1；path/content/isPartialView/readAtMs/revisionId/
 * mtimeMs/sizeBytes 缺一不可——缺 freshness 就不能参与 resume 的 stale guard。
 * 纯函数；不抛错、不迁移旧版本，调用方（hydrator）需容忍 undefined 并跳过恢复。
 */
export function parseReadFileStateMetadata(
  metadata: unknown,
): PersistedReadFileStateMetadata | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  // 注意：metadata 不是平铺结构，readFileState 是持久化时额外包的一层命名空间。
  const readState = asRecord(record.readFileState);
  if (!readState) return undefined;

  // 版本严格相等：未来版本字段语义可能变化，宁可拒绝恢复也不能按旧口径误读。
  if (readState.schemaVersion !== READ_FILE_STATE_METADATA_SCHEMA_VERSION) return undefined;
  const tool = stringField(readState, "tool");
  if (!isPersistedReadFileStateTool(tool)) return undefined;

  const path = stringField(readState, "path");
  const content = stringField(readState, "content");
  const readAtMs = numberField(readState, "readAtMs");
  const isPartialView = booleanField(readState, "isPartialView");
  const revisionId = stringField(readState, "revisionId");
  const mtimeMs = numberField(readState, "mtimeMs");
  const sizeBytes = numberField(readState, "sizeBytes");
  if (
    !path ||
    content === undefined ||
    readAtMs === undefined ||
    isPartialView === undefined ||
    !revisionId ||
    mtimeMs === undefined ||
    sizeBytes === undefined
  ) {
    return undefined;
  }
  const offset = numberField(readState, "offset");
  const limit = numberField(readState, "limit");

  // 可选字段保持缺席语义：offset=undefined 表示整文件，limit=undefined 表示读到末尾。
  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool,
    path,
    content,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    isPartialView,
    readAtMs,
    revisionId,
    mtimeMs,
    sizeBytes,
  };
}

// 白名单与 PersistedReadFileStateTool 对齐但当前少了 FillWorkflowHole；
// resume 恢复只接受这里列出的来源，未知/未来来源一律按“无事实”处理（fail closed）。
function isPersistedReadFileStateTool(value: unknown): value is PersistedReadFileStateTool {
  return (
    value === "Read" ||
    value === "Write" ||
    value === "Edit" ||
    value === "CreateWorkflow" ||
    value === "AmendWorkflow"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
