import type { Attributes } from "@opentelemetry/api";
import type { ResolvedModelTelemetryDescriptor } from "@zcode/contracts/telemetry";
import {
  compactAttributes,
  integer,
  safeEnum,
  safeId,
  safeIdentifier,
  safeString,
} from "./agent-trace-support.js";

/**
 * 外部语义约定只在这里投影。`zcode.*` 始终是内部查询的权威字段；
 * GenAI、标准 HTTP/Server 字段只用于兼容外部分析工具，避免标准漂移侵入 Writer API。
 *
 * 职责：把工具调用、命令退出、模型尝试与 HTTP 响应的内部事实投影成上述兼容字段。
 * 输入输出：入参为已解析的内部值与原始 id/枚举；输出 Attributes，缺失值由 compactAttributes 过滤。
 * 失败语义：不抛错；非法 origin 或无法解析的 URL 降级为省略对应字段，不写空字符串占位。
 * 不变量：兼容字段只在本文件出现，且永不改写 `zcode.*` 权威字段。
 */
export function toolCompatibilityAttributes(input: {
  toolCallId: string;
  toolName: string;
}): Attributes {
  return compactAttributes({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": safeId(input.toolCallId),
    "gen_ai.tool.name": safeString(input.toolName, 128),
  });
}

/**
 * 命令执行结果的兼容字段。
 *
 * 输入：exitCode 只在进程正常退出时提供；signal 只在被信号终止时提供，二者语义互斥。
 * 输出：`process.exit.code` 与 `process.signal.name`，缺失项不写字段而非写 0/空串。
 * 失败语义：纯投影，不抛错；非法 signal 名会被 safeIdentifier 过滤。
 */
export function commandCompatibilityAttributes(input: {
  exitCode?: number;
  signal?: string;
}): Attributes {
  return compactAttributes({
    "process.exit.code": integer(input.exitCode),
    "process.signal.name": safeIdentifier(input.signal),
  });
}

/**
 * 单次模型请求尝试的兼容字段。
 *
 * 输入：target 为已解析的模型遥测描述符，providerOrigin 来自端点脱敏后的 origin。
 * 输出：provider 枚举、请求模型名、server.address / server.port；port 缺省按协议补 443/80。
 * 失败语义：origin 无法解析时只省略 server.* 字段，provider 与模型名仍照常上报。
 * 不变量：这里不做任何脱敏，providerOrigin 必须已是可上报形态（由端点脱敏层保证）。
 */
export function modelAttemptCompatibilityAttributes(
  target: ResolvedModelTelemetryDescriptor,
): Attributes {
  return compactAttributes({
    "gen_ai.provider.name": safeEnum(target.providerKind),
    "gen_ai.request.model": safeString(target.requestedModel, 128),
    "server.address": serverAddress(target.providerOrigin),
    "server.port": serverPort(target.providerOrigin),
  });
}

/**
 * 模型响应的兼容字段。
 *
 * 输入：finishReason 为 provider 原始结束原因，token 数只在 provider 返回时提供。
 * 输出：`gen_ai.response.*` 与 `gen_ai.usage.*`；finish_reasons 按语义约定包装成数组。
 * 失败语义：纯投影，不抛错；缺失的 token 数不写成 0，以免与真实的 0 混淆。
 */
export function modelResponseCompatibilityAttributes(input: {
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  responseModel?: string;
}): Attributes {
  return compactAttributes({
    "gen_ai.response.finish_reasons": input.finishReason
      ? [safeString(input.finishReason, 128)]
      : undefined,
    "gen_ai.response.model": safeString(input.responseModel, 128),
    "gen_ai.usage.input_tokens": integer(input.inputTokens),
    "gen_ai.usage.output_tokens": integer(input.outputTokens),
  });
}

/** HTTP 响应状态码的兼容字段；入参已是最终状态码，不做区间判定。 */
export function httpResponseCompatibilityAttributes(statusCode: number): Attributes {
  return compactAttributes({
    "http.response.status_code": integer(statusCode),
  });
}

/**
 * 从 origin 取主机名；无法解析时返回 undefined，让调用方省略该字段。
 * origin 为空是正常输入（未配置端点），同样返回 undefined。
 */
function serverAddress(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return safeString(new URL(origin).hostname);
  } catch {
    return undefined;
  }
}

/**
 * 从 origin 推导端口。
 * 规则：显式端口优先；未写端口时按协议补默认值（https 443 / http 80），
 * 其它协议返回 undefined——语义约定不给非 HTTP 端点编造端口。
 */
function serverPort(origin: string | undefined): number | undefined {
  if (!origin) return undefined;
  try {
    const parsed = new URL(origin);
    if (parsed.port) return integer(Number(parsed.port));
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : undefined;
  } catch {
    return undefined;
  }
}
