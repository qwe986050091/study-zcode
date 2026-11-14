/**
 * 文件职责：本地 HTTP 代理，截获 OpenAI/Anthropic 风格请求并转发到真实上游，同时写入消息账本。
 * 输入：已打开的 MessageLedger、上游基址与可选 mock 响应序列。
 * 输出：监听 127.0.0.1 随机端口的代理句柄；baseURL 保留上游 pathname，供运行时直接拼接。
 * 副作用：起 HTTP 服务、转发网络请求、回写客户端响应、向 ledger 写请求与 assistant 回复。
 * 失败语义：请求级错误统一转 502 JSON；响应头已发送后改为销毁连接，避免写出非法响应体。
 * 不变量：先记录请求再转发或 mock，保证上游失败时仍留下完整请求快照。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { assembleNonStreamingAssistantMessage, assembleStreamingAssistantMessage } from "./openai-response-assembler.js";
import type { MessageLedger } from "./message-ledger.js";
import type { JsonObject } from "./types.js";

/**
 * 代理句柄。
 * baseURL 为可直接配置给 model 的地址（含上游 pathname，去尾斜杠）；close 用于释放端口。
 */
export interface OpenAiProviderProxy {
  /** 运行时使用的基址，形如 http://127.0.0.1:<port><upstreamPath>。 */
  baseURL: string;
  /** 关闭 HTTP 服务；失败时 reject 原始错误。 */
  close(): Promise<void>;
}

/**
 * 启动本地录制代理。
 * 输入：ledger（必填）、可选 mockResponses、上游基址。
 * 输出：监听随机端口的代理句柄；此时服务已处于可接受连接状态。
 * 副作用：占用一个本地端口、注册请求处理回调；不写盘（写盘由 ledger 完成）。
 * 失败语义：监听失败（端口被占用等）时 reject，已创建 server 不复用。
 * 不变量：mockResponses 只在启动时解析一次，规则消费状态在代理生命周期内共享。
 */
export async function startOpenAiProviderProxy(input: {
  ledger: MessageLedger;
  mockResponses?: readonly unknown[];
  upstreamBaseURL: string;
}): Promise<OpenAiProviderProxy> {
  const upstreamBaseURL = normalizeBaseURL(input.upstreamBaseURL);
  const mockResponseResolver = input.mockResponses
    ? createMockResponseResolver(input.mockResponses)
    : undefined;
  const server = createServer((request, response) => {
    void handleRequest({
      ledger: input.ledger,
      getMockResponse: mockResponseResolver,
      request,
      response,
      upstreamBaseURL,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 只绑定回环地址与随机端口，避免暴露到局域网，也避免固定端口冲突。
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  // 保留上游 pathname：运行时按 provider 路径拼接时无需感知代理前缀。
  const baseURL = new URL(upstreamBaseURL.pathname, `http://127.0.0.1:${address.port}`);
  return {
    baseURL: baseURL.href.replace(/\/$/u, ""),
    close: () => closeServer(server),
  };
}

/**
 * 处理单次代理请求：读体、记账、按 mock 或上游分支返回。
 * 输入：请求/响应流、ledger、上游 URL 与可选 mock 解析器。
 * 输出：无；所有内容写回 response。
 * 副作用：读请求体、写账本、发起上游 fetch、流式转发或 mock 回包。
 * 失败语义：任何异常都由顶层 catch 转成 502，不向调用方抛出（避免未处理 rejection）。
 * 不变量：requestIndex 在分支前取得，保证 mock 与上游路径使用同一序号。
 */
async function handleRequest(input: {
  getMockResponse?: (requestBody: JsonObject) => unknown;
  ledger: MessageLedger;
  request: IncomingMessage;
  response: ServerResponse;
  upstreamBaseURL: URL;
}): Promise<void> {
  try {
    const bodyText = await readRequestBody(input.request);
    const requestBody = parseRequestBody(bodyText);
    const requestIndex = await input.ledger.recordRequestBody(requestBody);
    // 先落请求再分支：mock 抛错或上游失败都不会丢失请求快照。
    if (input.getMockResponse) {
      await writeMockResponse({
        getMockResponse: input.getMockResponse,
        ledger: input.ledger,
        requestBody,
        requestIndex,
        response: input.response,
      });
      return;
    }
    const upstreamResponse = await fetch(resolveUpstreamURL(input.request, input.upstreamBaseURL), {
      body: bodyText,
      headers: forwardHeaders(input.request.headers),
      method: input.request.method,
    });

    writeResponseHead(input.response, upstreamResponse);
    if (isEventStream(upstreamResponse)) {
      await proxyStreamingResponse({
        ledger: input.ledger,
        requestIndex,
        response: input.response,
        upstreamResponse,
      });
      return;
    }

    await proxyJsonResponse({
      ledger: input.ledger,
      requestIndex,
      response: input.response,
      upstreamResponse,
    });
  } catch (error) {
    writeProxyError(input.response, error);
  }
}

/**
 * 用预置 mock 响应回包并记录 assistant 消息。
 * 输入：mock 解析器、请求体、requestIndex 与响应流。
 * 输出：无；response 以 200 + JSON 结束。
 * 副作用：写账本；不访问网络。
 * 失败语义：解析器返回 undefined 时抛 Error（缺少 mock 属用例配置错误）。
 * 不变量：先回包再记账；记账失败会向上抛，但客户端已收到响应。
 */
async function writeMockResponse(input: {
  getMockResponse: (requestBody: JsonObject) => unknown;
  ledger: MessageLedger;
  requestBody: JsonObject;
  requestIndex: number;
  response: ServerResponse;
}): Promise<void> {
  const mockResponse = input.getMockResponse(input.requestBody);
  if (mockResponse === undefined) {
    throw new Error(`Missing mock OpenAI response for request ${input.requestIndex}.`);
  }
  const responseBody = normalizeMockResponseForRequest(mockResponse, input.requestBody);
  const responseText = JSON.stringify(responseBody);
  input.response.statusCode = 200;
  input.response.setHeader("content-type", "application/json");
  input.response.end(responseText);
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleNonStreamingAssistantMessage(responseBody),
  );
}

/**
 * mock 规则的消息匹配条件；全部条件同时满足才命中。
 * 文本匹配基于请求 messages/input 的 JSON 序列化结果，属于包含关系而非精确匹配。
 */
interface MockResponseMatch {
  /** 必须全部出现在请求文本中的子串；缺失表示不限制。 */
  allMessageIncludes?: string[];
  /** 必须出现在请求文本中的子串；缺失表示不限制。 */
  messageIncludes?: string;
  /** 任一出现即视为不匹配的子串；用于排除特定上下文。 */
  notMessageIncludes?: string[];
}

/**
 * 一条 mock 响应规则。
 * 无 match 表示无条件命中，此时只按顺序消费。
 */
interface MockResponseRule {
  /** 可选的匹配条件；缺失表示匹配所有请求。 */
  match?: MockResponseMatch;
  /** 命中的响应体，形状不限；后续会按请求协议归一化。 */
  response: unknown;
}

/**
 * 创建有状态的 mock 响应解析器。
 * 输入：mockResponses 数组，元素可为规则对象或裸响应。
 * 输出：按请求体返回响应或 undefined 的函数；同一规则只会被消费一次。
 * 副作用：闭包内维护 consumed 集合与顺序游标。
 * 失败语义：无匹配时返回 undefined，由调用方转成错误。
 * 不变量：规则优先于裸响应；规则之间按数组顺序先到先得。
 */
function createMockResponseResolver(
  mockResponses: readonly unknown[],
): (requestBody: JsonObject) => unknown {
  let sequentialIndex = 0;
  const consumed = new Set<number>();

  return (requestBody) => {
    for (let index = 0; index < mockResponses.length; index += 1) {
      // 已消费的规则不再参与匹配，保证同一条 mock 只回放一次。
      if (consumed.has(index)) continue;
      const rule = asMockResponseRule(mockResponses[index]);
      if (!rule || !matchesMockResponseRule(rule, requestBody)) continue;
      consumed.add(index);
      return rule.response;
    }

    while (sequentialIndex < mockResponses.length) {
      const index = sequentialIndex;
      sequentialIndex += 1;
      // 规则对象交给匹配分支处理，顺序兜底只消费裸响应。
      if (consumed.has(index)) continue;
      if (asMockResponseRule(mockResponses[index])) continue;
      consumed.add(index);
      return mockResponses[index];
    }

    return undefined;
  };
}

/**
 * 识别并收窄 mock 规则对象。
 * 判定口径：必须是普通对象且自身含 response 键；否则视为裸响应。
 * 输出：规则对象或 undefined；match 非法/缺失时省略该字段。
 * 无副作用；不抛错。
 */
function asMockResponseRule(value: unknown): MockResponseRule | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, "response")) return undefined;
  const match = isRecord(value.match) ? readMockResponseMatch(value.match) : undefined;
  return {
    ...(match ? { match } : {}),
    response: value.response,
  };
}

/**
 * 读取并过滤 match 字段。
 * 输入：match 原始对象。
 * 输出：只保留三种受支持条件的对象；非字符串项被丢弃，整体为空时返回空对象。
 * 无副作用；不抛错。
 */
function readMockResponseMatch(value: Record<string, unknown>): MockResponseMatch {
  return {
    ...(Array.isArray(value.allMessageIncludes)
      ? { allMessageIncludes: value.allMessageIncludes.filter(isString) }
      : {}),
    ...(typeof value.messageIncludes === "string"
      ? { messageIncludes: value.messageIncludes }
      : {}),
    ...(Array.isArray(value.notMessageIncludes)
      ? { notMessageIncludes: value.notMessageIncludes.filter(isString) }
      : {}),
  };
}

/**
 * 判断请求是否命中规则。
 * 输入：规则与请求体；匹配文本取 messages，回退 input，再回退空数组。
 * 输出：布尔值；无 match 恒为 true。
 * 口径：messageIncludes 必须出现，allMessageIncludes 全部出现，notMessageIncludes 一个都不能出现。
 * 无副作用；不抛错。
 */
function matchesMockResponseRule(rule: MockResponseRule, requestBody: JsonObject): boolean {
  const match = rule.match;
  if (!match) return true;
  const requestText = JSON.stringify(requestBody.messages ?? requestBody.input ?? []);
  if (match.messageIncludes && !requestText.includes(match.messageIncludes)) return false;
  if (match.allMessageIncludes?.some((value) => !requestText.includes(value))) return false;
  if (match.notMessageIncludes?.some((value) => requestText.includes(value))) return false;
  return true;
}

/**
 * 把 mock 响应归一化到请求所用协议。
 * 输入：mock 响应与请求体。
 * 输出：Responses 请求（含 input 数组）时尽量转成 output 结构；其他情况原样返回。
 * 无副作用；转换失败时回退原值，不抛错。
 * 口径：已有 output 的对象视为 Responses 形状，不再二次包装。
 */
function normalizeMockResponseForRequest(mockResponse: unknown, requestBody: JsonObject): unknown {
  if (!Array.isArray(requestBody.input)) return mockResponse;
  if (isRecord(mockResponse) && Array.isArray(mockResponse.output)) return mockResponse;

  // Responses 协议按 output 数组消费结果，Chat Completions 的 choices 在这里必须换形。
  const message = firstChatChoiceMessage(mockResponse);
  if (!message) return mockResponse;
  const usage = isRecord(mockResponse) ? usageFromChatCompletion(mockResponse.usage) : undefined;
  const base = {
    id: stringProperty(mockResponse, "id") ?? "mock-response",
    created_at: numberProperty(mockResponse, "created") ?? 0,
    model: stringProperty(mockResponse, "model") ?? stringProperty(requestBody, "model"),
    ...(usage ? { usage } : {}),
  };

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    return {
      ...base,
      output: toolCalls.flatMap((toolCall) => responseFunctionCallFromChatToolCall(toolCall)),
    };
  }

  return {
    ...base,
    output: [
      {
        type: "message",
        role: "assistant",
        id: `${base.id}_message`,
        content: [
          {
            type: "output_text",
            text: typeof message.content === "string" ? message.content : "",
            annotations: [],
          },
        ],
      },
    ],
  };
}

/**
 * 取 Chat Completions 首个 choice.message。
 * 输出：消息对象引用或 undefined；形状不符返回 undefined。
 * 无副作用；不拷贝。
 */
function firstChatChoiceMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return first.message;
}

/**
 * 把 Chat 工具调用转为 Responses 的 function_call 项。
 * 输入：任意 tool_call；缺 function 时返回空数组。
 * 输出：0 或 1 个 function_call；call_id 缺失时生成 UUID，保证可被 tool_result 关联。
 * 无副作用；arguments 原样保留为字符串。
 */
function responseFunctionCallFromChatToolCall(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !isRecord(value.function)) return [];
  const callId = stringProperty(value, "id") ?? randomUUID();
  return [
    {
      type: "function_call",
      id: `${callId}_item`,
      call_id: callId,
      name: stringProperty(value.function, "name") ?? "",
      arguments: stringProperty(value.function, "arguments") ?? "",
    },
  ];
}

/**
 * 把 Chat 的 usage 映射为 Responses 的 token 计数。
 * 输入：任意 usage；两个字段都必须是数字才返回。
 * 输出：{ input_tokens, output_tokens } 或 undefined；单位均为 token 数。
 * 无副作用；不抛错。
 */
function usageFromChatCompletion(value: unknown):
  | {
      input_tokens: number;
      output_tokens: number;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberProperty(value, "prompt_tokens");
  const outputTokens = numberProperty(value, "completion_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

/** 读取对象上的字符串属性；对象或值类型不符时返回 undefined。 */
function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

/** 读取对象上的数字属性；对象或值类型不符时返回 undefined。 */
function numberProperty(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

/** 判定普通对象：排除 null 与数组。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判定字符串；用于过滤 mock 匹配条件数组。 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * 转发非流式 JSON 响应并记录 assistant 消息。
 * 输入：上游 Response、ledger 与 requestIndex。
 * 输出：无；响应体原样写回客户端。
 * 副作用：读上游全文、写账本；解析失败时记录 null，不中断转发。
 * 不变量：先结束客户端响应再记账，保证客户端不被记账失败阻塞。
 */
async function proxyJsonResponse(input: {
  ledger: MessageLedger;
  requestIndex: number;
  response: ServerResponse;
  upstreamResponse: Response;
}): Promise<void> {
  const responseText = await input.upstreamResponse.text();
  input.response.end(responseText);
  const parsed = safeJsonParse(responseText);
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleNonStreamingAssistantMessage(parsed),
  );
}

/**
 * 流式转发 SSE 响应，同时缓存分片用于事后归并。
 * 输入：上游 Response（body 可空）、ledger 与 requestIndex。
 * 输出：无；分片按到达顺序写回客户端。
 * 副作用：读取/写出流、写账本；body 为空时直接结束且不记账。
 * 失败语义：读流或写回失败向上抛，由 handleRequest 统一转 502/销毁连接。
 * 不变量：缓存分片与转发分片逐块对应，归并结果与客户端所见一致。
 */
async function proxyStreamingResponse(input: {
  ledger: MessageLedger;
  requestIndex: number;
  response: ServerResponse;
  upstreamResponse: Response;
}): Promise<void> {
  const body = input.upstreamResponse.body;
  if (!body) {
    input.response.end();
    return;
  }

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    // 边转发边缓存，客户端感知延迟不变，事后还能完整归并 assistant 消息。
    input.response.write(value);
  }
  input.response.end();
  await input.ledger.recordAssistantMessage(
    input.requestIndex,
    assembleStreamingAssistantMessage(chunks),
  );
}

/**
 * 解析并校验请求体为 JSON 对象。
 * 输入：原始请求文本。
 * 输出：普通对象；数组与原始类型均拒绝。
 * 失败语义：非 JSON 或非对象时抛 Error，由上层转 502。
 */
function parseRequestBody(bodyText: string): JsonObject {
  const parsed = safeJsonParse(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider proxy only supports JSON OpenAI request bodies.");
  }
  return parsed as JsonObject;
}

/**
 * 宽松 JSON 解析。
 * 输出：解析值，失败返回 null；不抛错，供流式分片与响应体探测使用。
 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把入站请求路径映射到上游 URL。
 * 输入：IncomingMessage 与上游基址。
 * 输出：保留 query 的上游 URL；路径已含上游前缀时不再重复拼接。
 * 无副作用；不抛错（路径非法时由 URL 构造抛出）。
 * 不变量：上游 pathname 去尾斜杠后再与剩余路径拼接，避免双斜杠。
 */
function resolveUpstreamURL(request: IncomingMessage, upstreamBaseURL: URL): URL {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const upstreamPath = upstreamBaseURL.pathname.replace(/\/$/u, "");
  const requestPath = requestUrl.pathname;
  const suffix = requestPath.startsWith(upstreamPath)
    ? requestPath.slice(upstreamPath.length)
    : requestPath;
  const upstream = new URL(`${upstreamPath}/${suffix.replace(/^\/+/u, "")}`, upstreamBaseURL);
  upstream.search = requestUrl.search;
  return upstream;
}

/** 规整基址：仅去除 pathname 尾部斜杠，不改协议、主机与 query。 */
function normalizeBaseURL(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url;
}

/**
 * 复制入站请求头到上游。
 * 输入：IncomingMessage.headers。
 * 输出：新的 Headers；数组值逐项 append，其余 set。
 * 排除口径：host/content-length/connection 由 fetch 重算，转发会导致协议错误。
 * 无副作用；不修改入参。
 */
function forwardHeaders(headers: IncomingMessage["headers"]): Headers {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    // 这些头由 Node/fetch 自行管理，直接转发会造成长度或连接语义冲突。
    if (lower === "host" || lower === "content-length" || lower === "connection") continue;
    if (Array.isArray(value)) {
      for (const item of value) next.append(key, item);
      continue;
    }
    next.set(key, value);
  }
  return next;
}

/**
 * 回写上游状态码与响应头。
 * 输入：客户端响应与上游 Response。
 * 输出：无；仅设置头，不写 body。
 * 排除口径：content-encoding/content-length/connection/transfer-encoding 由 Node 重新协商，
 * 因为代理不解压、也不保证长度一致。
 */
function writeResponseHead(response: ServerResponse, upstreamResponse: Response): void {
  response.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding"
    ) {
      return;
    }
    response.setHeader(key, value);
  });
}

/** 判断上游是否为 SSE：仅看 content-type 是否包含 event-stream，大小写不敏感。 */
function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

/**
 * 读完整个请求体。
 * 输出：UTF-8 文本；空请求体返回空字符串。
 * 副作用：消费请求流，调用后无法再次读取。
 */
async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 把异常写成客户端可读的错误响应。
 * 输入：客户端响应与任意异常。
 * 输出：无；未发送头时回 502 JSON，已发送头时销毁连接。
 * 副作用：写/销毁 response；不抛错。
 */
function writeProxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  response.statusCode = 502;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Provider proxy failed.",
    }),
  );
}

/**
 * 关闭 HTTP 服务并等待所有连接释放。
 * 输出：close 成功后 resolve，否则 reject。
 * 副作用：停止监听端口；不影响已缓存的账本内容。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
