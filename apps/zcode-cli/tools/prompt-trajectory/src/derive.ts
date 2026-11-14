/**
 * 文件职责：从 trajectory JSONL 条目派生独立轨迹，并落盘为 OpenAI/Anthropic 请求体。
 * 输入：消息账本条目流；输出：DerivedTrajectoryResult（manifest + trajectories）。
 * 副作用：writeDerivedTrajectories 会建目录、逐轨迹写两种请求体、写 manifest，
 * 可选复制原始 CC 请求到 raw/。
 * 失败语义：JSONL 解析失败、消息引用缺失 requestIndex、消息下标稀疏时抛 Error（带上下文与 cause）。
 * 关键不变量：历史仅追加就沿用同一轨迹；出现压缩摘要或非追加改写则新开轨迹，不丢中间请求。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isAppendOnly } from "./message-continuity.js";
import type {
  DerivedTrajectory,
  DerivedTrajectoryManifest,
  JsonObject,
  OpenAiMessage,
  TrajectoryDerivationOptions,
  TrajectoryJsonlEntry,
} from "./types.js";

export type { TrajectoryJsonlEntry } from "./types.js";

/**
 * 触发 post-compaction 判定的系统摘要前缀。
 * 命中任意一条即认为该请求是从压缩上下文重建的起点；文案需与上游保持一致。
 */
const COMPACT_SUMMARY_PREFIXES = [
  "This session is being continued from a previous conversation that ran out of context",
  "This session is being continued from a previous conversation that was compacted",
];

/**
 * 单个请求的归组快照，由 JSONL 条目还原。
 * messages 按 messageIndex 落位；responses 是请求结束后补录的 assistant 回复。
 */
interface RequestSnapshot {
  /** 剥离 messages/input 后的请求参数，保持原始键值。 */
  bodyWithoutMessages: JsonObject;
  /** 请求内消息，按 messageIndex 排序后的完整数组。 */
  messages: OpenAiMessage[];
  /** 请求序号，1 基，来自记录阶段。 */
  requestIndex: number;
  /** 该请求之后补录的回复，按写入顺序排列。 */
  responses: OpenAiMessage[];
}

/**
 * 派生过程中的可变轨迹，尚未冻结为输出结构。
 * messages 会随追加请求滚动更新，代表“该轨迹截至目前的完整历史”。
 */
interface MutableTrajectory {
  /** 最近一次请求的非消息参数，代表轨迹当前口径。 */
  bodyWithoutMessages: JsonObject;
  /** 已纳入的最后一个请求序号。 */
  lastRequestIndex: number;
  /** 当前完整消息历史（含所有已追加的 assistant 回复）。 */
  messages: OpenAiMessage[];
  /** 轨迹起点原因，一旦创建不再修改。 */
  reason: DerivedTrajectory["reason"];
  /** 已纳入的请求数，1 基。 */
  requestCount: number;
}

/**
 * 派生结果。
 * manifest 为可落盘摘要；trajectories 为完整请求体，顺序与 manifest 一致。
 */
export interface DerivedTrajectoryResult {
  manifest: DerivedTrajectoryManifest;
  trajectories: DerivedTrajectory[];
}

/**
 * 从 JSONL 文件派生轨迹。
 * 输入：JSONL 路径与派生选项（ignoreToolSearchChanges 影响追加判定口径）。
 * 输出：DerivedTrajectoryResult；纯内存结果，不写盘。
 * 副作用：读取文件一次。
 * 失败语义：读文件失败或任一行 JSON 解析失败时抛出，不跳过坏行。
 */
export async function deriveTrajectoriesFromJsonlFile(
  inputPath: string,
  options: TrajectoryDerivationOptions = {},
): Promise<DerivedTrajectoryResult> {
  return deriveTrajectoriesFromEntries(await readTrajectoryJsonl(inputPath), options);
}

/**
 * 派生并落盘轨迹产物。
 * 输入：输出目录、输入 JSONL、可选原始 CC 请求路径与派生选项。
 * 输出：与内存派生一致的 DerivedTrajectoryResult。
 * 副作用：创建 outDir/trajectories；每条轨迹写 `<id>.openai_request_body.json` 与
 * `<id>.anthropic_request_body.json`，再写 manifest.json；有 ccRequestPath 时复制到 raw/。
 * 失败语义：任一步写盘失败立即抛出，已写文件不回滚。
 * 不变量：文件名由轨迹 id 决定，重复运行会覆盖同名产物。
 */
export async function writeDerivedTrajectories(
  input: TrajectoryDerivationOptions & {
    ccRequestPath?: string;
    inputPath: string;
    outDir: string;
  },
): Promise<DerivedTrajectoryResult> {
  const result = await deriveTrajectoriesFromJsonlFile(input.inputPath, input);
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
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  if (input.ccRequestPath) {
    const rawDir = join(input.outDir, "raw");
    await mkdir(rawDir, { recursive: true });
    const raw = await readFile(input.ccRequestPath, "utf8");
    await writeFile(
      join(rawDir, "cc-request-body.raw.json"),
      raw.endsWith("\n") ? raw : `${raw}\n`,
    );
  }

  return result;
}

/**
 * 纯内存派生：把条目流切成独立轨迹。
 * 输入：JSONL 条目与派生选项；条目顺序即请求时间序。
 * 输出：manifest + 完整轨迹列表；generatedAt 取当前时刻。
 * 无文件副作用；所有消息/参数均深拷贝，确保输出与输入无共享引用。
 * 规则：首请求开 initial；仅追加则滚动更新；否则按是否含压缩摘要决定新轨迹原因。
 * 失败语义：归组阶段的结构错误抛出，不做容错跳过。
 */
export function deriveTrajectoriesFromEntries(
  entries: readonly TrajectoryJsonlEntry[],
  options: TrajectoryDerivationOptions = {},
): DerivedTrajectoryResult {
  const snapshots = groupRequestSnapshots(entries);
  const mutableTrajectories: MutableTrajectory[] = [];
  let current: MutableTrajectory | undefined;

  for (const snapshot of snapshots) {
    if (!current) {
      current = startTrajectory(snapshot, "initial");
      mutableTrajectories.push(current);
      appendResponses(current, snapshot.responses);
      continue;
    }

    if (isAppendOnly(current.messages, snapshot.messages, options)) {
      // 仅追加时用最新快照滚动覆盖：最新请求的消息与参数才是该轨迹的有效口径。
      current.messages = cloneMessages(snapshot.messages);
      current.bodyWithoutMessages = cloneJsonObject(snapshot.bodyWithoutMessages);
      current.lastRequestIndex = snapshot.requestIndex;
      current.requestCount += 1;
      appendResponses(current, snapshot.responses);
      continue;
    }

    // 压缩摘要决定 post-compaction；否则统一归为历史改写，便于报告区分两类断点。
    const reason = containsCompactSummary(snapshot.messages)
      ? "post-compaction"
      : "non-incremental-change";
    current = startTrajectory(snapshot, reason);
    mutableTrajectories.push(current);
    appendResponses(current, snapshot.responses);
  }

  const hasPostCompaction = mutableTrajectories.some(
    (trajectory) => trajectory.reason === "post-compaction",
  );
  const trajectories = mutableTrajectories.map((trajectory, index) =>
    freezeTrajectory(trajectory, index, hasPostCompaction),
  );

  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...(options.ignoreToolSearchChanges ? { ignoreToolSearchChanges: true as const } : {}),
      trajectories: trajectories.map((trajectory) => ({
        id: trajectory.id,
        lastRequestIndex: trajectory.lastRequestIndex,
        messageCount: trajectory.requestBody.messages.length,
        reason: trajectory.reason,
        requestCount: trajectory.requestCount,
      })),
    },
    trajectories,
  };
}

/**
 * 逐行读取并解析 JSONL。
 * 输入：文件路径。
 * 输出：条目数组；空行被过滤，行序保持。
 * 副作用：读文件。
 * 失败语义：任一行解析失败时抛带 `文件:行号` 的 Error，并保留原始 cause。
 */
async function readTrajectoryJsonl(inputPath: string): Promise<TrajectoryJsonlEntry[]> {
  const content = await readFile(inputPath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as TrajectoryJsonlEntry;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${basename(inputPath)}:${index + 1}`, { cause: error });
      }
    });
}

/**
 * 把条目按 requestIndex 归组为请求快照，并保持首次出现的顺序。
 * 输入：JSONL 条目；request 条目建立快照，message 条目按 messageIndex 填入或补录为 responses。
 * 输出：按请求时间序的快照数组。
 * 无文件副作用；消息均深拷贝。
 * 失败语义：message 引用了不存在的 requestIndex、或 messages 下标稀疏时抛 Error。
 */
function groupRequestSnapshots(entries: readonly TrajectoryJsonlEntry[]): RequestSnapshot[] {
  const snapshots = new Map<number, RequestSnapshot>();
  const orderedRequestIndexes: number[] = [];

  for (const entry of entries) {
    if (entry.kind === "request") {
      if (!snapshots.has(entry.requestIndex)) {
        orderedRequestIndexes.push(entry.requestIndex);
      }
      snapshots.set(entry.requestIndex, {
        bodyWithoutMessages: cloneJsonObject(entry.bodyWithoutMessages),
        messages: [],
        requestIndex: entry.requestIndex,
        responses: [],
      });
      continue;
    }

    const snapshot = snapshots.get(entry.requestIndex);
    if (!snapshot) {
      throw new Error(`Message entry references missing requestIndex ${entry.requestIndex}`);
    }

    if (entry.messageIndex === undefined) {
      // 无 messageIndex 表示请求结束后的补录回复，不属于请求快照本身。
      snapshot.responses.push(cloneMessage(entry.message));
      continue;
    }

    snapshot.messages[entry.messageIndex] = cloneMessage(entry.message);
  }

  return orderedRequestIndexes.map((requestIndex) => {
    const snapshot = snapshots.get(requestIndex);
    if (!snapshot) {
      throw new Error(`Missing request snapshot ${requestIndex}`);
    }
    if (snapshot.messages.some((message) => message === undefined)) {
      throw new Error(`Request ${requestIndex} has sparse message indexes`);
    }
    return snapshot;
  });
}

/**
 * 以某个请求快照新建轨迹。
 * 输入：快照与起点原因。
 * 输出：requestCount=1、messages 与参数均为深拷贝的可变轨迹。
 * 无文件副作用；不追加 responses（由调用方随后 appendResponses）。
 */
function startTrajectory(
  snapshot: RequestSnapshot,
  reason: DerivedTrajectory["reason"],
): MutableTrajectory {
  return {
    bodyWithoutMessages: cloneJsonObject(snapshot.bodyWithoutMessages),
    lastRequestIndex: snapshot.requestIndex,
    messages: cloneMessages(snapshot.messages),
    reason,
    requestCount: 1,
  };
}

/**
 * 把补录回复追加到轨迹尾部。
 * 输入：可变轨迹与回复数组；逐个深拷贝后 push。
 * 无返回值；原地修改轨迹。
 * 不变量：回复总在请求快照之后，保持 assistant 紧随其请求的时序。
 */
function appendResponses(trajectory: MutableTrajectory, responses: readonly OpenAiMessage[]): void {
  trajectory.messages.push(...cloneMessages(responses));
}

/**
 * 冻结可变轨迹为输出结构。
 * 输入：可变轨迹、输出下标（0 基）与是否存在压缩轨迹。
 * 输出：DerivedTrajectory；id 为 4 位补零序号加原因后缀，index 为 1 基。
 * 无副作用；requestBody 由 createOpenAiRequestBody 深拷贝重建。
 * 不变量：无压缩时 initial 轨迹不带后缀；有压缩时首个轨迹标 -pre-compaction，避免重名。
 */
function freezeTrajectory(
  trajectory: MutableTrajectory,
  index: number,
  hasPostCompaction: boolean,
): DerivedTrajectory {
  const prefix = String(index + 1).padStart(4, "0");
  // 首个轨迹若后续发生了压缩，需补后缀，才能与压缩后新建的轨迹区分开。
  const suffix =
    trajectory.reason === "initial"
      ? hasPostCompaction && index === 0
        ? "-pre-compaction"
        : ""
      : `-${trajectory.reason}`;

  return {
    id: `${prefix}${suffix}`,
    index: index + 1,
    lastRequestIndex: trajectory.lastRequestIndex,
    reason: trajectory.reason,
    requestBody: createOpenAiRequestBody(trajectory),
    requestCount: trajectory.requestCount,
  };
}

/**
 * 由可变轨迹重建 OpenAI 请求体。
 * 输入：可变轨迹。
 * 输出：新请求体；model、messages、tools 置前，其余参数按原顺序追加。
 * 无副作用；messages 与参数均深拷贝。
 * 不变量：messages 取累积历史，而不是最后一次请求的原始数组。
 */
function createOpenAiRequestBody(
  trajectory: MutableTrajectory,
): JsonObject & { messages: OpenAiMessage[] } {
  const bodyWithoutMessages = cloneJsonObject(trajectory.bodyWithoutMessages);
  const {
    model,
    messages: _messages,
    tool_choice: _toolChoice,
    tools,
    ...rest
  } = bodyWithoutMessages;
  const requestBody: JsonObject & { messages: OpenAiMessage[] } = {
    ...(model !== undefined ? { model } : {}),
    messages: cloneMessages(trajectory.messages),
    ...(tools !== undefined ? { tools } : {}),
  };

  for (const [key, value] of Object.entries(rest)) {
    // 其余参数按原顺序追加，保证同一输入产出稳定字段顺序，便于跨版本 diff。
    requestBody[key] = value;
  }

  return requestBody;
}

/**
 * 把轨迹转换为 Anthropic 风格请求体。
 * 输入：冻结轨迹（含 requestBody）或可变轨迹（含 messages 与 bodyWithoutMessages）。
 * 输出：新请求体；system 提升为顶层 blocks，连续 user 合并，工具参数原样保留。
 * 副作用：无；所有源数据深拷贝，不修改入参。
 * 失败语义：不抛错；非预期 content 形状按文本提取，提取不到则置空。
 * 不变量：已有顶层 system 时不再从 messages 二次提升，避免重复与角色错位。
 */
export function createAnthropicRequestBody(
  trajectory: DerivedTrajectory | MutableTrajectory,
): JsonObject & { messages: OpenAiMessage[] } {
  const sourceBody =
    "requestBody" in trajectory ? trajectory.requestBody : trajectory.bodyWithoutMessages;
  const sourceMessages =
    "requestBody" in trajectory ? trajectory.requestBody.messages : trajectory.messages;
  const bodyWithoutMessages = cloneJsonObject(sourceBody);
  const {
    model,
    messages: _messages,
    system,
    tools,
    tool_choice: toolChoice,
    ...rest
  } = bodyWithoutMessages;
  const systemBlocks = normalizeAnthropicContentBlocks(system);
  // MCS 下真实 Anthropic body 的 messages 可以保留 role:system，已有顶层 system 时不能再二次提升。
  const messages =
    system !== undefined
      ? sourceMessages.map(toAnthropicProviderMessage)
      : toAnthropicMessages(sourceMessages, systemBlocks);
  const requestBody: JsonObject & { messages: OpenAiMessage[] } = {
    ...(model !== undefined ? { model } : {}),
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };

  for (const [key, value] of Object.entries(rest)) {
    requestBody[key] = value;
  }

  return requestBody;
}

/**
 * 把单条消息转换为 Anthropic provider 形状。
 * 输入：OpenAI 风格消息。
 * 输出：深拷贝消息；非 system 的 content 统一为 block 数组；
 * system 若为单个纯文本 block 则投影为字符串。
 * 副作用：无；不修改入参。
 * 用途：仅在已有顶层 system 时使用，避免角色重复提升。
 */
function toAnthropicProviderMessage(message: OpenAiMessage): OpenAiMessage {
  const clonedMessage = cloneMessage(message);
  if (message.role !== "system") {
    return {
      ...clonedMessage,
      content: normalizeAnthropicContentBlocks(message.content),
    };
  }

  const text = singlePlainTextBlock(message.content);
  // 通用 model-io artifact 必须保留录制 shape；只有生成 Anthropic
  // provider artifact 时，才复现最终 fetch boundary 的 MCS string 投影。
  return text === undefined ? clonedMessage : { ...clonedMessage, content: text };
}

/**
 * 判断 content 是否为单个“纯文本”块。
 * 输入：任意 content 值。
 * 输出：文本字符串，或 undefined（不满足投影条件）。
 * 口径：数组长度恰为 1，块只含 type="text" 与 text 字段，出现其他键即不匹配。
 * 无副作用；用于决定 system 消息是否做 MCS string 投影。
 */
function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = value[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return undefined;
  if (Object.keys(record).some((key) => key !== "type" && key !== "text")) return undefined;
  return record.text;
}

/**
 * 把 OpenAI 消息序列转换为 Anthropic 序列。
 * 输入：消息数组与可变的 system 目标数组。
 * 输出：新数组；system 消息被提升进 systemBlocks，其余消息保留顺序。
 * 副作用：向传入的 systemBlocks push；调用方必须传新数组，避免污染原值。
 * 不变量：消息本身逐条深拷贝后再归一化 content。
 */
function toAnthropicMessages(
  messages: readonly OpenAiMessage[],
  systemBlocks: unknown[],
): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemBlocks.push(...normalizeAnthropicContentBlocks(message.content));
      continue;
    }

    const next: OpenAiMessage = {
      ...cloneMessage(message),
      content: normalizeAnthropicContentBlocks(message.content),
    };
    const previous = result.at(-1);
    // Anthropic 要求 user/assistant 交替；相邻 user 必须合并，否则请求会被 provider 拒绝。
    if (previous?.role === "user" && next.role === "user") {
      previous.content = [
        ...normalizeAnthropicContentBlocks(previous.content),
        ...normalizeAnthropicContentBlocks(next.content),
      ];
      continue;
    }
    result.push(next);
  }

  return result;
}

/**
 * 把任意 content 归一化为 Anthropic block 数组。
 * 输入：undefined/null、字符串、数组或其他对象。
 * 输出：新数组；字符串转单个 text block，空字符串返回空数组，数组深拷贝，
 * 其他对象按文本提取后再包装。
 * 无副作用；任何输入都不抛错。
 */
function normalizeAnthropicContentBlocks(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.length > 0 ? [{ type: "text", text: value }] : [];
  if (Array.isArray(value)) return JSON.parse(JSON.stringify(value)) as unknown[];

  const text = messageText(value);
  return text.length > 0 ? [{ type: "text", text }] : [];
}

/**
 * 判断消息历史中是否出现压缩摘要。
 * 输入：消息数组。
 * 输出：布尔值；任一消息文本命中任一压缩摘要前缀即为 true。
 * 口径：按拼接后的全文做 includes，允许前缀出现在正文中间。
 */
function containsCompactSummary(messages: readonly OpenAiMessage[]): boolean {
  return messages.some((message) => {
    const text = messageText(message);
    return COMPACT_SUMMARY_PREFIXES.some((prefix) => text.includes(prefix));
  });
}

/**
 * 递归提取值中的可读文本。
 * 输入：字符串、数组或对象。
 * 输出：以换行拼接的文本；无可提取内容时为空串。
 * 口径：对象只取 text 与 content 字段，避免把 ID、类型等元数据误当正文。
 * 无副作用；不抛错。
 */
function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map(messageText).join("\n");
  }
  const record = value as Record<string, unknown>;
  return [record.text, record.content].map(messageText).join("\n");
}

/**
 * 逐条深拷贝消息数组。
 * 输出新数组；元素互不共享引用，避免下游修改污染原始条目。
 */
function cloneMessages(messages: readonly OpenAiMessage[]): OpenAiMessage[] {
  return messages.map(cloneMessage);
}

/**
 * 深拷贝单条消息。
 * 口径：JSON 序列化往返，仅适用于纯 JSON 数据；undefined 字段会被丢弃。
 */
function cloneMessage(message: OpenAiMessage): OpenAiMessage {
  return JSON.parse(JSON.stringify(message)) as OpenAiMessage;
}

/**
 * 深拷贝 JSON 对象。
 * 口径：JSON 序列化往返；调用方需保证对象可序列化（无循环引用、无函数）。
 */
function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
