// WebFetch 的「回答问题」阶段：把抽取正文 + 用户 prompt 交给小模型，产出最终结果文本。
//
// 调用链位置：webfetch.ts → 本文件 → context.model.generateText（model adapter）。
// 这是每次未命中缓存且非「预批准 URL 直出」时的一次额外模型调用；工具总预算里它算在
// WebFetch 自身耗时内，因此超时/取消必须透传 context.abortSignal，不能独立挂起。
//
// 语义取舍：模型调用失败不让工具静默返回原文（那等于绕过 prompt 与版权护栏），而是抛
// ProcessingFailed（retryable=true，因为小模型/网络抖动可恢复）；模型返回空文本则降级成
// 一句说明，而不是当成错误——「已抓到页面但没答出内容」对模型是有信息量的终态。
import {
  CoreErrorType,
  createCoreError,
  runWithModelInvocationContext,
  type ModelInputMessage,
  type WebFetchInput,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import { truncateContentForModel } from "./webfetch-content.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";
import type { CachedFetchContent } from "./webfetch-types.js";

interface WebFetchProcessingOptions {
  /** 该 URL 是否命中预批准清单；true 时允许对短 markdown 跳过模型处理，并放宽引用措辞。 */
  preapprovedUrl?: boolean;
}

/**
 * 用正文回答 `input.prompt`，返回可展示的结果文本与截断标记。
 *
 * 输入：已校验的入参、缓存的抓取结果、执行上下文（需 model）、以及是否预批准 URL。
 * 输出 `{ result, truncated }`：模型分支的 result 保证非空（空响应有兜底文案），
 * 预批准直出分支则原样返回正文（正常站点不会为空，但不额外造兜底）。
 * truncated 表示送给模型的正文曾按上限截断。
 * 副作用：一次 generateText 调用（无工具、独立 invocation 上下文与 trace 归属）；
 * 不写缓存、不落 artifact——落盘已由网络层完成。
 *
 * 失败语义：未配置 model → ConfigurationError（recoverable=false，装配问题）；
 * generateText 抛错 → ProcessingFailed（retryable=true，保留原始 cause）。取消信号
 * 直接传给模型调用，中止时同样被包成 ProcessingFailed，最终由 executor 按取消语义收口。
 */
export async function processFetchedContent(
  input: WebFetchInput,
  fetched: CachedFetchContent,
  context: ToolExecutionContext,
  options: WebFetchProcessingOptions = {},
): Promise<{ result: string; truncated: boolean }> {
  if (shouldReturnMarkdownDirectly(fetched, options)) {
    return { result: fetched.content, truncated: false };
  }

  const model = context.model;
  if (!model) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Model is not configured for WebFetch prompt processing",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: WEBFETCH_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const { content, truncated } = truncateContentForModel(fetched.content);
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: buildProcessingPrompt(content, input.prompt, options.preapprovedUrl === true),
    },
  ];

  try {
    const result = await runWithModelInvocationContext(
      {
        // querySource / toolCallId / traceId 是这次内部模型调用归属 WebFetch 工具的唯一凭据；
        // 丢掉它们会让成本与延迟记到错误的调用方上。
        metadata: {
          querySource: "web_fetch_processing",
          traceId: context.traceId,
          toolCallId: context.toolCallId,
          toolName: WEBFETCH_TOOL_NAME,
        },
        modelCall: { operation: "web_fetch_processing" },
        traceContext: traceFromContext(context),
      },
      () =>
        model.generateText({
          messages,
          tools: [],
          options: {
            ...auxiliaryModelOptions(model),
            // 取 min 是必要的：辅模型自身输出上限可能低于 4096，硬写 4096 会被 adapter 拒绝
            // 或截断；上限 4096 是因为这是「摘要式回答」，不需要长文输出预算。
            maxOutputTokens: Math.min(4096, model.optionSpecs.maxOutputTokens.max),
          },
          abortSignal: context.abortSignal,
        }),
    );

    return {
      result:
        result.text.trim() || "WebFetch completed, but the extraction model returned no text.",
      truncated,
    };
  } catch (error) {
    throw webFetchError(
      "ProcessingFailed",
      error instanceof Error ? error.message : "WebFetch prompt processing failed",
      {
        url: fetched.finalUrl,
      },
      error,
    );
  }
}

/**
 * 判断能否跳过模型、直接把正文当结果返回。
 *
 * 三个条件缺一不可：URL 预批准、正文本身是 markdown、且未超输入上限。预批准是前提——
 * 非预批准内容是第三方网页，必须经过 buildProcessingPrompt 的版权/引用约束，直接原文
 * 输出等于把未受约束的内容（含歌词、长段引用）原样塞进上下文。短于上限则是因为没有
 * 截断问题，模型再处理一遍只是重复计费与延迟。
 */
function shouldReturnMarkdownDirectly(
  fetched: CachedFetchContent,
  options: WebFetchProcessingOptions,
): boolean {
  return (
    options.preapprovedUrl === true &&
    fetched.contentType.toLowerCase().includes("text/markdown") &&
    fetched.content.length < MAX_MODEL_INPUT_CHARS
  );
}

/**
 * 拼装处理请求的 user 消息：正文（用分隔线包裹）→ 用户 prompt → 系统式指令。
 *
 * 指令分两档：预批准 URL 只要求「基于内容简洁回答」；普通网页额外加入引用长度上限、
 * 不得逐字复述、不评论合法性、不得产出歌词等护栏——这些约束是对第三方内容的版权与
 * 合规防线，不能被 prompt 注入绕过（用户 prompt 位于正文之后、指令之前，仍受同一约束）。
 */
function buildProcessingPrompt(content: string, prompt: string, preapprovedUrl: boolean): string {
  const instruction = preapprovedUrl
    ? "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed."
    : [
        "Provide a concise response based only on the content above. In your response:",
        " - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.",
        " - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.",
        " - You are not a lawyer and never comment on the legality of your own prompts and responses.",
        " - Never produce or reproduce exact song lyrics.",
      ].join("\n");

  return `
Web page content:
---
${content}
---

${prompt}

${instruction}
`;
}
