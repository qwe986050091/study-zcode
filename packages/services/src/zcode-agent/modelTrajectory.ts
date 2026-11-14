import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ZCodeModelTrajectory,
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "#src/session/zcodeTaskService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  readTrajectoryFileTail,
  resolveModelIODirs,
  sanitizeSessionSegment,
} from "#src/zcode-agent/modelTrajectoryFileTail.js";
import type { TrajectoryFileTail } from "#src/zcode-agent/modelTrajectoryFileTail.js";

// model-io 默认最多返回的调用条数（保留最近 N 条），避免长 session 把 UI 压垮。
// [资源] 默认只看最近 200 次调用：model-io 一个 session 可能累积上千条，
// 全量返回会把 UI 的虚拟列表和 IPC 载荷一起压垮。
const DEFAULT_TRAJECTORY_LIMIT = 200;
const SESSION_TITLE_PROMPT_PREFIX = "Generate a concise title for this coding session.";
// 轨迹读取只打 debug：单次读取可能涉及多个目录与文件，
// 生产环境按 session 记录会让日志量与轨迹本身同量级。
const logger = createServiceLogger("model-trajectory");

/**
 * 解析 ~/.zcode/cli/{debug,rollout} 下的 model-io JSONL，按 sessionId 还原某个 task 的模型调用轨迹。
 *
 * 设计说明：
 * - model-io 由 adapters/model/runner-debug.ts 落盘；一个 session 一个
 *   `model-io-<sanitizedSessionId>.jsonl`。
 * - ZCode Agent 把 taskId 当作 sessionId（见 zcodeTaskServiceAdapter），所以这里只读取
 *   该 session 的单文件，并按 `record.sessionId === taskId` 精确匹配。
 */
// 读取入口：只按 taskId 定位单个 model-io 文件，不做跨 session 聚合。
// 返回 available=true 即使没有任何记录，UI 据此区分「未开启记录」与「读取失败」。
export async function readModelTrajectory(
  taskId: string,
  limit = DEFAULT_TRAJECTORY_LIMIT,
): Promise<ZCodeModelTrajectory> {
// 上限做一次规整：NaN/0/负数都回落到默认值，
// 避免 slice(-0) 这类边界把结果截成空数组。
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_TRAJECTORY_LIMIT;
  const sanitized = sanitizeSessionSegment(taskId);
  const dirs = resolveModelIODirs();
// 记录真正命中的文件路径，便于用户从 UI 直接定位原始 JSONL。
  const sourceFiles: string[] = [];
  const rawRecords: Record<string, unknown>[] = [];
  let inputTruncated = false;

// debug 与 rollout 两个目录都可能存在同名文件，逐个尝试并合并；
// 目录不存在代表该模式没跑过，属于正常情况而不是错误。
  for (const dir of dirs) {
    let names: string[];
    try {
// 读目录失败直接跳过，不让一个不可读目录毁掉整次轨迹读取。
      names = await readdir(dir);
    } catch {
      // 目录不存在（没跑过对应模式）或不可读，跳过。
      continue;
    }

// 文件名中的 session 段必须与落盘侧同一套 sanitize 规则，
// 否则特殊字符的 sessionId 永远匹配不到自己的文件。
    const fileName = `model-io-${sanitized || "no-session"}.jsonl`;
    const candidates = names.includes(fileName) ? [fileName] : [];

    for (const name of candidates) {
      const filePath = join(dir, name);
      let tail: TrajectoryFileTail;
      const startedAt = Date.now();
      try {
        // 同步读取并 split 整个 model-io 会阻塞 Host 事件循环，并在大文件上制造多份字符串峰值。
        // 从尾部异步读取固定上限；若从行中间开始，则由 readTrajectoryFileTail 丢弃不完整残行。
// [资源] 只从尾部异步读取固定上限：同步读整个文件再 split 会阻塞 Host 事件循环，
// 并在大文件上制造多份字符串峰值；残行由 fileTail 负责丢弃。
        tail = await readTrajectoryFileTail(filePath);
        logger.debug(
          undefined,
          `read taskId=${taskId} bytes=${tail.bytesRead} truncated=${tail.truncated} durationMs=${Date.now() - startedAt}`,
        );
      } catch (error) {
        logger.debug(undefined, `read failed taskId=${taskId} file=${filePath}`, error);
        continue;
      }
// 任一文件被截断，最终结果就标记 truncated，让 UI 提示可能不完整。
      inputTruncated ||= tail.truncated;

// 只有本文件真的贡献了记录才记入 sourceFiles，
// 同名空文件不会出现在来源列表里误导用户。
      let matchedInFile = false;
      for (const line of tail.text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
// 单行解析失败只跳过这一行：JSONL 被并发追加时可能出现半行，
// 让整份轨迹因一行残片而失败是不可接受的。
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
// 双重过滤：文件里可能混有其它类型的调试记录，
// 且同一文件在被复用/追加时可能含有别的 session 行。
        if (parsed.type !== "model_io" || parsed.sessionId !== taskId) {
          continue;
        }
        rawRecords.push(parsed);
        matchedInFile = true;
      }

      if (matchedInFile) {
        sourceFiles.push(filePath);
      }
    }
  }

  // 按开始时间排序；同毫秒/缺失时间时按 requestId 兜底，保证顺序稳定。
// 排序键缺失或同毫秒时用 requestId 兜底，保证多次读取顺序稳定；
// 不稳定排序会让 UI 每次刷新都换一个顺序。
  rawRecords.sort((left, right) => {
    const startDiff = toTime(asString(left.startedAt)) - toTime(asString(right.startedAt));
    if (startDiff !== 0) {
      return startDiff;
    }
    return (asString(left.requestId) ?? "").localeCompare(asString(right.requestId) ?? "");
  });

// 先按时间顺序还原 delta 链，再逐条映射：
// 映射依赖前一条的完整请求，顺序错乱会拼出错误的上下文。
  const records = expandModelIODeltaRecords(rawRecords).map((record) => mapRecord(record));
  const truncated = inputTruncated || records.length > safeLimit;
// 截断保留尾部而不是头部：排障关心的是最近发生了什么。
  const trimmedRecords = truncated ? records.slice(records.length - safeLimit) : records;

  return {
    taskId,
    available: true,
    records: trimmedRecords,
    sourceFiles,
    truncated,
  };
}

// 非法/缺失时间统一归零，让它们稳定排在最前，而不是随机插入中间。
function toTime(value?: string): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

// [权衡] 落盘结构随版本演进而漂移，这里全部走 as* 弱校验：
// 字段缺失退化成分支默认值，而不是抛错丢掉整条记录。
// 映射结果必须与 shared 的 ZCodeModelTrajectoryRecord 结构严格对齐。
function mapRecord(record: Record<string, unknown>): ZCodeModelTrajectoryRecord {
  const request = asObject(record.request);
  const response = asObject(record.response);
  const model = asObject(record.model);
  const error = asObject(record.error);
// 显式字段优先，缺失时从 system prompt 前缀反推：
// 旧版本 model-io 不写 querySource，只能靠标题生成提示词识别。
  const querySource = asString(record.querySource) ?? inferQuerySourceFromRequest(request);
  const modelRole = asString(model?.role);

  const mapped: ZCodeModelTrajectoryRecord = {
    requestId: asString(record.requestId) ?? "",
    attempt: asNumber(record.attempt) ?? 1,
    startedAt: asString(record.startedAt) ?? "",
    completedAt: asString(record.completedAt),
    durationMs: asNumber(record.durationMs),
    turnId: asString(record.turnId),
    traceId: asString(record.traceId),
    callSource: classifyCallSource(querySource, modelRole),
    model: {
      modelId: asString(model?.modelId),
      providerId: asString(model?.providerId),
      role: modelRole,
      source: asString(model?.source),
    },
    request: {
      messages: mapMessages(request?.messages),
      toolNames: asStringArray(request?.toolNames),
    },
  };

// 只有响应存在时才建 response 节点；失败的调用保留 request 与 error，
// UI 仍能展示请求内容与错误原因。
  if (response) {
    const responseToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    mapped.response = {
      finishReason: asString(response.finishReason),
      text: asString(response.text),
      reasoningText: asString(response.reasoningText),
      toolCalls: responseToolCalls.map((toolCall) => mapResponseToolCall(toolCall)),
      usage: mapUsage(response.usage),
      responseId: asString(response.responseId),
      modelId: asString(response.modelId),
    };
  }

// 空 error 对象视为没有错误，避免给成功调用挂一个无意义的错误节点。
  if (error && (asString(error.message) || asString(error.name))) {
    mapped.error = {
      name: asString(error.name) ?? "Error",
      message: asString(error.message) ?? "",
      stack: asString(error.stack),
    };
  }

  return mapped;
}

// 只有首条消息是 system 且以标题生成提示开头时才判定为 session_title：
// 这个前缀是落盘侧与读取侧共享的隐式契约，改动必须两边同步。
function inferQuerySourceFromRequest(
  request: Record<string, unknown> | undefined,
): string | undefined {
  const messages = request?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
// [权衡] 只检查首条 system 消息：标题生成请求的结构固定为
// system(标题提示) + user(会话内容)，后续消息不参与判定。
// 不做全文搜索是因为用户对话里完全可能引用这段提示词，
// 一旦误判，普通主对话会被错误归类成 sidecar。
// 这个反推只是兼容旧记录的兜底，新版本应优先写显式 querySource。
  const first = asObject(messages[0]);
  if (first?.role !== "system") {
    return undefined;
  }
  const content = asString(first.content);
  return content?.startsWith(SESSION_TITLE_PROMPT_PREFIX) ? "session_title" : undefined;
}

// 调用来源分类给 UI 做分组/过滤：优先看显式 querySource，
// 再看 compact 的 model role（压缩调用可能没有 querySource），
// 最后兜底为 main，保证任何记录都有合法 kind。
function classifyCallSource(
  querySource: string | undefined,
  modelRole: string | undefined,
): ZCodeModelTrajectoryCallSource {
  if (querySource === "main_turn") {
    return { kind: "main", querySource };
  }
  if (querySource === "subagent") {
    return { kind: "subagent", querySource };
  }
  if (querySource === "compact" || modelRole === "compact") {
    return { kind: "compact", querySource };
  }
  if (querySource) {
    return { kind: "sidecar", querySource };
  }
  if (modelRole === "subagent") {
    return { kind: "subagent" };
  }
  return { kind: "main" };
}

// [事务] delta 展开是按顺序串行累积的：每条记录只依赖前一条完整结果，
// 因此必须先排序再逐条展开，不能并行也不能只处理子集。
function expandModelIODeltaRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
// 展开结果与输入等长，保持一一对应，方便按索引回溯原始记录。
  const expanded: Record<string, unknown>[] = [];
  let previous: Record<string, unknown> | undefined;
  for (const record of records) {
    const next = expandModelIORecord(record, previous);
    expanded.push(next);
    previous = next;
  }
  return expanded;
}

// 只有 request 存在时才需要展开；其余记录原样返回，
// 避免为无关记录复制对象。
function expandModelIORecord(
  record: Record<string, unknown>,
  previousRecord?: Record<string, unknown>,
): Record<string, unknown> {
  const request = asObject(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: expandModelIORequest(request, asObject(previousRecord?.request)),
  };
}

// 一个请求里可能有三份消息集合：messages、sdkMessages、body.messages，
// 三者各自独立维护 kind/offset 三元组，不能共用一份元数据。
function expandModelIORequest(
  request: Record<string, unknown>,
  previousRequest?: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...request };
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

  const body = asObject(next.body);
  if (body) {
    const nextBody = { ...body };
    expandMessageCollection(
      nextBody,
      asObject(previousRequest?.body),
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

// 展开单个消息集合的三态逻辑：tail 视为新起点、delta 才拼接、其余原样保留。
// metadataSource 允许与 target 分离，是因为 body.messages 的元数据写在请求顶层，
// 内容却挂在 body 下，两者不在同一个对象上。
function expandMessageCollection(
  target: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  keys: {
    collectionKey: string;
    kindKey: string;
    offsetKey: string;
  },
  metadataSource: Record<string, unknown> = target,
): void {
// [事务] tail 是新的展开起点：文件超限或进程内缓存丢失后落盘侧会写最近窗口 baseline。
// 继续向前拼接会把已裁剪的巨大上下文又带回 UI 读取链路，
// 这里必须原地返回，让 tail 成为该集合的完整内容。
  if (metadataSource[keys.kindKey] === "tail") {
    // model-io 文件超限或进程内缓存丢失后会写最近窗口 baseline。
    // tail 是新的展开起点，不能继续拼接更早历史，否则又会把已裁剪的巨大上下文带回 UI 读取链路。
    return;
  }
// 非 delta（完整快照或旧格式）无需展开，直接用自身内容。
  if (metadataSource[keys.kindKey] !== "delta") {
    return;
  }
  const deltaMessages = target[keys.collectionKey];
// 上一轮缺失对应集合时不拼接：宁可展示本轮 delta，
// 也不要把不完整的历史当成完整上下文交给 UI。
  const previousMessages = previous?.[keys.collectionKey];
  const offset = asNonNegativeInteger(metadataSource[keys.offsetKey]);
  if (!Array.isArray(deltaMessages) || !Array.isArray(previousMessages) || offset === undefined) {
    return;
  }
  // 新 model-io 为了避免同一 session 内完整上下文梯度重复，只保存 delta；服务层读出时还原给 UI。
// 还原语义：offset 之前的历史取自上一轮，之后替换为本次 delta。
// 偏移越界已被前面的整数校验挡住，这里只处理合法输入。
  target[keys.collectionKey] = [...previousMessages.slice(0, offset), ...deltaMessages];
}

// 消息角色缺失时标记 unknown 而不是丢弃：
// 保留结构才能让用户在轨迹里看到这条内容确实存在。
// tool 关联字段有多种历史拼写，按 toolCallId → tool_call_id → tool_use_id 依次兜底。
function mapMessages(value: unknown): ZCodeModelTrajectoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
// 非对象消息退化成空消息而不是过滤掉，
// 这样索引仍与原始数组对齐，排障时不会错位。
    const message = asObject(entry) ?? {};
    const role = asString(message.role) ?? "unknown";
    return {
      role,
      parts: mapContent(message.content, role, {
        toolCallId:
          asString(message.toolCallId) ??
          asString(message.tool_call_id) ??
          asString(message.tool_use_id),
        toolName: asString(message.toolName) ?? asString(message.name),
        isError: message.isError === true || message.is_error === true,
      }),
    };
  });
}

// 内容既可能是纯字符串也可能是分片数组，两种形态都要归一成分片列表；
// 空字符串返回空列表，避免 UI 渲染出一个空文本块。
function mapContent(
  content: unknown,
  role?: string,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart[] {
// 字符串内容在 tool 角色下是工具输出，其余角色是普通文本。
  if (typeof content === "string") {
    if (content.length === 0) return [];
    // tool 角色的字符串内容即工具输出，单独标记为 tool-result 便于 UI 区分。
// [失败路径] model-io 把关联字段放在消息顶层而 content 只存字符串：
// 丢掉顶层字段会让 UI 无法把工具返回关联回对应的 tool call。
    if (role === "tool") {
      // 实际 model-io 把关联字段放在消息顶层，而 content 只保存字符串结果；
      // 丢掉顶层字段会让 UI 无法把 TOOL 返回关联到对应 tool call。
      return [
        {
          kind: "tool-result",
          toolCallId: messageTool?.toolCallId,
          toolName: messageTool?.toolName,
          // 标准化 model-io 会把 error-text 展平为 content + isError；这里必须还原类型，
          // 否则 UI 只能看到错误字符串，无法显示错误状态。
// 标准化写入会把 error-text 展平成 content + isError，这里必须还原类型，
// 否则 UI 只能看到一段错误字符串，无法显示错误状态。
          output: tryParseJson(content, messageTool?.isError),
        },
      ];
    }
// 普通角色的字符串内容直接作为单个 text 分片。
    return [{ kind: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((rawPart) => mapPart(rawPart, role === "tool" ? messageTool : undefined));
}

// 未知分片统一落成 {kind:unknown, raw}：
// [契约] 未知分片落成 {kind:"unknown", raw} 并保留 raw：新分片上线后读取侧无需改动即可排查。
function mapPart(
  rawPart: unknown,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart {
  const part = asObject(rawPart);
// 非对象分片保留原始值，交给 UI 以 unknown 形式降级展示。
  if (!part) {
    return { kind: "unknown", raw: rawPart };
  }

// 分支按 UI 能渲染的语义收敛：text/reasoning/tool-call/tool-result/image，
// 其余类型都进 default 的 unknown 分支。
  switch (part.type) {
    case "text":
      return { kind: "text", text: asString(part.text) ?? "" };
    case "reasoning":
      return { kind: "reasoning", text: asString(part.text) ?? "" };
// input 与 args 是同一字段的两代拼写，按顺序兜底。
    case "tool-call":
      return {
        kind: "tool-call",
        toolCallId: asString(part.toolCallId),
        toolName: asString(part.toolName) ?? "tool",
        input: part.input ?? part.args,
      };
// 分片自身缺失关联 id 时退化到消息顶层字段，兼容两代落盘格式。
    case "tool-result":
      return {
        kind: "tool-result",
        toolCallId: asString(part.toolCallId) ?? messageTool?.toolCallId,
        toolName: asString(part.toolName) ?? messageTool?.toolName,
        output: part.output ?? part.result,
      };
// image 与 file 共用 image kind：UI 只按媒体类型展示，不需要区分来源字段名。
    case "image":
    case "file":
      return { kind: "image", mediaType: asString(part.mediaType) };
    default:
      return { kind: "unknown", raw: rawPart };
  }
}

// response.toolCalls 是归一化后的 {id,name,input}，
// 与 request 侧的 tool-call 分片结构不同，需要单独映射。
function mapResponseToolCall(rawToolCall: unknown): ZCodeModelTrajectoryContentPart {
// 非对象工具调用保留原始载荷，避免静默丢一次调用记录。
  const toolCall = asObject(rawToolCall);
  if (!toolCall) {
    return { kind: "unknown", raw: rawToolCall };
  }
  return {
    kind: "tool-call",
    // 归一化后的 response.toolCalls 形如 {id, name, input}。
    toolCallId: asString(toolCall.id) ?? asString(toolCall.toolCallId),
    toolName: asString(toolCall.name) ?? asString(toolCall.toolName) ?? "tool",
    input: toolCall.input ?? toolCall.args,
  };
}

// usage 整体缺失返回 undefined（UI 不显示面板），
// 单个字段缺失保留 undefined，不补 0，避免把未知当成零消耗。
function mapUsage(value: unknown): ZCodeModelTrajectoryUsage | undefined {
// usage 必须是对象才映射；数组或标量视为未提供。
  const usage = asObject(value);
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    totalTokens: asNumber(usage.totalTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    reasoningTokens: asNumber(usage.reasoningTokens),
  };
}

// 工具输出多数是 JSON 文本，能解析就还原结构；
// 解析失败保留原字符串，绝不因此丢弃内容。
function tryParseJson(value: string, isError = false): unknown {
  if (isError) return { type: "error-text", value };
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 数组也排除在外：JSON 数组不是可按键取值的对象，混用会静默取到 length 等字段。
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// 只接受真正的字符串：数字/布尔一律视为缺失，不做隐式转换。
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// NaN/Infinity 一律视为缺失，防止它们进入 UI 的数值格式化。
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// offset 必须是整数且非负：小数或负数会让 slice 行为变得难以预测。
function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// 数组内非字符串项直接过滤，不抛错：工具名列表用于展示，容错优于严格。
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
