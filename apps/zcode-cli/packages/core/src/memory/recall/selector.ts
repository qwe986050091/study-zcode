// ============================================================
// memory/recall/selector —— 用辅助模型挑选相关记忆文件
// ============================================================
//
// 【定位】Semantic Recall 的“选择”一步：把 manifest 与最近一条真实用户查询
//   交给辅助模型，返回最多 5 个 filename；不读正文、不注入上下文。
//
// 【读写边界】不碰文件系统；只调用 model.generateText。
// 【失败语义】fail closed：无 manifest、全部已召回、abort、JSON 解析失败、
//   调用抛错，统统返回空结果，绝不回退到“随便召回几篇”。
// 【粘性对话口径】selectorMessages 保存“manifest + 历史 query/response”，
//   后续查询沿用同一选择上下文；但 abort 后的迟到响应不得写入其中。
// 【与 content 的衔接】selectedMemories 是 manifest.filename；未知项与
//   已读/已召回项会在 filterMemorySelections 中丢弃。
// ============================================================
import {
  modelMessageContentToText,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
} from "@zcode/contracts";

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import { formatMemoryManifest } from "./manifest.js";
import type { MemoryManifestEntry, MemoryRecallState, MemorySelectorResult } from "./types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";

// 系统提示词：最多 5 条、只在“确定有用”时选择；对 [user]/[project] 更保守，
// 避免“用户做过 DB 性能”这类画像被 “performance” 关键词误召回；
// 同时要求不重复选择本会话已返回过的记忆。
const MEMORY_SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
`;

// 响应 schema：selected_memories 必填字符串数组；selected_knowledge_ids 可选占位。
// additionalProperties=false 防止模型夹带额外字段，parseSelectorResponse 也会二次校验。
const MEMORY_SELECTOR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    selected_memories: {
      type: "array",
      items: { type: "string" },
    },
    selected_knowledge_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["selected_memories"],
  additionalProperties: false,
} as const;

// 空结果常量；emptySelectorResult 返回浅拷贝，避免调用方修改共享数组。
const EMPTY_SELECTOR_RESULT: MemorySelectorResult = {
  selectedKnowledgeIds: [],
  selectedMemories: [],
};

/**
 * 从运行消息历史里倒序查找最近一条可用于召回查询的用户文本。
 * 输入：RuntimeMessageEntry 列表（含 attachment 与 meta 消息）。
 * 输出：查询字符串；找不到时 undefined。
 * 副作用：无。
 * 失败语义：不抛错；无法转换为文本的消息按空串参与返回（由 eligible 判定过滤）。
 * 不变量：跳过 attachment、非 user、带 toolCallId/toolName 的消息；
 *   metadata.source 必须是 real_user，没有 metadata 的旧历史才允许按前缀兜底。
 */
export function findLatestMemoryRecallQuery(
  entries: readonly RuntimeMessageEntry[],
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    // attachment 是本会话注入的召回正文或其它附件，不是用户新输入。
    if (entry.kind === "attachment") continue;
    if (entry.message.role !== "user") continue;
    // tool 结果也可能伪装成 user role，带 toolCallId/toolName 的直接排除。
    if (entry.message.toolCallId || entry.message.toolName) continue;
    const text = modelMessageContentToText(entry.message.content);
    // 修复原因：显式 real_user 已经是非 meta 的事实来源，文本前缀只用于兼容缺少 metadata 的旧历史。
    if (entry.metadata) {
      if (entry.metadata.source !== "real_user") continue;
    } else if (text.trimStart().startsWith("<system-reminder>")) {
      continue;
    }
    return text;
  }
  return undefined;
}

/**
 * 判断查询是否值得调用选择器（类型守卫：true 时 query 收窄为 string）。
 * 口径：去空白后必须至少包含一个空白字符；单 token（如 “继续”）不足以判断相关性。
 */
export function isMemoryRecallQueryEligible(query: string | undefined): query is string {
  if (!query) return false;
  return /\s/u.test(query.trim());
}

/**
 * 构造选择器请求（system + 粘性对话 + 当前查询）。
 * 输入：query 与会话 state（读 selectorMessages / manifest）。
 * 输出：ModelRequest，带 responseJsonSchema 与 ephemeral 缓存标记。
 * 副作用：无（不发请求）。
 * 不变量：第一条 system 与 manifest 消息带 cacheControl=ephemeral，
 *   多次查询可复用前缀缓存；当前查询消息也标记，便于下一轮继续复用。
 */
export function buildMemorySelectorRequest(input: {
  query: string;
  state: MemoryRecallState;
}): ModelRequest {
  const conversation = selectorConversation(input.state);
  return {
    messages: [
      {
        role: "system",
        content: MEMORY_SELECTOR_SYSTEM_PROMPT,
        cacheControl: { type: "ephemeral" },
      },
      ...conversation,
      {
        role: "user",
        content: `Select memories relevant to:\n${input.query}`,
        cacheControl: { type: "ephemeral" },
      },
    ],
    responseJsonSchema: MEMORY_SELECTOR_RESPONSE_SCHEMA,
  };
}

/**
 * 调用辅助模型执行一次记忆选择。
 * 输入：Model、query、会话 state、可选 abortSignal。
 * 输出：MemorySelectorResult；任何失败/跳过都返回空结果。
 * 副作用：调用模型；成功且未 abort 时更新 state.selectorMessages。
 * 失败语义：不抛错——模型错误、JSON 不合法、schema 不符都降级为空结果（fail closed）。
 * 不变量：abort 后不写粘性对话，避免迟到的 provider 响应污染下一次选择；
 *   只选择 manifest 中存在的 filename 由后续 filter 负责，本函数不校验存在性。
 */
export async function runMemorySelector(input: {
  model: Model;
  query: string;
  state: MemoryRecallState;
  abortSignal?: AbortSignal;
}): Promise<MemorySelectorResult> {
  // 没有 manifest 就没有可选对象；不把“空记忆”当成模型失败去重试。
  if (!input.state.manifest || input.state.manifest.length === 0) {
    return emptySelectorResult();
  }
  // 所有文件都已召回：再调选择器必然返回空/重复项，直接省掉一次模型成本。
  if (input.state.manifest.every((entry) => input.state.recalledPaths.has(entry.filePath))) {
    return emptySelectorResult();
  }

  try {
    const request = buildMemorySelectorRequest(input);
    request.abortSignal = input.abortSignal;
    request.options = { ...request.options, ...auxiliaryModelOptions(input.model) };
    const response = await input.model.generateText(request);
    // 修复原因：provider 可能忽略 abort 并返回迟到结果；已取消的 selector 不能污染 sticky conversation。
    if (input.abortSignal?.aborted) return emptySelectorResult();
    const parsed = parseSelectorResponse(response.text);
    if (!parsed) return emptySelectorResult();

    // 只有解析成功才写粘性对话：后续轮次依赖“历史 query/response”保持选择口径一致。
    const conversation = selectorConversation(input.state);
    input.state.selectorMessages = [
      ...conversation,
      { role: "user", content: `Select memories relevant to:\n${input.query}` },
      { role: "assistant", content: response.text },
    ];
    return parsed;
  } catch {
    // 选择器是增强能力：模型/网络故障不能冒泡成对话错误，只能退化为“本轮无召回”。
    return emptySelectorResult();
  }
}

/**
 * 把模型选择的 filename 过滤成可读取的 manifest 条目。
 * 输入：manifest、当前 readFileState（已读文件）、已召回路径、选中 filename。
 * 输出：去重后、最多 5 条、按模型选择顺序排列的 manifest 条目。
 * 副作用：无。
 * 失败语义：不抛错；未知 filename、已读文件、已召回文件直接丢弃。
 * 不变量：已读文件不再召回（模型已在上下文里看到最新内容）；
 *   已召回文件不重复注入；截断在过滤之后，保证返回数量是真的可用条目。
 */
export function filterMemorySelections(input: {
  manifest: readonly MemoryManifestEntry[];
  readFileState?: ReadFileStateMap;
  recalledPaths: ReadonlySet<string>;
  selectedFilenames: readonly string[];
}): MemoryManifestEntry[] {
  const byFilename = new Map(input.manifest.map((entry) => [entry.filename, entry]));
  return input.selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((entry): entry is MemoryManifestEntry => entry !== undefined)
    .filter((entry) => !findLatestReadFileState(input.readFileState, entry.filePath))
    .filter((entry) => !input.recalledPaths.has(entry.filePath))
    .slice(0, 5);
}

/**
 * 取选择器的粘性对话；没有缓存时用 manifest 拼第一条 “Available memories” 消息。
 * 与 manifest.ts 的 createManifestMessage 同构，但此处不写缓存（只读视图）。
 */
function selectorConversation(state: MemoryRecallState): ModelInputMessage[] {
  if (state.selectorMessages) return state.selectorMessages;
  const manifest = state.manifest ?? [];
  return [
    {
      role: "user",
      content: `Available memories:\n${formatMemoryManifest(manifest)}`,
      cacheControl: { type: "ephemeral" },
    },
  ];
}

/**
 * 严格解析选择器响应（不信任 provider 的 schema 约束）。
 * 输入：模型返回的原始文本；输出：MemorySelectorResult 或 undefined。
 * 副作用：无。
 * 失败语义：JSON 解析错误会抛出（由 runMemorySelector 的 try/catch 兜底）；
 *   顶层非对象、出现未知字段、selected_memories 非字符串数组，都返回 undefined。
 * 不变量：只接受两个已知字段；selected_knowledge_ids 缺省时补空数组，
 *   保证返回值结构稳定，调用方无需再判空。
 */
function parseSelectorResponse(text: string): MemorySelectorResult | undefined {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return undefined;
  // 出现未知字段说明响应被注入或模型越界输出，整条丢弃而不是挑字段使用。
  if (
    Object.keys(parsed).some(
      (key) => key !== "selected_memories" && key !== "selected_knowledge_ids",
    )
  ) {
    return undefined;
  }
  if (!isStringArray(parsed.selected_memories)) return undefined;
  if (
    parsed.selected_knowledge_ids !== undefined &&
    !isStringArray(parsed.selected_knowledge_ids)
  ) {
    return undefined;
  }
  // 浅拷贝数组，避免把 provider 解析对象直接挂进会话粘性对话。
  return {
    selectedMemories: [...parsed.selected_memories],
    selectedKnowledgeIds: parsed.selected_knowledge_ids ? [...parsed.selected_knowledge_ids] : [],
  };
}

/**
 * 普通对象守卫：排除 null 与数组。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 字符串数组守卫：每一项都必须是 string，数字/嵌套对象一律拒绝。
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 返回空选择结果的独立副本。
 * 副作用：无；每次新建数组，调用方修改不会污染 EMPTY_SELECTOR_RESULT。
 */
function emptySelectorResult(): MemorySelectorResult {
  return {
    selectedKnowledgeIds: [...EMPTY_SELECTOR_RESULT.selectedKnowledgeIds],
    selectedMemories: [...EMPTY_SELECTOR_RESULT.selectedMemories],
  };
}
