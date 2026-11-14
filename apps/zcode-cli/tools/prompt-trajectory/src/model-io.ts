/**
 * 文件职责：把 model-io JSONL（运行时逐请求 I/O 日志）转换为轨迹并导出 Anthropic 请求体。
 * 输入：model-io 条目流，可按 querySource 过滤；输出：与 derive 相同的派生结果。
 * 副作用：writeModelIoAnthropicTrajectory 建目录并写轨迹、anthropic_trajectory.json、manifest.json。
 * 失败语义：JSONL 解析失败、请求缺 messages、消息缺 role、过滤后无记录时抛 Error。
 * 关键不变量：delta 消息集合先与上一条合并成完整历史，再做追加判定与派生。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createAnthropicRequestBody,
  deriveTrajectoriesFromEntries,
  type DerivedTrajectoryResult,
} from "./derive.js";
import { completeAssistantMessage } from "./message-continuity.js";
import type {
  JsonObject,
  OpenAiMessage,
  TrajectoryDerivationOptions,
  TrajectoryJsonlEntry,
} from "./types.js";

/**
 * 默认 querySource：未显式标注时的主回合。
 * 用于过滤，避免把标题生成等旁路请求混入主轨迹。
 */
const DEFAULT_QUERY_SOURCE = "main_turn";
/**
 * 会话标题请求的系统提示前缀。
 * 仅用于无显式 querySource 时兜底分类，不参与轨迹内容。
 */
const SESSION_TITLE_PROMPT_PREFIX = "Generate a concise title for this coding session.";

/**
 * model-io JSONL 的单行条目。
 * extends JsonObject：允许携带未知附加字段，解析时原样保留。
 * 全部字段可序列化；type 缺失视为 model_io（兼容旧日志）。
 */
export interface ModelIoJsonlEntry extends JsonObject {
  /** 请求来源分类，如 main_turn / session_title；缺失时按内容启发式推断。 */
  querySource?: string;
  /** 本次模型请求的输入快照。 */
  request?: ModelIoRequest;
  /** 本次模型响应摘要；缺失表示未记录响应。 */
  response?: ModelIoResponse;
  /** 条目类型；缺失或 "model_io" 才参与转换，其余类型被过滤。 */
  type?: string;
}

/**
 * model-io 请求快照。
 * messages/sdkMessages/body.messages 三处可能以全量或 delta 形式出现，靠各自 kind/offset 元数据判定。
 */
interface ModelIoRequest extends JsonObject {
  /** 请求体（含 messages 与采样参数）。 */
  body?: JsonObject;
  /** body.messages 为 delta 时的起始偏移；缺失表示非 delta。 */
  bodyMessageOffset?: number;
  /** body.messages 的集合类型；值为 "delta" 才触发拼接。 */
  bodyMessagesKind?: string;
  /** messages 为 delta 时的起始偏移。 */
  messageOffset?: number;
  /** 消息集合，可能是完整数组或增量分片。 */
  messages?: unknown[];
  /** messages 的集合类型；"delta" 表示需要与上一条拼接。 */
  messagesKind?: string;
  /** sdkMessages 为 delta 时的起始偏移。 */
  sdkMessageOffset?: number;
  /** SDK 层消息集合，通常包含 provider 原始形状。 */
  sdkMessages?: unknown[];
  /** sdkMessages 的集合类型；"delta" 表示需要拼接。 */
  sdkMessagesKind?: string;
}

/**
 * model-io 响应摘要。
 * 只保留可重建 assistant 消息的字段；缺失字段即未记录。
 */
interface ModelIoResponse extends JsonObject {
  /** 文本输出；空串视为无文本。 */
  text?: string;
  /** 工具调用列表，元素需含 id 与 name 才有效。 */
  toolCalls?: unknown[];
}

/**
 * 归一化后的工具调用。
 * id/name 必填，input 为任意 JSON；单位与语义由工具自身 schema 决定。
 */
interface ModelIoToolCall {
  /** provider 返回的调用 id，用于与 tool_result 关联。 */
  id?: string;
  /** 结构化入参；缺失时按空对象处理。 */
  input?: unknown;
  /** 工具名。 */
  name?: string;
}

/**
 * model-io 转换选项。
 * 在派生选项之上增加 querySource 过滤；两者都可选，缺省使用 DEFAULT_QUERY_SOURCE 与严格比较。
 */
export interface ModelIoTrajectoryOptions extends TrajectoryDerivationOptions {
  /** 只转换该来源的记录；缺失时取 "main_turn"。 */
  querySource?: string;
}

/**
 * 读取 model-io JSONL、转换并落盘 Anthropic 轨迹产物。
 * 输入：输入路径、输出目录、querySource 与派生选项。
 * 输出：DerivedTrajectoryResult；同时写入磁盘。
 * 副作用：建 outDir/trajectories，逐轨迹写 openai/anthropic 请求体；
 * 额外写 anthropic_trajectory.json（仅第一条轨迹）与 manifest.json。
 * 失败语义：过滤后无轨迹时抛 Error；写盘失败立即抛出。
 * 不变量：anthropic_trajectory.json 是 trajectories[0] 的单条投影，仅作快速查看。
 */
export async function writeModelIoAnthropicTrajectory(
  input: ModelIoTrajectoryOptions & {
    inputPath: string;
    outDir: string;
  },
): Promise<DerivedTrajectoryResult> {
  const result = deriveTrajectoriesFromModelIoEntries(
    await readModelIoJsonl(input.inputPath),
    input,
  );
  if (result.trajectories.length === 0) {
    throw new Error(
      `No model-io records matched querySource ${input.querySource ?? DEFAULT_QUERY_SOURCE}`,
    );
  }

  const trajectoriesDir = join(input.outDir, "trajectories");
  await mkdir(trajectoriesDir, { recursive: true });

  for (const trajectory of result.trajectories) {
    await writeFile(
      join(trajectoriesDir, `${trajectory.id}.openai_request_body.json`),
      `${JSON.stringify(trajectory.requestBody, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(trajectoriesDir, `${trajectory.id}.anthropic_request_body.json`),
      `${JSON.stringify(createAnthropicRequestBody(trajectory), null, 2)}\n`,
      "utf8",
    );
  }

  await writeFile(
    join(input.outDir, "anthropic_trajectory.json"),
    `${JSON.stringify(createAnthropicRequestBody(result.trajectories[0]!), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  return result;
}

/**
 * 纯内存转换：model-io 条目 -> 轨迹派生结果。
 * 输入：条目流与选项；先过滤非 model_io 条目、按 querySource 筛选，再展开 delta 并转成轨迹条目。
 * 输出：DerivedTrajectoryResult；无匹配时为 0 条轨迹而非抛错（由写盘层决定是否失败）。
 * 无文件副作用；所有转换结果均为深拷贝。
 * 不变量：过滤顺序为 type -> querySource，避免无关条目影响 delta 链。
 */
export function deriveTrajectoriesFromModelIoEntries(
  entries: readonly ModelIoJsonlEntry[],
  options: ModelIoTrajectoryOptions = {},
): DerivedTrajectoryResult {
  const querySource = options.querySource ?? DEFAULT_QUERY_SOURCE;
  const expandedRecords = expandModelIoRecords(
    entries.filter((entry) => entry.type === undefined || entry.type === "model_io"),
  );
  const trajectoryEntries = modelIoRecordsToTrajectoryEntries(
    // 先按 querySource 过滤，再做 delta 展开后的追加判定，避免旁路请求打断主轨迹。
    expandedRecords.filter((record) => modelIoQuerySource(record) === querySource),
    options,
  );
  return deriveTrajectoriesFromEntries(trajectoryEntries, options);
}

/**
 * 逐行读取 model-io JSONL。
 * 输入：文件路径；空行忽略。
 * 输出：条目数组，保持行序。
 * 副作用：读文件。
 * 失败语义：任一行解析失败时抛带 `文件:行号` 的 Error，并保留 cause。
 */
async function readModelIoJsonl(inputPath: string): Promise<ModelIoJsonlEntry[]> {
  // 逐行解析，坏行直接报错并带上文件名与行号，避免静默丢记录。
  const content = await readFile(inputPath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ModelIoJsonlEntry;
      } catch (error) {
        throw new Error(`Invalid model-io JSONL at ${basename(inputPath)}:${index + 1}`, {
          cause: error,
        });
      }
    });
}

/**
 * 顺序展开所有条目的 delta 集合。
 * 输入：条目流。
 * 输出：同长度的新数组；每条都可能被补齐为完整消息集合。
 * 无副作用；不修改入参。
 * 不变量：展开依赖“上一条已展开结果”，因此必须按原始顺序单遍处理。
 */
function expandModelIoRecords(entries: readonly ModelIoJsonlEntry[]): ModelIoJsonlEntry[] {
  const expanded: ModelIoJsonlEntry[] = [];
  let previous: ModelIoJsonlEntry | undefined;

  for (const entry of entries) {
    const next = expandModelIoRecord(entry, previous);
    expanded.push(next);
    previous = next;
  }

  return expanded;
}

/**
 * 展开单条记录：仅处理 request 内的三类消息集合。
 * 输入：当前条目与上一条（已展开）。
 * 输出：深拷贝后的新条目；无 request 时原样克隆。
 * 无副作用；不修改入参。
 */
function expandModelIoRecord(
  entry: ModelIoJsonlEntry,
  previousEntry?: ModelIoJsonlEntry,
): ModelIoJsonlEntry {
  const request = asRecord(entry.request);
  if (!request) {
    return cloneJsonObject(entry) as ModelIoJsonlEntry;
  }

  return {
    ...cloneJsonObject(entry),
    request: expandModelIoRequest(request, asRecord(previousEntry?.request)),
  };
}

/**
 * 展开单个请求中的 messages、sdkMessages 与 body.messages。
 * 输入：当前请求、上一条请求（已展开）。
 * 输出：深拷贝后的新请求对象。
 * 无副作用；不修改入参。
 * 不变量：body 的 delta 元数据挂在 body 上，其余两组挂在 request 顶层。
 */
function expandModelIoRequest(
  request: Record<string, unknown>,
  previousRequest?: Record<string, unknown>,
): ModelIoRequest {
  const next = { ...cloneJsonObject(request) } as ModelIoRequest;
  expandMessageCollection(next, previousRequest, {
    collectionKey: "messages",
    kindKey: "messagesKind",
    offsetKey: "messageOffset",
  });
  expandMessageCollection(next, previousRequest, {
    collectionKey: "sdkMessages",
    kindKey: "sdkMessagesKind",
    offsetKey: "sdkMessageOffset",
  });

  const body = asRecord(next.body);
  if (body) {
    const nextBody = { ...cloneJsonObject(body) } as JsonObject;
    expandMessageCollection(
      nextBody,
      asRecord(asRecord(previousRequest?.body)),
      {
        collectionKey: "messages",
        kindKey: "bodyMessagesKind",
        offsetKey: "bodyMessageOffset",
      },
      next,
    );
    next.body = nextBody;
  }

  return next;
}

/**
 * 若集合标记为 delta，则把增量与上一条按 offset 合并成完整数组。
 * 输入：目标对象、上一条请求、键名三元组、元数据来源对象（默认同 target）。
 * 输出：无；原地写回 target[collectionKey]。
 * 副作用：修改 target。
 * 失败语义：非 delta、缺上一条、offset 非法或数组形状不符时静默跳过，保持原值。
 * 不变量：结果 = previous 的前 offset 项 + delta，保证历史完整且不重复。
 */
function expandMessageCollection(
  target: JsonObject,
  previous: Record<string, unknown> | undefined,
  keys: {
    collectionKey: string;
    kindKey: string;
    offsetKey: string;
  },
  metadataSource: JsonObject = target,
): void {
  if (metadataSource[keys.kindKey] !== "delta") {
    return;
  }
  const deltaMessages = target[keys.collectionKey];
  const previousMessages = previous?.[keys.collectionKey];
  const offset = asNonNegativeInteger(metadataSource[keys.offsetKey]);
  if (!Array.isArray(deltaMessages) || !Array.isArray(previousMessages) || offset === undefined) {
    return;
  }

  target[keys.collectionKey] = [
    // delta 只含新增片段，必须补上 offset 之前的旧消息，否则历史会从中间断掉。
    ...cloneArray(previousMessages.slice(0, offset)),
    ...cloneArray(deltaMessages),
  ];
}

/**
 * 把展开后的 model-io 记录转成轨迹条目流。
 * 输入：按 querySource 过滤后的记录与派生选项。
 * 输出：request 条目 + 请求内 message 条目 + 可选 assistant 补录条目。
 * 无副作用；所有消息深拷贝。
 * 失败语义：body.messages 非数组或消息缺 role 时抛 Error。
 * 不变量：requestIndex 从 1 递增；assistant 补录条目不带 messageIndex。
 */
function modelIoRecordsToTrajectoryEntries(
  records: readonly ModelIoJsonlEntry[],
  options: ModelIoTrajectoryOptions,
): TrajectoryJsonlEntry[] {
  const entries: TrajectoryJsonlEntry[] = [];
  let requestIndex = 0;
  const requests = records.flatMap((record) => {
    const body = asRecord(record.request?.body);
    return body ? [{ body, response: record.response }] : [];
  });

  for (const [recordIndex, { body, response }] of requests.entries()) {
    const messages = body.messages;
    if (!Array.isArray(messages)) {
      throw new Error("model-io request.body must contain a messages array.");
    }

    requestIndex += 1;
    const { messages: _messages, ...bodyWithoutMessages } = cloneJsonObject(body);
    entries.push({
      bodyWithoutMessages,
      kind: "request",
      requestIndex,
    });

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!isOpenAiMessage(message)) {
        throw new Error(`model-io request message ${messageIndex} is missing role.`);
      }
      entries.push({
        kind: "message",
        message: cloneJsonObject(message) as OpenAiMessage,
        messageIndex,
        requestIndex,
      });
    }

    const assistantMessage = assistantMessageFromModelIoResponse(response);
    if (assistantMessage) {
      // 用下一条请求的 messages 作为比较目标，才能为本次响应补全完整摘要。
      entries.push({
        kind: "message",
        message: completeAssistantMessage(
          assistantMessage,
          messages as OpenAiMessage[],
          requests[recordIndex + 1]?.body.messages,
          options,
        ),
        requestIndex,
      });
    }
  }

  return entries;
}

/**
 * 从响应摘要重建 assistant 消息。
 * 输入：可选的 response。
 * 输出：content 数组形式的 assistant 消息；无文本且无有效工具调用时返回 undefined。
 * 无副作用；tool call input 深拷贝。
 * 口径：空字符串视为无文本，不生成空 text block。
 */
function assistantMessageFromModelIoResponse(
  response: ModelIoResponse | undefined,
): OpenAiMessage | undefined {
  if (!response) {
    return undefined;
  }

  const content: unknown[] = [];
  if (typeof response.text === "string" && response.text.length > 0) {
    content.push({ type: "text", text: response.text });
  }

  for (const toolCall of normalizedToolCalls(response.toolCalls)) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: cloneJsonValue(toolCall.input ?? {}),
    });
  }

  return content.length > 0 ? { role: "assistant", content } : undefined;
}

/**
 * 过滤并归一化工具调用。
 * 输入：任意数组。
 * 输出：只含 id 与 name 的调用列表；缺任一字段的项被丢弃。
 * 无副作用；不抛错。
 * 用途：响应里的 toolCalls 结构不稳定，先收窄再放入 content。
 */
function normalizedToolCalls(value: unknown[] | undefined): ModelIoToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((raw) => {
    const toolCall = asRecord(raw);
    if (!toolCall) {
      return [];
    }
    const id = typeof toolCall?.id === "string" ? toolCall.id : undefined;
    const name = typeof toolCall?.name === "string" ? toolCall.name : undefined;
    if (!id || !name) {
      return [];
    }
    return [{ id, input: toolCall.input, name }];
  });
}

/**
 * 推断条目来源分类。
 * 输入：条目；优先显式 querySource，其次看首条 system/user 文本是否以标题提示开头。
 * 输出：来源字符串；无法判断时返回 DEFAULT_QUERY_SOURCE。
 * 无副作用；不抛错。
 */
function modelIoQuerySource(record: ModelIoJsonlEntry): string {
  if (typeof record.querySource === "string") {
    return record.querySource;
  }

  const messages = asRecord(record.request?.body)?.messages;
  const firstMessage = Array.isArray(messages) ? asRecord(messages[0]) : undefined;
  // 旧日志没有 querySource 字段，只能靠标题 prompt 特征把旁路请求分出去。
  if (firstMessage?.role === "system" || firstMessage?.role === "user") {
    const text = messageText(firstMessage.content);
    if (text.startsWith(SESSION_TITLE_PROMPT_PREFIX)) {
      return "session_title";
    }
  }

  return DEFAULT_QUERY_SOURCE;
}

/**
 * 递归提取值中的文本，用于标题请求识别。
 * 输入：字符串/数组/对象。
 * 输出：换行拼接的文本；无可提取内容时为空串。
 * 无副作用；对象只取 text 与 content 字段。
 */
function messageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(messageText).join("\n");
  }
  const record = value as Record<string, unknown>;
  return [record.text, record.content].map(messageText).join("\n");
}

/**
 * 运行时判定是否为可用消息。
 * 口径：非空普通对象且 role 为字符串；数组与 null 拒绝。
 * 不抛错；失败由调用方转成 Error。
 */
function isOpenAiMessage(value: unknown): value is OpenAiMessage {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string",
  );
}

/**
 * 收窄为普通对象。
 * 输入：任意值；数组、null、原始类型均返回 undefined。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 解析非负整数 offset。
 * 输入：任意值；非 number、非整数或负数都视为缺失，返回 undefined。
 */
function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 深拷贝数组。
 * 口径：JSON 序列化往返；元素需为纯 JSON 数据。
 */
function cloneArray(value: readonly unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(value)) as unknown[];
}

/**
 * 深拷贝普通对象。
 * 口径：JSON 序列化往返；undefined 字段会被丢弃。
 */
function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * 深拷贝任意 JSON 值。
 * 口径：JSON 序列化往返；用于隔离 tool call input。
 */
function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
