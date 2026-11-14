// ============================================================
// AI SDK 运行时接缝（类型 + 默认真实实现）
// 定位：把 ai 包的 generateText/streamText 作为可注入依赖，adapter 其余逻辑只面向接口。
// 输入输出：类型别名直接取自 ai 包参数/返回；defaultRuntime 为真实实现，测试可替换。
// 副作用：本文件仅绑定函数引用，不在加载期发请求。
// 失败语义：运行时错误由 ai 包抛出，adapter 在 runner-retry / runner-generate 中归一化。
// 不变量：ResolvedAiSdkModel 必须同时带 properties（由 core 解析）与可选 accountAccess。
// ============================================================

import type { RequestVerificationReason } from "@zcode/shared";
import { generateText as aiGenerateText, streamText as aiStreamText } from "ai";
import type {
  ModelProperties,
  ModelRequestAuth,
  ModelTextRequest,
  TraceContext,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { AiSdkResolvedModel } from "./model-execution.js";

export type AiSdkGenerateTextOptions = Parameters<typeof aiGenerateText>[0];
export type AiSdkGenerateTextResult = Awaited<ReturnType<typeof aiGenerateText>>;
export type AiSdkStreamTextOptions = Parameters<typeof aiStreamText>[0];
export type AiSdkStreamTextResult = ReturnType<typeof aiStreamText>;
/** 已解析模型：AI SDK 模型 + 模型属性 + 可选账号访问（决定编码套餐/错峰等分支）。 */
export type ResolvedAiSdkModel = AiSdkResolvedModel & {
  properties: ModelProperties;
  accountAccess?: ZCodeProviderAccountAccess;
};

/** 可替换的 AI SDK 运行时；默认指向真实 ai 包导出，测试注入假实现即可离线验证 runner。 */
export interface AiSdkModelRuntime {
  generateText(options: AiSdkGenerateTextOptions): Promise<AiSdkGenerateTextResult>;
  streamText(options: AiSdkStreamTextOptions): AiSdkStreamTextResult;
}

/**
 * adapter 内部使用的文本请求：在 contracts 的 ModelTextRequest 之上补齐
 * abortSignal（取消）、traceContext（观测关联）、按 attempt 刷新鉴权、
 * 以及 core 透传的 idle-timeout 递增序号 / provider stream 边界开关。
 */
export interface AiSdkModelTextRequest extends ModelTextRequest {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  // Start Plan 的账号鉴权材料按 attempt 刷新；adapter 内部 retry 也是真实模型请求，
  // 必须在每个 attempt 发送前给 core/host 一个刷新机会。
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    attempt: number;
    reason?: RequestVerificationReason;
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
  // adapter 测试和开发态常直接使用源文件；这里显式接住 core recovery 透传的 SSE idle timeout 递增序号。
  streamIdleTimeoutRetryNumber?: number;
  // 同一源文件加载边界还需显式接住 compact 专用 provider stream 边界，
  // 避免 contracts 构建产物尚未刷新时 adapter 独立 typecheck 丢失该 runtime-only 字段。
  preserveProviderStreamBoundaries?: boolean;
}

export const defaultRuntime: AiSdkModelRuntime = {
  generateText: aiGenerateText,
  streamText: aiStreamText,
};
