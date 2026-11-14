// ============================================================
// WebFetch Tool - URL fetch and extraction
// ============================================================
// 生产者：core 的 handlers/webfetch.ts 编排"URL 校验 → 缓存 → 出网/落 artifact → 小模型
// 作答"，网络与内容抽取细节分别在 webfetch-network / webfetch-content；
// 消费者：模型面只读 `result`（已按 prompt 处理过的答案），其余字段供 UI 展示与审计。
// 超时/截断边界：单跳 60s 硬超时且模型不可用入参放宽；响应体 10MB 上限由 adapter 执行；
// 送进小模型的正文按字符截断，模型可见结果按字节预算走 artifact + 预览。
// 不变量：跨主机重定向不会被自动跟随——本次只抓到了重定向响应，`finalUrl` 填原始 URL，
// 目标页面从未被请求，不能伪装成已抓取。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

// 入参：`url` 先经 z.string().url() 做语法校验（协议/凭据/主机形态的安全校验发生在 handler
// 的 normalizeWebFetchUrl，且缓存命中时也必须执行）；`prompt` 是交给小模型的问题，不参与
// 抓取策略。未加 `.strict()` 是历史形状。
export const WebFetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch content from"),
  prompt: z.string().describe("The prompt to run on the fetched content"),
});

// handler 入参类型；`prompt` 原样透传给处理模型，不做改写或转义。
export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

// provider 可见 schema，与运行时同源。
export const WebFetchInputJsonSchema = toToolJsonSchema(WebFetchInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

// 一条重定向记录：`from`/`to` 是完整 URL，`status` 是 3xx 码。同主机重定向会被跟随并在此
// 累积；跨主机时本次调用停在第一跳，并把目标 URL 交给模型重新调用。
export interface WebFetchRedirect {
  from: string;
  to: string;
  status: number;
}

// 抓取结果。字段口径：
// - `url`：用户原始入参；`finalUrl`：实际取得响应的 URL。跨主机重定向终态时 `finalUrl`
//   等于原始 URL（目标页面并未被请求）。
// - `status`/`statusText`：HTTP 状态；statusText 有三级兜底（上游原文 → Node 状态码表 →
//   "Unknown Status"），保证展示字段非空。
// - `contentType`/`bytes`：响应类型与**原始响应体**字节数；重定向/错误终态时 bytes 是提示
//   文本自身的字节数或 0，不是页面大小。
// - `durationMs`：覆盖网络抓取 + 小模型处理两段耗时。
// - `result`：模型可见正文（唯一进入上下文的字段），其余字段只供 UI/审计。
// - `cacheHit`：本次调用**开始前**是否已有缓存，与本次是否写入无关。
// - `redirects`：已发生的重定向链；`artifactUri`/`artifactPath`：大正文落盘后的引用；
// - `truncated`：处理阶段正文被截断（true 表示 result 不是完整正文，完整内容见 artifact）。
export interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  durationMs: number;
  result: string;
  cacheHit: boolean;
  redirects: WebFetchRedirect[];
  artifactUri?: string;
  artifactPath?: string;
  truncated: boolean;
}

// 重定向记录的运行时镜像（`.strict()`）；`status` 非负整数，不接受未知字段。
export const WebFetchRedirectSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    status: z.number().int().nonnegative(),
  })
  .strict();

// 输出侧的运行时契约（`.strict()`）：`artifactUri`/`artifactPath` 是 optional（小结果不落盘），
// 其余字段恒有。executor 用它校验 handler 结果，schema 失败会被收成工具失败而不是半份结果。
export const WebFetchOutputSchema = z
  .object({
    url: z.string(),
    finalUrl: z.string(),
    status: z.number().int().nonnegative(),
    statusText: z.string(),
    contentType: z.string(),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    result: z.string(),
    cacheHit: z.boolean(),
    redirects: z.array(WebFetchRedirectSchema),
    artifactUri: z.string().optional(),
    artifactPath: z.string().optional(),
    truncated: z.boolean(),
  })
  .strict();

// provider 可见输出 schema（契约对齐/测试用）；模型面实际只取 result 字段。
export const WebFetchOutputJsonSchema = toToolJsonSchema(WebFetchOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

// 调用结构：`traceId` 让网络 adapter 把请求归并到本次工具调用（trace 必须透传给 adapter），
// `startedAt` 供 durationMs 计算。
export interface WebFetchToolCall {
  id: ToolCallId;
  name: "WebFetch";
  input: WebFetchInput;
  traceId: TraceId;
  startedAt: Date;
}

// 结果与调用按 `toolCallId` 配对；`durationMs` 包含网络与处理两段，不是单跳耗时。
export interface WebFetchToolResult {
  toolCallId: ToolCallId;
  output: WebFetchOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// WebFetch Errors
// -----------------------------------------------

// 稳定的失败分类（名称 → 线上 code）。前四类发生在解析/出网前：非法 URL、协议非 http/https、
// URL 内嵌凭据、重定向缺 Location；`UnsafeRedirect`/`EgressBlocked` 是安全策略拒绝（不会被
// 重试绕过）；`TooManyRedirects`/`ResponseTooLarge` 是资源边界；最后两类是网络与内容处理失败。
// 上层按 code 决定展示文案与能否重试，不能依赖 message 文本。
export const WebFetchErrorCode = {
  InvalidUrl: "webfetch_invalid_url",
  UnsupportedProtocol: "webfetch_unsupported_protocol",
  CredentialsInUrl: "webfetch_credentials_in_url",
  MissingRedirectLocation: "webfetch_missing_redirect_location",
  UnsafeRedirect: "webfetch_unsafe_redirect",
  EgressBlocked: "webfetch_egress_blocked",
  TooManyRedirects: "webfetch_too_many_redirects",
  ResponseTooLarge: "webfetch_response_too_large",
  FetchFailed: "webfetch_fetch_failed",
  ProcessingFailed: "webfetch_processing_failed",
} as const;

// 错误码联合类型；用于把端口抛出的错误归一成上述分类。
export type WebFetchErrorCode = (typeof WebFetchErrorCode)[keyof typeof WebFetchErrorCode];
