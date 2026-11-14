// HTTP 响应的统一解析出口：把请求失败与 JSON 解码失败都归一成 ApiError，调用方只需 catch 一次。
// 保留 method/url/status 与诊断响应头，便于在日志和错误面板里直接定位一次失败请求。
// 本模块不重试、不降级、不读取 body 两次；任何语义决策留给上层业务。
import { ApiError, type ApiClient, type ApiRequestInit } from "@zcode/shared";

// 只挑排障必需的链路追踪头，白名单方式避免把鉴权或业务头写入错误对象造成泄漏。
// 名称统一小写，Headers.get 大小写不敏感，输出键也保持小写便于比较。
const DIAGNOSTIC_RESPONSE_HEADER_NAMES = ["x-request-id", "x-trace-id", "x-span-id"] as const;

// 未显式指定方法时按 HTTP 语义视为 GET，并统一大写以匹配服务端与日志口径。
// 仅做归一化，不做方法合法性校验，非法方法应由底层客户端或服务端拒绝。
function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

// 统一成字符串是为了把原始地址带进 ApiError；URL 对象直接序列化会丢失部分可读信息。
function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

// 无任何诊断头时返回 undefined 而非空对象，避免错误对象里出现无意义的空字段。
// 值经过 trim 且空串视为缺失，防止服务端返回空白头污染诊断信息。
function readDiagnosticResponseHeaders(headers: Headers): Record<string, string> | undefined {
  const responseHeaders: Record<string, string> = {};

// 逐个白名单读取而非遍历 response.headers，既能控制输出规模，也不依赖 Headers 迭代实现。
// Headers.get 只取首个值，多值头在本场景没有诊断意义。
  for (const name of DIAGNOSTIC_RESPONSE_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) {
      responseHeaders[name] = value;
    }
  }

  return Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined;
}

// 错误响应体格式不统一，先按 error/message/msg/detail 顺序尝试，再退回状态码。
// 读取 body 失败（网络中断、流已消费）时退化为状态码文本，保证错误信息永远非空。
// 这里吞掉所有异常是刻意的：它只服务于构造错误对象，不能再抛出第二个错误。
async function readResponseMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();
    const trimmed = body.trim();
// 空响应体同样以状态码兜底，避免 ApiError.message 为空导致上层日志出现空白行。
    if (!trimmed) {
      return `HTTP ${response.status}`;
    }

    try {
// 二次 try 包住 JSON.parse：非 JSON 错误体（如 HTML 网关页）应原样返回文本而非报解析错误。
// 字段类型收窄到 string 才采用，防止把对象或数字直接拼进 message。
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        message?: unknown;
        msg?: unknown;
        detail?: unknown;
      };
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.msg === "string"
              ? parsed.msg
              : typeof parsed.detail === "string"
                ? parsed.detail
                : "";
// 解析成功但目标字段为空时仍回退到状态码，保证返回值既非空也不含前后空白。
      return message.trim() || `HTTP ${response.status}`;
    } catch {
      return trimmed;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

// 导出入口的契约：成功返回已解析的 T，失败一律抛 ApiError，绝不返回 undefined。
// readApiJson 的泛型 T 由调用方声明，运行时不校验响应结构；结构校验应在具体业务层完成。
// 非 2xx 分支先读完 body 再抛错，确保底层连接可复用且错误信息完整。
// 请求本身抛出的异常（网络/超时）原样透传，只有 HTTP 与解析失败被包装。
export async function readApiJson<T>(
  apiClient: ApiClient,
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  // url 只用于错误对象展示，请求必须用原始 input，避免 URL 对象序列化影响底层客户端。
  const url = resolveUrl(input);
  const method = resolveMethod(init);
// 请求只发一次：重试策略由上层决定，此处重放可能造成重复写入等副作用。
  // apiClient 与 init 由调用方提供，本文件不补默认头、不重试，保证一次调用只发一次请求。
  const response = await apiClient.request(input, init);

// 状态码判定放在解析之前：错误响应通常不是目标 JSON，先解析只会掩盖真实原因。
// readDiagnosticResponseHeaders 在错误路径上也要调用，这是排查 4xx/5xx 时最常缺失的信息。
  // 非 2xx 一律先读 body 再抛 ApiError，调用方只需要 catch 一种异常类型。
  if (!response.ok) {
    // message 永远非空：读体失败与空体都退回 HTTP <status>，避免日志出现空白错误。
    const message = await readResponseMessage(response);
    throw new ApiError({
      message,
      url,
      method,
      status: response.status,
      responseHeaders: readDiagnosticResponseHeaders(response.headers),
    });
  }

  try {
    // readApiJson 成功分支不再校验结构：T 由调用方声明，结构校验属于具体业务的职责。
    return (await response.json()) as T;
  } catch (error) {
    // 解析失败同样带上诊断头与 cause，调用方无需区分 HTTP 失败与 JSON 失败。
    throw new ApiError({
      message: error instanceof Error ? error.message : "Invalid JSON response",
      url,
      method,
      status: response.status,
      responseHeaders: readDiagnosticResponseHeaders(response.headers),
      cause: error,
    });
  }
}
