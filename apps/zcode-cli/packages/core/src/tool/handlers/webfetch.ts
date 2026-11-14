// ============================================================
// WebFetch Tool Handler
// ============================================================
// 链路位置：call-runner 的工具入口 → 本文件 → webfetch-network（真实出网）→
// webfetch-processing（小模型作答）。这里负责「编排」，不直接碰网络或模型客户端。
//
// 流程：入参 schema 校验 → 每次必做的 URL 规范化/安全校验 → 查缓存 →（未命中）抓取并
// 落 artifact → 终态结果短路 → 写缓存 → 小模型处理 → 组装 WebFetchOutput。
//
// 维护的不变量：
// 1. 无论是否命中缓存，normalizeWebFetchUrl 都会执行——缓存不能成为绕过协议/凭据/主机
//    校验的捷径。
// 2. 只有「成功抽取的正文」进入缓存；重定向与 HTTP 错误是终态，既不再处理也不缓存，
//    避免把一次失败固化 15 分钟。
// 3. 缓存写入发生在小模型处理之前：处理失败时正文仍在缓存里，重试同一 URL 不必再出网。
// 4. 模型可见结果的大预算与 artifact 留存由下方 toolEntry 的 resultBudget 声明，本文件
//    只负责把 artifact 路径与 truncated 标记透传出去（不变量 4）。
// 5. 权限只收紧不放松：needsApproval=true、denyPriority 为 beforeAsk，domain 级白名单
//    只能来自权限层规则，handler 不做任何「预批准即免审批」的旁路。
// ============================================================

import { STATUS_CODES } from "node:http";
import {
  WebFetchInputJsonSchema,
  WebFetchInputSchema,
  WebFetchOutputJsonSchema,
  WebFetchOutputSchema,
  type WebFetchInput,
  type WebFetchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  clearWebFetchCacheForTests as clearWebFetchContentCacheForTests,
  getWebFetchCache,
  putWebFetchCache,
} from "./webfetch-cache.js";
import {
  DEFAULT_WEBFETCH_TIMEOUT_MS,
  MAX_WEBFETCH_MODEL_BYTES,
  WEBFETCH_TOOL_NAME,
} from "./webfetch-constants.js";
import { fetchAndExtractContent } from "./webfetch-network.js";
import { processFetchedContent } from "./webfetch-processing.js";
import type {
  FetchAndExtractContentResult,
  HttpErrorFetchContent,
  RedirectFetchContent,
} from "./webfetch-types.js";
import { isWebFetchPreapprovedUrl } from "../webfetch-preapproved.js";
import { normalizeWebFetchUrl } from "./webfetch-url.js";

/**
 * 清空进程内 WebFetch 缓存，仅供测试隔离。
 *
 * 对 webfetch-cache 的同名函数做一层导出转发：测试从这里进入，避免直接依赖缓存模块的
 * 内部结构与单例，后续缓存实现更换（例如改为可注入 store）时不至于改遍测试。
 */
export function clearWebFetchCacheForTests(): void {
  clearWebFetchContentCacheForTests();
}

/**
 * 提供给模型的工具描述文案（进入 tool 列表，占用常驻上下文）。
 *
 * 三句话分别对应模型最容易踩的三个坑：私有/需登录页面会失败（应改用 gh 或 MCP）、HTTP 会
 * 被升级且跨主机重定向不会自动跟随（必须用提示里的新 URL 再调一次）、重复抓取 15 分钟内
 * 命中缓存。保持简短，避免为了解释细节挤占上下文。
 */
const WEBFETCH_DESCRIPTION = [
  "Fetches a URL, converts the page to markdown, and answers `prompt` against it using a small fast model.",
  "",
  "- Fails on authenticated/private URLs — use an authenticated MCP tool or `gh` for those instead.",
  "- HTTP is upgraded to HTTPS. Cross-host redirects are returned to you rather than followed; call again with the redirect URL.",
  "- Responses are cached for 15 minutes per URL.",
].join("\n");

interface FreshWebFetchContent {
  fetched: FetchAndExtractContentResult;
  /** 入参 URL 是否在预批准清单；决定「短 markdown 直出」与处理提示词的宽松档。 */
  preapprovedUrl: boolean;
}

/**
 * 工具主 handler：抓取一个公开 URL，并用小模型按 `prompt` 作答。
 *
 * 输入口径：Model 传来的 `{ url, prompt }` 先经 WebFetchInputSchema 运行时校验；url 必须
 * 是 http/https、不含凭据、主机为公开形态，prompt 是给处理模型的问题（不参与抓取策略）。
 *
 * 输出：WebFetchOutput（url/finalUrl/status/statusText/contentType/bytes/durationMs/result
 * /cacheHit/redirects/artifactUri/artifactPath/truncated）。`result` 才是模型可见正文；
 * 其余字段是元数据。`bytes` 是原始响应体字节，`durationMs` 覆盖网络 + 处理两段耗时。
 *
 * 副作用：真实网络 GET（缓存未命中时）、可能写 artifact、可能触发一次内部模型调用；
 * 缓存写入是进程级共享状态。失败语义：校验/网络/处理错误统一 throw 给 executor，
 * 不在这里转成「友好结果」——工具失败的配对结果由 call-runner 统一生成。
 *
 * 注意：即使命中缓存也先执行 URL 规范化与 egress 形态校验，缓存不是绕过安全检查的通道。
 */
export const webFetchHandler: ToolHandler = async (input, context) => {
  const parsed = WebFetchInputSchema.parse(input) as WebFetchInput;
  const startedAt = Date.now();
  const normalizedUrl = normalizeWebFetchUrl(parsed.url);
  // 缓存键直接用入参原文而不是规范化 URL：http→https、大小写、尾斜杠等写法差异会各自
  // 成键，命中率略降，但避免了「规范化后等价合并」带来的跨协议复用风险。
  const cacheKey = parsed.url;
  const cached = getWebFetchCache(cacheKey);
  const content =
    cached === undefined
      ? await fetchFreshContent({
          context,
          originalUrl: cacheKey,
          url: normalizedUrl,
        })
      : {
          fetched: cached,
          preapprovedUrl: isWebFetchPreapprovedUrl(parsed.url),
        };
  const fetched = content.fetched;

  // 终态（重定向交回 / HTTP 错误）直接成文返回：不写缓存、不调用处理模型，
  // 也不允许后续逻辑把它们当成「正文」继续处理。
  if (isTerminalFetchContent(fetched)) {
    return formatTerminalOutput(parsed, fetched, Math.max(0, Date.now() - startedAt));
  }

  // 只缓存成功正文，且放在处理模型之前：处理失败时正文仍在缓存中，
  // 重试不会因为一次小模型抖动而被迫重新出网。
  if (cached === undefined) {
    putWebFetchCache(cacheKey, fetched);
  }

  const processing = await processFetchedContent(parsed, fetched, context, {
    preapprovedUrl: content.preapprovedUrl,
  });
  const durationMs = Math.max(0, Date.now() - startedAt);

  return {
    url: parsed.url,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    // 上游 statusText 可能为空，这里统一回退到 Node 的状态码表，保证展示字段不为空。
    statusText: httpStatusText(fetched.status, fetched.statusText),
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    durationMs,
    result: processing.result,
    // cacheHit 反映「本次调用开始前是否已有缓存」，与本次是否写缓存无关。
    cacheHit: cached !== undefined,
    redirects: fetched.redirects,
    artifactUri: fetched.artifactUri,
    artifactPath: fetched.artifactPath,
    truncated: processing.truncated,
  } satisfies WebFetchOutput;
};

/**
 * 缓存未命中时的抓取入口：把「抓取结果」与「是否预批准 URL」合成一个值。
 *
 * 预批准判断放在这里而不是放进网络层，是因为它只影响上层的处理策略（是否直出/提示词档位），
 * 不改变出站行为；网络层因此保持对 URL 来源无感知。错误原样上抛，不做重试或降级。
 */
async function fetchFreshContent(options: {
  context: ToolExecutionContext;
  originalUrl: string;
  url: URL;
}): Promise<FreshWebFetchContent> {
  const fetched = await fetchAndExtractContent({
    context: options.context,
    originalUrl: options.originalUrl,
    url: options.url,
  });
  return {
    fetched,
    preapprovedUrl: isWebFetchPreapprovedUrl(options.originalUrl),
  };
}

/**
 * 把两种终态抓取结果转成给模型的输出：重定向提示与 HTTP 错误提示。
 * 分派只依据判别字段 type，不依赖 message 文本；两分支都不产生 artifact 与缓存。
 */
function formatTerminalOutput(
  input: WebFetchInput,
  fetched: HttpErrorFetchContent | RedirectFetchContent,
  durationMs: number,
): WebFetchOutput {
  if (fetched.type === "redirect") {
    return formatRedirectOutput(input, fetched, durationMs);
  }
  return formatHttpErrorOutput(fetched, durationMs);
}

/**
 * 构造「跨主机重定向」的提示结果，引导模型带新 URL 再调一次 WebFetch。
 *
 * 输出全部字段都是为「让模型能直接复制参数重试」服务的：result 里同时给出原始 URL、目标
 * URL、状态码与两次调用参数。finalUrl 取 originalUrl 而不是目标 URL——反直觉，因为本次
 * 实际只抓到了重定向响应，目标页面从未被请求；把未抓取的 URL 填进 finalUrl 会歪曲事实。
 * bytes 是这段提示文本自身的字节数，不是页面大小；cacheHit=false、truncated=false。
 */
function formatRedirectOutput(
  input: WebFetchInput,
  redirect: RedirectFetchContent,
  durationMs: number,
): WebFetchOutput {
  const statusText = httpStatusText(redirect.status, redirect.statusText);
  const result = [
    "REDIRECT DETECTED: The URL redirects to a different host.",
    "",
    `Original URL: ${redirect.originalUrl}`,
    `Redirect URL: ${redirect.redirectUrl}`,
    `Status: ${redirect.status} ${statusText}`,
    "",
    "To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:",
    `- url: "${redirect.redirectUrl}"`,
    `- prompt: "${input.prompt}"`,
  ].join("\n");

  return {
    url: input.url,
    finalUrl: redirect.originalUrl,
    status: redirect.status,
    statusText,
    contentType: "text/plain",
    bytes: Buffer.byteLength(result, "utf8"),
    durationMs,
    result,
    cacheHit: false,
    redirects: redirect.redirects,
    truncated: false,
  };
}

/**
 * 构造 HTTP 错误提示结果：明确告诉模型「正文未取回」，并给出需认证场景的替代工具。
 *
 * bytes 恒为 0（确实没有读到 body）；url 用用户原始入参、finalUrl 用出错时所在 URL，
 * 两者可能因已跟随的重定向而不同。Retry-After 只在有值时追加一行，值是纯数字秒数。
 */
function formatHttpErrorOutput(error: HttpErrorFetchContent, durationMs: number): WebFetchOutput {
  const statusText = httpStatusText(error.status, error.statusText);
  const retryAfter = error.retryAfter ? `\nRetry-After: ${error.retryAfter}` : "";
  const result = [
    `The server returned HTTP ${error.status} ${statusText}.${retryAfter}`,
    "",
    "The response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.",
  ].join("\n");

  return {
    url: error.originalUrl,
    finalUrl: error.finalUrl,
    status: error.status,
    statusText,
    contentType: "text/plain",
    bytes: 0,
    durationMs,
    result,
    cacheHit: false,
    redirects: error.redirects,
    truncated: false,
  };
}

/**
 * 统一状态文案：优先上游原文（去空白后非空），其次 Node 状态码表，最后兜底 "Unknown Status"。
 * 三条回退保证输出字段永不为空串，展示层不需要再判空。
 */
function httpStatusText(status: number, statusText: string): string {
  return statusText.trim() || STATUS_CODES[status] || "Unknown Status";
}

/**
 * 判别终态抓取结果：两个终态分支都带 `type` 字段，成功正文没有。
 * 反直觉：不能用 `value.type === "redirect"` 之类的正向判断来排除成功分支，因为成功分支
 * 的 type 是 undefined，写成「不是 redirect 就是成功」会漏掉 http_error。
 */
function isTerminalFetchContent(
  value: FetchAndExtractContentResult,
): value is HttpErrorFetchContent | RedirectFetchContent {
  return "type" in value;
}

/**
 * 工具注册条目：能力声明、元数据、schema、权限、结果预算、超时、取消与 trace 契约。
 *
 * 任何一项写错都会在链路另一头出问题：readOnly/concurrentSafe 决定调度能否并行；
 * sideEffectScope/needsApproval 决定权限门；resultBudget 决定模型看到多少（不变量 4）；
 * timeout/cancellation 决定用户取消与超时后的收口；trace 决定网络日志能否归并到本次调用。
 * 字段之间必须保持一致（例如两处 maxBytes、两处 timeout 都用同一常量），否则声明与实际行为漂移。
 */
export const webFetchToolEntry: ToolEntry = {
  capability:
    "Fetch a public URL, convert readable content to markdown, and answer a prompt from it",
  metadata: {
    // 延迟工具：默认不进首轮工具面，模型要先 ToolSearch 发现、再用 DeferredToolCall 调用，
    // 以节省常驻上下文（链路 10 的可见性与延迟调用契约）。
    shouldDefer: true,
    name: WEBFETCH_TOOL_NAME,
    searchHint: "fetch and extract content from a URL",
    description: WEBFETCH_DESCRIPTION,
    // 只读：仅有 GET，不改工作区；但仍有网络副作用，所以下面是 network scope + 审批。
    readOnly: true,
    destructive: false,
    // 并发安全：handler 无本地可变状态，缓存写入幂等；并行调用同一 URL 最多重复出网。
    concurrentSafe: true,
    timeoutMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    maxOutputBytes: MAX_WEBFETCH_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: webFetchHandler,
  formatModelContent: formatWebFetchModelContent,
  inputSchema: WebFetchInputJsonSchema,
  outputSchema: WebFetchOutputJsonSchema,
  runtimeInputSchema: WebFetchInputSchema,
  runtimeOutputSchema: WebFetchOutputSchema,
  permission: {
    permission: "webfetch",
    reason: "WebFetch performs an outbound network GET request to the requested domain",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: true,
    // 规则来源按 network 维度聚合：域名白名单/拒绝规则由权限层按目标 host 匹配，
    // handler 不参与匹配，也不能自行放宽。
    patternSources: ["network"],
    alwaysAllowPatternSources: ["network"],
    // deny 优先于 ask：命中拒绝规则时不弹确认窗直接拒绝（权限只能收紧，不变量 3）。
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    // 预算按 min(maxModelBytes, maxInlineBytes) 生效（不变量 4）；两处用同一常量确保口径一致。
    maxInlineBytes: MAX_WEBFETCH_MODEL_BYTES,
    maxModelBytes: MAX_WEBFETCH_MODEL_BYTES,
    // 超预算走 artifact：保留全文落盘 + 预览，而不是把大块正文硬塞进上下文。
    strategy: "artifact",
    preview: {
      maxBytes: MAX_WEBFETCH_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    // 固定 60s：default 与 max 相同且禁止 call 级覆盖，模型无法用入参延长单次出网窗口。
    defaultMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    maxMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    // 取消清理是 bestEffort：出站请求由 adapter 负责中止，这里不承诺回滚已写入的 artifact。
    cleanup: "bestEffort",
    userVisibleMessage: "WebFetch was cancelled before the page could be processed",
  },
  trace: {
    // required + propagateToAdapters：网络 adapter 必须收到 trace，才能把请求与 tool_call 归并。
    required: true,
    propagateToAdapters: true,
    // 输入/输出只记摘要：URL 与 prompt、结果正文都可能含敏感内容或很大，不能全量入 trace。
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * 模型可见内容的投影：优先使用 output.result（已经过 prompt 处理与版权约束的答案）。
 *
 * 其余字段是给 UI/审计用的元数据，不进入模型上下文。反直觉之处：当 output 不是预期形状
 * （例如版本不一致或旧客户端回放）时，字符串原样返回、对象退化为 JSON——这是保守降级，
 * 不抛错，避免因为投影失败让一次成功的工具调用变成失败。JSON.stringify(undefined) 返回
 * undefined，所以最后再兜一个空串。
 */
function formatWebFetchModelContent(output: unknown): string {
  if (isWebFetchOutput(output)) {
    return output.result;
  }
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

/**
 * WebFetchOutput 的最小结构守卫：只认 result 与 finalUrl 两个必有的字符串字段。
 *
 * 不做完整 schema 校验是刻意的——这里只用于「选哪个字段给模型」的投影分派，完整校验由
 * runtimeOutputSchema 在序列化边界完成；重复校验会把同一份 schema 跑两遍。
 */
function isWebFetchOutput(value: unknown): value is WebFetchOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WebFetchOutput).result === "string" &&
    typeof (value as WebFetchOutput).finalUrl === "string"
  );
}
