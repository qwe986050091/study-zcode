// WebFetch 网络层的返回形状。
//
// 三个分支是「网络层收口」的产物：成功抽取（CachedFetchContent，无 type 判别字段）、
// 跨域/不允许的重定向（RedirectFetchContent）、HTTP 非 2xx（HttpErrorFetchContent）。
// 后两个是终态结果，会直接转成给模型看的文本，不再进入正文抽取，也不会写缓存；
// 类型判别靠 `"type" in value`（见 webfetch.ts 的 isTerminalFetchContent），
// 所以给成功分支加 type 字段会同时破坏判别与缓存结构。
import type { WebFetchRedirect } from "@zcode/contracts";

/**
 * 成功取回的正文及其元数据，也是缓存的存储单元。
 * 该对象会被缓存复用，调用方只能读，不得原地修改数组或字符串字段。
 */
export interface CachedFetchContent {
  /** 原文落 artifact 后的磁盘路径；仅当正文超过 MAX_MODEL_INPUT_CHARS 且注入了 artifactStore 时存在。 */
  artifactPath?: string;
  /** 对应的可追踪 URI，消费方是工具输出与结果序列化；缺失表示没有全量留存，模型只能看到截断正文。 */
  artifactUri?: string;
  /** 原始响应体字节数（含未抽取的 HTML/头部体积），用于 output.bytes 展示真实下载量；不是正文大小。 */
  bytes: number;
  /** 抽取后的正文（HTML 会转 markdown）。它是缓存主体，也是送进小模型的输入。 */
  content: string;
  /** 上游原始 content-type（可能带 charset）。决定是否按 HTML 抽取、以及 artifact 的 MIME。 */
  contentType: string;
  /** 跟随完允许的重定向后的最终 URL；输出 finalUrl 与错误上下文都用它，而不是用户原始入参。 */
  finalUrl: string;
  /** 已跟随的重定向链（只含被允许的同主机跳转）；被拦截的跨主机跳转不会出现在这里。 */
  redirects: WebFetchRedirect[];
  /** 抽取后正文的 UTF-8 字节数，只用于缓存容量核算，与 bytes 口径不同。 */
  sizeBytes: number;
  /** 最终响应的 HTTP 状态码（必为 2xx），给输出层展示与遥测使用。 */
  status: number;
  /** 上游 statusText 原文，可能为空，输出时会回退到 STATUS_CODES 表。 */
  statusText: string;
}

/**
 * 重定向终态：目标主机/协议/端口不同或落回私网，工具不跟随。
 *
 * 这是「把决定权交回模型」的形态——结果文本会明确给出新 URL，由模型再调一次 WebFetch，
 * 从而让第二次出站重新走权限与 egress 检查。不计入缓存、不产生 artifact，bytes 恒为 0。
 */
export interface RedirectFetchContent {
  /** 判别字段，值为固定字面量；新增分支时不能复用它。 */
  type: "redirect";
  /** 发起这跳重定向的 URL（可能是用户原始 URL，也可能是上一跳后的 URL）。 */
  originalUrl: string;
  /** 建议模型重试的目标 URL，已剔除 URL 内嵌凭据，可直接展示。 */
  redirectUrl: string;
  /** 本次请求已跟随的全部重定向记录，末尾追加了这条被拦截的跳转。 */
  redirects: WebFetchRedirect[];
  /** 重定向响应本身的状态码（3xx）。 */
  status: number;
  /** 重定向响应本身的 statusText，可能为空。 */
  statusText: string;
}

/**
 * HTTP 错误终态：正文未取回。来源只有两处——重定向响应缺少可用 Location，
 * 或循环结束后状态仍非 2xx（4xx/5xx/304 等；代理拦截是抛出而不走这里）。
 *
 * 工具不会尝试读错误页内容；提示语把「可能需要认证」的替代路径告诉模型。不缓存。
 */
export interface HttpErrorFetchContent {
  type: "http_error";
  /** 出错时所在（已跟随部分重定向后的）URL。 */
  finalUrl: string;
  /** 用户最初请求的 URL，输出 url 字段用它，保持与入参一致。 */
  originalUrl: string;
  redirects: WebFetchRedirect[];
  /** 仅保留纯数字（1~6 位）的 Retry-After 秒数；HTTP-date 形态或异常值一律丢弃为 undefined。 */
  retryAfter?: string;
  status: number;
  statusText: string;
}

/**
 * 网络层统一返回：成功正文 or 两种终态错误。
 * 成功分支没有 type 字段，调用方不能靠 `value.type === "..."` 判定成功，必须用
 * isTerminalFetchContent 之类的反向判别。
 */
export type FetchAndExtractContentResult =
  | CachedFetchContent
  | HttpErrorFetchContent
  | RedirectFetchContent;
