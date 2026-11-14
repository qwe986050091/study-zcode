/**
 * ReadSessionContext 的本地实现：从已持久化的 session 消息里挑出与 query 相关的内容，
 * 组装成给模型阅读的 transcript 片段。纯内存计算，不读盘、不写盘、不发事件。
 * 两种策略：handoff 取最近的消息（适合交接），relevance 按关键词打分取相关消息。
 * 输出有三个粒度：allContent（全量，用于统计）、localContent（受预算裁剪，注入模型）、
 * chunks（分块，供上层按需二次选择）。truncated 是统一的"有内容被裁掉"信号。
 * 失败语义：不抛错；空 session 或不可读消息返回空内容与计数 0，由调用方决定如何提示。
 */

// 职责边界（read-session-context）：把已落盘的 session 消息装配成模型可读的 transcript 片段。
// 纯内存计算，不读盘、不写盘、不发事件；失败语义是返回空内容与零计数，绝不抛错。
//
// INV 不变量表（18 条；每条都是看起来能改、一动就出用户可见故障的约束）
// INV-01 输出结构固定为素材的十项，全量与裁剪版同时给出；守住位置：SessionContextMaterial 接口；改错故障：上层读不到 localContent 或 references，注入模型的上下文变空。
// INV-02 预算下限 4000 上限 48000，任何输入都夹在区间内；守住位置：clampOutputCharBudget；改错故障：传 0 时上下文被清空，传超大值时把整段 transcript 塞爆窗口。
// INV-03 非法预算（undefined、NaN、Infinity）回落默认 24000 而非抛错；守住位置：clampOutputCharBudget 首个分支；改错故障：调用方少传参数就读取失败，整轮对话没有可用上下文。
// INV-04 逐条消息读取不抛错，不可读的条目直接剔除；守住位置：formatMessageSnippet 返回 null 的分支；改错故障：一条脏消息让整次读取崩溃，用户看到工具报错而非部分结果。
// INV-05 model-only 的 user 消息必须剔除，assistant 同标记保留；守住位置：visibility 判断；改错故障：系统注入的提醒被当成用户原话回灌，模型误判自己在被反复要求同一件事。
// INV-06 空 part 的消息不进入候选，去重后再判空；守住位置：partTexts 长度为 0 的早退；改错故障：只有时间戳的空壳消息占满预算，真正内容被裁掉。
// INV-07 排序分只在同分时才用 index 加权，且权重万分之一不改变主序；守住位置：scoreSnippets 的加分项；改错故障：权重放大后时间先后压过相关性，检索结果变成纯最近优先。
// INV-08 全量文本预算为正无穷，等同不裁剪；守住位置：buildSessionContextMaterial 的 allContent 调用；改错故障：全量版被预算截断，字符统计与 truncated 判定同时失真。
// INV-09 truncated 三条件取或：被筛掉、被裁掉、超预算；守住位置：返回值里的 truncated 表达式；改错故障：漏判任一条都会把不完整报成完整，模型据此做出错误取舍。
// INV-10 handoff 从尾部倒序取，relevance 按分数取，两条路径互不复用；守住位置：selectSnippets 的策略分支；改错故障：交接场景丢掉最近对话，模型接不上刚才的工作。
// INV-11 尾部裁剪至少保留一条，即使单条就超预算；守住位置：selectTailWithinBudget 的非空判断；改错故障：预算极小时返回空数组，交接结果为空但状态仍报成功。
// INV-12 relevance 无命中时回退最近 12 条，不返回空；守住位置：positives 为空的三元；改错故障：生僻提问拿到空上下文，模型只能回答没找到。
// INV-13 选中结果最后按原始 index 升序重排，不按分数输出；守住位置：selectSnippets 末尾排序；改错故障：正文顺序被打乱，时间线错位导致模型把因果搞反。
// INV-14 分块按 28000 字符切，累计超限前先封口再开新块；守住位置：buildTranscriptChunks 的封口判断；改错故障：单块超限后触发下游截断，块边界与消息边界错开。
// INV-15 块数与选择上限为 5，relevance 恒保最后一块；守住位置：selectChunks 与 MAX_LITE_CHUNKS；改错故障：最新工作进行中的状态被挤出，模型丢失当前任务锚点。
// INV-16 块选择用 Map 按 index 去重后再按 index 还原顺序；守住位置：selectChunks 的 selected 汇总；改错故障：最后一块与高分块重复，token 被同一内容吃掉两遍。
// INV-17 正文拼接按 header 长度扣减剩余预算，剩余不足 200 字符只截一次即停；守住位置：formatSessionTranscript 的循环；改错故障：头部挤占正文预算，或反复追加碎片产生大段无意义残句。
// INV-18 not_found 输出结构与成功分支对齐，计数全 0、source 为 none；守住位置：formatLocalSessionNotFound；改错故障：上层按成功结构取值拿到 undefined，提示文案拼出 null。
//
// 总述：读取不抛错、预算必夹紧、truncated 三条件取或，是这份文件的三根承重柱。
// 总述：改排序或改预算前先想清楚 truncated 会不会漏判，那是唯一会骗到模型的信号。
//
import {
  type MessageWithParts,
  type ReadSessionContextInput,
  type ReadSessionContextOutput,
  type ReadSessionContextReference,
  type SessionInfo,
} from "@zcode/contracts";
import { activeSessionMessages } from "../agent/session-history-hydrator.js";
import { dedupeParts, formatPartForContext } from "./parts.js";
import { truncateText } from "./utils.js";
export {
  buildReferencedSessionContextReminderBody,
  extractSessionReferences,
} from "./references.js";

// 预算三兄弟：默认 24000、硬上限 48000，单位是字符而非 token。
// DEFAULT_OUTPUT_CHAR_BUDGET 只在调用方没给预算时兜底，显式值一律过 clampOutputCharBudget 夹紧。
// [权衡] 上限 48000 是按上下文窗口留出系统提示与回答空间后倒推的经验值。
const DEFAULT_OUTPUT_CHAR_BUDGET = 24_000;
const MAX_OUTPUT_CHAR_BUDGET = 48_000;
// lite 模式输入上限 80000 字符，比输出预算宽松，因为这里限的是输入素材。
// 收敛为函数而非直接导出常量，避免上层绕过语义去改数字。
const MAX_LITE_INPUT_CHARS = 80_000;
const MAX_LITE_CHUNKS = 5;
// 单块 28000 字符是块粒度上限，与输出预算同量级但用途不同。
// [资源] 块太大则选择粒度变粗，太小则块头开销与引用重复变多。
const MAX_CHUNK_CHARS = 28_000;

// 上下文素材的统一产出结构：同时给出"全量"与"按预算裁剪"两版内容，
// 并保留选中消息的 references 供上层回链到原始 messageId。
// 约定：selectedMessageCount / readableMessageCount 用于解释裁剪比例，不做二次重算。
// 对外唯一素材结构：全量、裁剪版、分块三份视图同源一次装配。
// selectedMessageCount 与 readableMessageCount 只用于解释裁剪比例，不做二次重算。
// [权衡] 同时返回三份文本有内存冗余，换来上层不必重跑打分。
export interface SessionContextMaterial {
  allContent: string;
  allContentChars: number;
  chunks: TranscriptChunk[];
  localContent: string;
  messageCount: number;
  readableMessageCount: number;
  references: ReadSessionContextReference[];
  selectedChunks: TranscriptChunk[];
  selectedMessageCount: number;
  truncated: boolean;
}

// transcript 分块：按字符上限把连续消息切成块，块内保留消息区间与聚合分数。
// index 即块序号（从 0 递增），与 start/endMessageIndex 构成稳定定位，可跨调用复用。
// 分块保留消息区间与聚合分数，index 从 0 递增且跨调用稳定。
// start 与 end 是消息原始下标，不是块内偏移，供上层回链定位。
export interface TranscriptChunk {
  index: number;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

interface MessageSnippet {
  index: number;
  role: "user" | "assistant";
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

// 一次读取的核心装配：过滤不可读消息 → 打分 → 生成全量文本 / 分块 / 按预算裁剪的本地文本。
// outputCharBudget 会被 clamp 到 [4000, 48000]，避免调用方传入 0 或超大数据撑爆上下文。
// 无副作用；同一输入重复调用结果稳定，score 中的 index/10000 只用于同分时偏好较新消息。
// truncated 的判定合并三种情况：消息被筛掉、内容被预算裁掉、全量超过预算。
// 一次读取的主装配：过滤 → 打分 → 全量文本 → 分块 → 预算选择，顺序不可换。
// outputCharBudget 先经 clampOutputCharBudget 夹紧再下传，后续裁剪都以夹紧值为准。
// [并发] 无共享状态，同一输入重复调用结果一致，可安全并行。
export function buildSessionContextMaterial(input: {
  messages: MessageWithParts[];
  query: string;
  session: SessionInfo;
  strategy: ReadSessionContextInput["strategy"];
  outputCharBudget?: number;
}): SessionContextMaterial {
  const outputCharBudget = clampOutputCharBudget(input.outputCharBudget);
  const activeMessages = activeSessionMessages(input.messages);
  // 先取活跃消息再逐条格式化，被会话历史层判定为失效的消息此前已剔除。
  // 格式化返回 null 的条目在此静默丢弃，不中断整批读取。
  const snippets = activeMessages
    .map((message, index) => formatMessageSnippet(message, index))
    .filter((snippet): snippet is MessageSnippet => snippet !== null);
  const scoredSnippets = scoreSnippets(snippets, input.query);
  const allContent = formatSessionTranscript(input.session, scoredSnippets, {
    budgetChars: Number.POSITIVE_INFINITY,
    heading: "Cleaned transcript",
    query: input.query,
    strategy: input.strategy,
  });
  const chunks = buildTranscriptChunks(scoredSnippets);
  const selectedChunks = selectChunks(chunks, input.strategy);
  const selectedSnippets = selectSnippets(scoredSnippets, input.strategy, outputCharBudget);
  const localContent = formatSessionTranscript(input.session, selectedSnippets, {
    budgetChars: outputCharBudget,
    heading: localHeading(input.strategy),
    query: input.query,
    strategy: input.strategy,
  });

  return {
    allContent,
    allContentChars: allContent.length,
    chunks,
    localContent,
    messageCount: activeMessages.length,
    readableMessageCount: scoredSnippets.length,
    references: selectedSnippets.flatMap((snippet) => snippet.references),
    selectedChunks,
    selectedMessageCount: selectedSnippets.length,
    truncated:
      // 三个条件任一成立即视为被裁剪：消息被筛、正文被裁、全量超预算。
      // [失败路径] 任一条漏判都会把不完整报成完整，模型据此做出错误取舍。
      selectedSnippets.length < scoredSnippets.length ||
      allContent.length > localContent.length ||
      allContent.length > outputCharBudget,
  };
}

// 把工具输出渲染成模型可读文本：按 status 三态给出不同措辞（not_found / failed / success）。
// 成功分支会补充 title、truncated 与 nextCursor 提示，帮助模型自行决定是否续读。
// 纯文本拼接，无副作用；error 为空时自动省略该行，避免出现 "Error: undefined"。
// 把结构化输出渲染成模型可读文本，按 status 三态给不同措辞。
// 成功分支补 title、truncated、nextCursor 提示，让模型自己决定是否续读。
export function formatReadSessionContextModelContent(output: ReadSessionContextOutput): string {
  if (output.status === "not_found") {
    return `Session ${output.sessionId} was not found.`;
  }
  // 失败分支把 error 与 content 一起拼出，error 为空时该行自动省略。
  // [失败路径] 省略空 error 是为了避免出现 Error: undefined 这种误导文本。
  if (output.status === "failed") {
    return [
      `ReadSessionContext failed for ${output.sessionId}.`,
      output.error ? `Error: ${output.error}` : undefined,
      output.content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `ReadSessionContext returned ${output.source} context for ${output.sessionId}.`,
    output.title ? `Title: ${output.title}` : undefined,
    output.truncated ? "The returned context is truncated." : undefined,
    output.nextCursor !== undefined
      ? `More matches: call again with cursor=${output.nextCursor}.`
      : undefined,
    "",
    output.content,
  ]
    .filter(Boolean)
    .join("\n");
}

// 构造 not_found 输出：source 固定为 none、计数全 0，保证调用方读到的结构与成功分支对齐。
// 不抛错也不写盘；query/strategy 原样回填，便于上层在提示里复述用户意图。
// 缺失会话不抛错，返回结构与成功分支对齐、计数全 0、source 为 none。
// query 与 strategy 原样回填，上层可直接复述用户意图。
export function formatLocalSessionNotFound(input: {
  query: string;
  sessionId: string;
  strategy: ReadSessionContextInput["strategy"];
}): ReadSessionContextOutput {
  return {
    status: "not_found",
    sessionId: input.sessionId,
    strategy: input.strategy,
    query: input.query,
    source: "none",
    content: `No persisted session was found for ${input.sessionId}.`,
    messageCount: 0,
    selectedMessageCount: 0,
    truncated: false,
  };
}

// 按 4 字符≈1 token 的粗略换算把输出 token 上限折算成字符预算，并复用同一套 clamp。
// maxTokens 缺省时用默认预算；换算只是估值，不做精确 tokenizer 对齐。
// 按 4 字符约 1 token 的粗算把 token 上限折成字符预算。
// [权衡] 只是估值，不做 tokenizer 精确对齐，宁可略保守也别溢出窗口。
export function outputCharBudgetFromMaxTokens(maxTokens: number | undefined): number {
  if (maxTokens === undefined) return DEFAULT_OUTPUT_CHAR_BUDGET;
  return clampOutputCharBudget(maxTokens * 4);
}

// lite 模式的输入字符上限：把常量收敛为函数，方便上层在不改常量的前提下按需读取。
export function liteInputCharBudget(): number {
  return MAX_LITE_INPUT_CHARS;
}

// lite 模式最多回传的块数；与 selectChunks 的截断口径保持一致，避免两处常量漂移。
export function maxLiteChunks(): number {
  return MAX_LITE_CHUNKS;
}

// 单条消息渲染成带序号、角色、id 与创建时间的文本块。
// searchText 额外拼角色名并转小写，供关键词打分复用同一份内容。
function formatMessageSnippet(message: MessageWithParts, index: number): MessageSnippet | null {
  // model-only 的 user 消息（系统注入/提醒）不是用户真实输入，读回来会污染上下文，
  // assistant 侧的同名可见性标记则允许保留，因为它是模型自身产出。
  // model-only 的 user 消息是系统注入，读回来会污染上下文，直接剔除。
  // [权衡] assistant 侧的同名标记保留，因为那是模型自己的产出。
  if (message.info.role === "user" && message.info.visibility === "model-only") {
    return null;
  }

  const partTexts = dedupeParts(message.parts)
    .map((part) => formatPartForContext(part))
    .filter((text): text is string => Boolean(text?.trim()));
  if (partTexts.length === 0) return null;

  const role = message.info.role;
  const body = partTexts.join("\n\n");
  const content = [
    `[${index + 1}] ${role} ${message.info.id}`,
    `created: ${new Date(message.info.time.created).toISOString()}`,
    body,
  ].join("\n");

  return {
    index,
    role,
    content,
    searchText: `${role}\n${body}`.toLowerCase(),
    score: 0,
    references: [
      {
        messageId: message.info.id,
        index,
        role,
      },
    ],
  };
}

function scoreSnippets(snippets: MessageSnippet[], query: string): MessageSnippet[] {
  const terms = tokenizeQuery(query);
  const normalizedQuery = query.trim().toLowerCase();
  return snippets.map((snippet) => ({
    ...snippet,
    score: scoreSearchText(snippet.searchText, normalizedQuery, terms) + snippet.index / 10000,
  }));
}

// 查询分词：拉丁词按字符类切，中文按连续汉字串切，长度小于 2 的丢弃。
// 结果用 Set 收敛重复词，避免同一词重复加分。
function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const matches = normalized.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const match of matches) {
    if (match.length < 2) continue;
    terms.add(match);
    // 中文没有空格分词，长于 2 字的连续汉字额外拆成二元组，避免整段匹配导致召回为 0。
    // 二元组会带来一定噪声，但打分只用于排序而非过滤，误召回仍有上限保护。
    // 中文没有空格分词，长于 2 字的汉字串额外拆二元组提升召回。
    // [权衡] 二元组带来噪声，但打分只用于排序，误召回仍有预算上限兜底。
    if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
      for (let index = 0; index < match.length - 1; index++) {
        terms.add(match.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function scoreSearchText(searchText: string, normalizedQuery: string, terms: string[]): number {
  let score = 0;
  if (normalizedQuery.length > 0 && searchText.includes(normalizedQuery)) {
    score += 20;
  }
  for (const term of terms) {
    if (!searchText.includes(term)) continue;
    score += 3 + Math.min(countOccurrences(searchText, term), 5);
  }
  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(term, offset);
    if (found < 0) return count;
    count++;
    offset = found + term.length;
  }
}

function selectSnippets(
  snippets: MessageSnippet[],
  strategy: ReadSessionContextInput["strategy"],
  budgetChars: number,
): MessageSnippet[] {
  if (snippets.length === 0) return [];
  if (strategy === "handoff") {
    return selectTailWithinBudget(snippets, budgetChars);
  }

  // 没有任何消息命中关键词时不让结果为空：退回最近 12 条，至少给模型一段可续接的最近上下文。
  // 分数阈值 3 对应"命中一个词"的基准分，低于它的消息属于弱相关，不进入候选池。
  // 阈值 3 对应命中一个词的基准分，低于它的消息不进候选池。
  // 无任何命中时回退最近 12 条，保证模型至少拿到可续接的上下文。
  const positives = snippets.filter((snippet) => snippet.score >= 3);
  const ranked = positives.length > 0 ? positives : snippets.slice(-12);
  const selected: MessageSnippet[] = [];
  let usedChars = 0;
  for (const snippet of [...ranked].sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (usedChars > budgetChars) break;
    selected.push(snippet);
    usedChars += snippet.content.length;
  }

  return selected.sort((a, b) => a.index - b.index);
}

function selectTailWithinBudget(snippets: MessageSnippet[], budgetChars: number): MessageSnippet[] {
  const selected: MessageSnippet[] = [];
  let usedChars = 0;
  for (let index = snippets.length - 1; index >= 0; index--) {
    const snippet = snippets[index]!;
    if (selected.length > 0 && usedChars + snippet.content.length > budgetChars) break;
    selected.push(snippet);
    usedChars += snippet.content.length;
  }
  return selected.reverse();
}

// 按字符上限把连续消息切成块，当前块非空且再加就超限时先封口。
// 循环结束后残余消息单独成块，不留半个块在缓冲里。
function buildTranscriptChunks(snippets: MessageSnippet[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let current: MessageSnippet[] = [];
  let currentChars = 0;

  for (const snippet of snippets) {
    if (current.length > 0 && currentChars + snippet.content.length > MAX_CHUNK_CHARS) {
      chunks.push(createChunk(chunks.length, current));
      current = [];
      currentChars = 0;
    }
    current.push(snippet);
    currentChars += snippet.content.length;
  }

  if (current.length > 0) {
    chunks.push(createChunk(chunks.length, current));
  }

  return chunks;
}

function createChunk(index: number, snippets: MessageSnippet[]): TranscriptChunk {
  const content = snippets.map((snippet) => snippet.content).join("\n\n---\n\n");
  return {
    index,
    startMessageIndex: snippets[0]!.index,
    endMessageIndex: snippets[snippets.length - 1]!.index,
    messageCount: snippets.length,
    content,
    searchText: snippets.map((snippet) => snippet.searchText).join("\n"),
    score: snippets.reduce((sum, snippet) => sum + snippet.score, 0),
    references: snippets.flatMap((snippet) => snippet.references),
  };
}

// 块数未超上限时全量返回，handoff 直接取尾部若干块。
// relevance 按分数取前几块，最后一块无论分数都保留。
function selectChunks(
  chunks: TranscriptChunk[],
  strategy: ReadSessionContextInput["strategy"],
): TranscriptChunk[] {
  if (chunks.length <= MAX_LITE_CHUNKS) return chunks;
  if (strategy === "handoff") return chunks.slice(-MAX_LITE_CHUNKS);

  // relevance 策略永远保留最后一块：它包含当前工作进行中的最新状态，
  // 即使分数不高也不能丢，否则模型会失去"正在做什么"的锚点。用 Map 去重后按 index 还原顺序。
  const byScore = [...chunks].sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Map<number, TranscriptChunk>();
  for (const chunk of byScore.slice(0, MAX_LITE_CHUNKS - 1)) {
    selected.set(chunk.index, chunk);
  }
  selected.set(chunks[chunks.length - 1]!.index, chunks[chunks.length - 1]!);
  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function formatSessionTranscript(
  session: SessionInfo,
  snippets: MessageSnippet[],
  options: {
    budgetChars: number;
    heading: string;
    query: string;
    strategy: ReadSessionContextInput["strategy"];
  },
): string {
  const header = [
    `# ${options.heading}`,
    `Session: ${session.title} (${session.id})`,
    `Directory: ${session.directory}`,
    session.path ? `Path: ${session.path}` : undefined,
    `Strategy: ${options.strategy}`,
    `Query: ${options.query}`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  if (snippets.length === 0) {
    return `${header}No readable transcript content was found in the target session.`;
  }

  let remaining = Number.isFinite(options.budgetChars)
    ? Math.max(0, options.budgetChars - header.length)
    : Number.POSITIVE_INFINITY;
  const body: string[] = [];
  for (const snippet of snippets) {
    const separator = body.length > 0 ? "\n\n---\n\n" : "";
    const next = separator + snippet.content;
    if (Number.isFinite(remaining) && next.length > remaining) {
      // 剩余预算还够 200 字符才追一次截断片段，否则宁可不追加。
      // [权衡] 过短的残片信息量近似噪声，会挤占模型注意力。
      if (remaining > 200) {
        body.push(truncateText(next, remaining));
      }
      break;
    }
    body.push(next);
    remaining -= next.length;
  }

  return `${header}${body.join("")}`;
}

function localHeading(strategy: ReadSessionContextInput["strategy"]): string {
  return strategy === "handoff" ? "Recent session handoff context" : "Relevant session context";
}

// 预算夹紧到 [4000, 48000]：下限保证至少能放下几条消息，上限防止一次性把超长 transcript 塞进上下文。
// 非法值（undefined/NaN/Infinity）回落到默认预算，而不是抛错中断读取。
// 预算夹到 4000 到 48000 之间，先向下取整再夹。
// 非法值回落默认预算而不抛错，读取流程不会因参数问题中断。
function clampOutputCharBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OUTPUT_CHAR_BUDGET;
  return Math.max(4000, Math.min(MAX_OUTPUT_CHAR_BUDGET, Math.floor(value)));
}
