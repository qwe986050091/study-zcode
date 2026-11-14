// ============================================================
// WebSearch 输出归一化：provider 原生搜索结果 → 契约输出 / 模型面文本
// ============================================================
// provider 的原生 search 结果形状随厂商与流式/非流式而变（toolResults 里的嵌套 content、
// sources 数组、或者只在 summary markdown 里出现引用），而 WebSearchOutput 是跨客户端稳定的
// 契约。这里做唯一的「宽进严出」转换：结果项与来源分别抽取、去重，再从多路来源里合并。
// 失败语义是**降级而非失败**——任何一路抽不出东西只是少一类来源，工具调用本身照常成功；
// 真正让调用失败的错误只会在 stream 层抛出（websearch.ts 的 error 事件）。
//
// 不变量：`results` 与 `sources` 中的 URL 在各自集合内大小写不敏感唯一；`summary` 里的
// markdown 链接是某些 provider 暴露引用的**唯一**通道，不能因为 sources 非空就跳过扫描。

import {
  WebSearchOutputSchema,
  modelMessageContentToText,
  type ModelSource,
  type ModelTextResult,
  type ModelToolResult,
  type ModelUsage,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchResultItem,
  type WebSearchSource,
} from "@zcode/contracts";

// 模型面最多列出的链接数。上限只作用于**展示**：完整 sources 仍留在结构化输出里，
// 客户端与遥测读全部，模型只看到前 N 条以免把一次搜索的引用全塞进上下文。
const MAX_SOURCE_LINKS = 20;

/**
 * 把一次原生搜索的结果收敛成 WebSearchOutput。
 *
 * 输入：`result` 是 provider 流式事件的聚合（text / toolResults / sources / usage），
 * `startedAt` 是调用方在请求前取的毫秒时间戳。
 * 输出：`query` 原样回填；`summary` 去空白后为空即省略（不是空字符串）；`durationMs` 是
 * **含网络请求**的墙钟耗时，不是 provider 侧耗时；`modelUsage` 只在至少有一个 token 字段
 * 存在时出现，否则省略，避免给「零用量」伪造一个对象。
 * 副作用：无。失败语义：不抛——抽取器对任何形状都返回空集，只有下游 schema 校验才会拒绝。
 */
export function buildWebSearchOutput(
  input: WebSearchInput,
  result: ModelTextResult,
  startedAt: number,
): WebSearchOutput {
  const results = dedupeResults(extractResults(result.toolResults));
  // trim 后为空就省略而不是留空串：模型面与展示侧都以「字段缺席」判断有没有摘要，
  // 空串会让它们渲染一个空的 Summary 标题。
  const summary = result.text.trim() || undefined;
  // 合并顺序决定去重后保留谁的 title：先到者胜，所以 provider 显式 sources 优先于
  // 从结果/工具结果回捞的副本，summary 里刮出来的链接只在其他通道都没有该 URL 时补位。
  const sources = dedupeSources([
    ...extractSourcesFromModelSources(result.sources),
    ...extractSourcesFromResults(results),
    ...extractSourcesFromToolResults(result.toolResults),
    ...extractSourcesFromSummary(summary),
  ]);
  const modelUsage = hasModelUsage(result.usage) ? result.usage : undefined;

  return {
    query: input.query,
    results,
    sources,
    summary,
    durationMs: Date.now() - startedAt,
    webSearchRequests: result.usage.serverToolUse?.webSearchRequests,
    modelUsage,
  };
}

/**
 * 把结构化输出渲染成模型可见文本。
 *
 * 输入是未经校验的 handler output：schema 失败时退回 JSON 文本而不是报错——结果通道必须
 * 给出**某个**可读内容，否则模型会收到一条空结果并可能误以为搜索没有发生。注意这里的
 * 退回路径不做截断，超大对象的截断由 executor 的结果预算统一负责。
 * 输出固定以 Sources 提醒结尾：这是工具契约的一部分（模型必须用 markdown 链接引用来源），
 * 不是可选润色。无副作用；链接超限只影响模型面，`output.sources` 不被修改。
 */
export function formatWebSearchModelContent(output: unknown): string {
  const parsed = WebSearchOutputSchema.safeParse(output);
  if (!parsed.success) return modelMessageContentToText(JSON.stringify(output) ?? "");

  const data = parsed.data;
  const links = dedupeSources([
    ...data.sources,
    ...extractSourcesFromResults(data.results),
  ]).slice(0, MAX_SOURCE_LINKS);
  const lines = [`Web search results for query: "${data.query}"`, ""];

  if (data.summary) {
    lines.push("Summary:", data.summary, "");
  }

  if (links.length > 0) {
    lines.push("Links:");
    for (const source of links) {
      lines.push(`- [${source.title ?? source.url}](${source.url})`);
    }
  } else {
    // 明确写出「没有链接」而不是省略 Links 段：模型需要能区分「搜索无结果」与
    // 「结果被上游剥掉了链接」，否则它会编造一个来源。
    lines.push("Links:", "- No links found.");
  }

  lines.push(
    "",
    "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
  );
  return lines.join("\n").trim();
}

// 结果抽取的入口：缺席的 toolResults 视为空集，不区分「provider 没给」与「给了一个空数组」。
function extractResults(toolResults: ModelToolResult[] | undefined): WebSearchResultItem[] {
  return (toolResults ?? []).flatMap((toolResult) => collectResults(toolResult.output));
}

// 递归下降：数组、`content` 容器、`sources` 容器都继续展开，只有携带 URL 的记录才算结果。
// 只接受 `type` 缺席 / `web_search_result` / `url` 的记录，是为了排除同一 payload 里的
// 非网页项（如 provider 自己的引用统计），避免把内部对象误当成搜索结果。
function collectResults(value: unknown): WebSearchResultItem[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectResults(item));
  if (!isRecord(value)) return [];

  const url = stringValue(value.url);
  const type = stringValue(value.type);
  if (url && (!type || type === "web_search_result" || type === "url")) {
    return [{ url, title: nullableString(value.title), pageAge: nullableString(value.pageAge) }];
  }

  if (Array.isArray(value.content)) {
    return value.content.flatMap((item) => collectResults(item));
  }
  if (Array.isArray(value.sources)) return value.sources.flatMap((source) => collectResults(source));
  return [];
}

// 只收 `sourceType === "url"`：同一个 ModelSource 联合里还有文档/文件类来源，
// 它们没有可点击 URL，混进 sources 会让模型面渲染出空链接。
function extractSourcesFromModelSources(sources: ModelSource[] | undefined): WebSearchSource[] {
  return (sources ?? [])
    .filter((source) => source.sourceType === "url" && typeof source.url === "string")
    .map((source) => ({ url: source.url!, title: source.title }));
}

// 结果项本身也是来源：provider 有时只给 results 不给 sources，这一路保证模型面仍有链接可引。
function extractSourcesFromResults(results: WebSearchResultItem[]): WebSearchSource[] {
  return results.map((result) => ({ url: result.url, title: result.title }));
}

// toolResults 与 results 是两套形状（后者已归一化），所以来源需要再走一遍宽松递归。
function extractSourcesFromToolResults(
  toolResults: ModelToolResult[] | undefined,
): WebSearchSource[] {
  return (toolResults ?? []).flatMap((toolResult) => collectSources(toolResult.output));
}

/**
 * 从 summary 的 markdown 正文里回捞引用。
 *
 * 这是**兜底通道**，不是主通道：改为流式后 provider 的引用有时只出现在 summary 文本里，
 * 不走 ModelStreamEvent 的 sources/toolResults。只接受 `http(s)` 绝对链接，且跳过前面带
 * `!` 的图片语法（`![alt](url)` 是配图而非引用，计入 sources 会污染模型面的参考列表）。
 * 副作用无；抽出的是 URL 子串，不做可达性校验。
 */
function extractSourcesFromSummary(summary: string | undefined): WebSearchSource[] {
  if (!summary) return [];

  // WebSearch 内部请求改为流式后，provider 的引用有时只出现在
  // summary markdown 中，而不会经过 ModelStreamEvent 暴露为 sources/toolResults。
  const sources: WebSearchSource[] = [];
  const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of summary.matchAll(markdownLinkPattern)) {
    // `![...](...)` 与 `[...](...)` 共用同一段匹配，靠前一个字符区分：`!` 说明是图片。
    if (match.index !== undefined && summary[match.index - 1] === "!") {
      continue;
    }
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!url) continue;
    sources.push({ url, title: title || undefined });
  }

  return sources;
}

// 宽松递归的第二个版本：只按「有 url 就是来源」判定，不查 type——来源集合允许比结果集合更宽，
// 否则 `type: "url"` 之外的合法引用会被静默丢掉。命中 url 后不再下钻，避免重复计数。
function collectSources(value: unknown): WebSearchSource[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectSources(item));
  if (!isRecord(value)) return [];

  const url = stringValue(value.url);
  if (url) return [{ url, title: nullableString(value.title) }];
  if (Array.isArray(value.content)) {
    return value.content.flatMap((item) => collectSources(item));
  }
  if (Array.isArray(value.sources)) return value.sources.flatMap((source) => collectSources(source));
  return [];
}

// URL 大小写不敏感去重：同一站点常以大小写变体出现两次，而模型面把它们当两条不同来源。
// 保留第一次出现的条目（含 title），后续副本丢弃。
function dedupeResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 与 dedupeResults 同一口径（小写 URL），因为 sources 就是由 results 与其他通道合并来的；
// 两处若用不同口径，同一条来源会在 results 里去重、在 sources 里重复。
function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 判断 usage 是否「有信息量」。provider 在纯搜索路径上可能给一个全空对象，把它写进输出会让
// 用量统计显示一次零消耗的模型调用；这里要求至少一个字段（含 serverToolUse 计数）存在。
function hasModelUsage(usage: ModelUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

// 空串按缺席处理（不是空字符串）：显示侧以 truthy 判断 title，空串会渲染出 `[]` 空标题。
function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
