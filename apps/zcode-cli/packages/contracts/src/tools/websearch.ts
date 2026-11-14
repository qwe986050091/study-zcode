// ============================================================
// WebSearch Tool - provider-visible wrapper and internal provider-native schema definitions
// ============================================================
// 生产者：core 的 handlers/websearch.ts 用当前模型的原生 web_search 能力发一次内部辅助请求，
// 结果由 websearch-results.ts 归一化；消费者：模型面只读 `<results>/<sources>` 投影文本。
// 两个 schema 的分层是刻意的：`WebSearchInputJsonSchema` 取 provider 输入（query/域过滤），
// **不**暴露 maxUses；`maxUses` 是内部预算字段，只在 toWebSearchProviderNativeArgs 里落到
// provider 原生参数，好让"一次搜索最多消化多少结果"不成为模型可调项。
// 反向约束：allowed_domains 与 blocked_domains 同时出现会让语义冲突，schema 直接拒绝。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ProviderNativeToolSpec, ToolContractDeclaration } from "./contract.js";

// 内部原生搜索的默认/硬上界用量（8）。它是单次请求里 provider 最多执行的搜索次数，
// 不是工具调用次数上限；两个常量同值表示目前不区分"默认"与"天花板"。
const DEFAULT_MAX_USES = 8;
const MAX_USES = 8;

// provider 原生入参的公共部分：query 至少 2 字符（单字符查询没有检索价值），域过滤两个数组
// 互斥性由外层 refine 保证；`.strict()` 防止模型塞入 provider 不认识的字段。
const WebSearchProviderInputSchema = z
  .object({
    query: z.string().min(2).describe("The search query to use"),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe("Only include search results from these domains"),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe("Never include search results from these domains"),
  })
  .strict();

// 执行侧入参：provider 公共字段 + `maxUses`（1~8，optional，缺省取 DEFAULT_MAX_USES）。
// refine 在对象级拒绝"允许域与屏蔽域同时给"的组合，错误挂在 blocked_domains 上便于模型定位。
// 注意它与 provider JSON schema 不是同一份：模型看不到 maxUses。
export const WebSearchInputSchema = WebSearchProviderInputSchema.extend({
  maxUses: z
    .number()
    .int()
    .min(1)
    .max(MAX_USES)
    .optional()
    .describe(
      `Maximum provider-native searches in the internal web_search request, default ${DEFAULT_MAX_USES}`,
    ),
})
  .strict()
  .refine((input) => !(input.allowed_domains?.length && input.blocked_domains?.length), {
    message: "allowed_domains and blocked_domains cannot both be specified",
    path: ["blocked_domains"],
  });

// handler 入参类型（含 maxUses），只在内核使用；模型面的字段集合更窄。
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// provider 可见 schema：取**公共部分**而非完整入参，因此模型永远看不到 maxUses；
// 这是"内部预算不暴露给模型"的落点。
export const WebSearchInputJsonSchema = toToolJsonSchema(WebSearchProviderInputSchema);

// provider 原生参数（camelCase），与业务入参（snake_case）是两套命名：provider 只认这一套。
// 继承 Record<string, unknown> 是为了满足 provider 参数通道的开放形状。
export interface WebSearchProviderNativeArgs extends Record<string, unknown> {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

// 业务入参 → provider 原生参数的唯一转换点：字段改名 + `maxUses` 缺省补默认值。
// 两个域数组在缺席时保持 undefined（而不是空数组），让 provider 能区分"不过滤"与"过滤为空"。
// 副作用无；它不参与权限判定，也不记录到模型可见结果。
export function toWebSearchProviderNativeArgs(
  input: WebSearchInput,
  defaults: { maxUses: number },
): WebSearchProviderNativeArgs {
  return {
    allowedDomains: input.allowed_domains,
    blockedDomains: input.blocked_domains,
    maxUses: input.maxUses ?? defaults.maxUses,
  };
}

// 来源引用（`.strict()`）：`url` 必填用于可追溯，`title` 可缺席（部分结果只有链接）。
// sources 与 results 分开存放：前者是"回答里实际用到的引用"，后者是原始检索命中。
export const WebSearchSourceSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
  })
  .strict();

// 来源的 TS 投影，供模型面 "Sources:" 列表与 UI 使用。
export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>;

// 原始检索命中：`title` 可缺席，`url` 必填，`pageAge` 是 provider 给出的页面时间文本
// （原样透传，不解析成日期，避免时区/格式二次解释）。
export const WebSearchResultItemSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
    pageAge: z.string().optional(),
  })
  .strict();

// 命中项的 TS 投影；结果数组按 provider 返回顺序保留，不做重排。
export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

// 内部辅助请求的 token 用量投影，用于成本归因而不是模型结论；`.strict()` 保证 provider
// 多返回的未知计数字段不会悄悄混进持久化记录。字段全部 optional，因为不同 provider 的
// usage 覆盖度不同，缺失不代表 0。
// `serverToolUse.webSearchRequests` 是 provider 服务端实际执行的搜索次数（与 `maxUses`
// 预算对照可见是否触顶），`webFetchRequests` 是 provider 在同一请求里额外抓页的次数。
const WebSearchModelUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    serverToolUse: z
      .object({
        webSearchRequests: z.number().optional(),
        webFetchRequests: z.number().optional(),
      })
      .optional(),
  })
  .strict();

// 单次搜索的归一化结果，生产者是 handlers/websearch-results.ts 的 buildWebSearchOutput，
// 消费者是模型面文本格式化、UI 与 trace 摘要。字段口径：
// - `query` 是本次调用入参的原始查询，不回填 provider 改写后的查询；
// - `results` 是原始命中（含被回答忽略的条目），`sources` 是回答里实际引用的子集；
// - `summary` 是辅助模型的文本摘要，可能缺席（只拿到工具结果时）；
// - `durationMs` 覆盖整个内部辅助请求（含网络），非负；
// - `webSearchRequests` / `modelUsage` 是成本观测字段，不影响模型可见正文。
// `.strict()` 是刻意的：归一化层新增字段必须先改 schema，避免上游对象原样泄漏。
export const WebSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(WebSearchResultItemSchema),
    sources: z.array(WebSearchSourceSchema),
    summary: z.string().optional(),
    durationMs: z.number().nonnegative(),
    webSearchRequests: z.number().int().nonnegative().optional(),
    modelUsage: WebSearchModelUsageSchema.optional(),
  })
  .strict();

// 结果对象的 TS 投影；与 schema 同源，不存在手写接口与 schema 漂移的中间层。
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

// 结果 JSON schema，供 tool 注册项的 outputSchema 与 executor 侧结构校验使用；
// 它只描述形状，不做截断——预算由 resultBudget 的 truncate/preview 在通道层执行。
export const WebSearchOutputJsonSchema = toToolJsonSchema(WebSearchOutputSchema);

// provider 原生搜索能力的声明：`kind` 决定适配器走服务端工具通道，`providerToolName`
// 必须与 provider 实际接受的工具名一致（Anthropic 系为 `web_search`）。
// `fallback: "disabled"` 表示模型不支持原生搜索时**不降级**为别的检索方式：让
// supportsNativeWebSearch 检查直接抛配置错误，而不是静默换一种语义不同的实现。
// 该声明只在 handler 内部的辅助请求里被引用，不上报给工具面。
export const WEBSEARCH_PROVIDER_NATIVE_SPEC: ProviderNativeToolSpec = {
  kind: "provider_native",
  logicalName: "WebSearch",
  providerToolName: "web_search",
  fallback: "disabled",
};

// 模型面工具契约（被 toolEntry 展开后注册）。关键口径：
// - `executionMode: "client"`：对上层是客户端工具，provider 原生身份只在 handler 内部使用；
// - permission 为 `websearch`，风险 low、作用域 network、免审批；`patternSources` 纳入
//   `network` 使主机/URL 级规则也能匹配到这次出站请求，`denyPriority: "beforeAsk"` 保证
//   用户配置的 deny 规则先于 ask 生效；
// - resultBudget 双层：inline 10_000 是实时事件/UI 的即时投影，model 20_000 是送模型的
//   预算，strategy 为 truncate，preview 取头部 30 行（保留标题与 URL，不保留尾部引用）；
// - timeout 允许调用方覆盖到 120_000，cancellation 为 bestEffort，trace 记完整输入、
//   只记摘要输出（查询原文可能较长，结果正文可能很大）。
export const WEBSEARCH_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "web_search",
  executionMode: "client",
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  permission: {
    permission: "websearch",
    reason:
      "WebSearch performs read-only provider-native web searches through an internal model request",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "network"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxLines: 30,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 60_000,
    maxMs: 120_000,
    allowCallOverride: true,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "WebSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
