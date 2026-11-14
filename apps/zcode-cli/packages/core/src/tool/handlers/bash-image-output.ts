/**
 * Bash 图片输出识别：stdout 是 data URL 且能解析成图片时，标记为 image block 并尽量按预算缩放。
 * 由 bash-output.ts 的 toBashOutput 调用（provider 报错时不会走到这里）。
 * 口径是 best-effort：artifact 读不到、解码失败、resize 失败都回退文本/inline，
 * 绝不因为增强失败改变 Bash 原始结果；只有 abort 信号才向上抛出。
 */

import { readFile, stat } from "node:fs/promises";
import {
  READ_IMAGE_MAX_DIMENSION,
  detectImageMediaType,
  isImageProcessorPortError,
  parseImageDataUrl,
  type ParsedImageDataUrl,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { stripClaudeCodeHintLines } from "./bash-semantics.js";

const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

export interface BashImageSource {
  artifactPath?: string;
  artifactSize?: number;
  inline: string;
}

export async function prepareBashImageOutput(
  stdout: BashImageSource,
  context: ToolExecutionContext,
): Promise<{ stdout: string } | undefined> {
  const source = stripClaudeCodeHintLines(await readBashImageSource(stdout));
  const parsed = parseImageDataUrl(source);
  // 只有 stdout 确实是一个可解码的图片 data URL 才进入图片路径；否则交回文本处理。
  if (!parsed) return undefined;
  // 没有 image processor 时不做缩放，直接返回原始 data URL，避免强依赖可选端口。
  if (!context.imageProcessorPort) return { stdout: parsed.dataUrl };

  try {
    const resized = await context.imageProcessorPort.resizeToFit(
      {
        data: parsed.data,
        maxDimension: READ_IMAGE_MAX_DIMENSION,
        mediaType: parsed.mediaType,
        trace: createToolTrace(context),
      },
      { signal: context.abortSignal },
    );
    return {
      stdout: `data:${resized.mediaType};base64,${Buffer.from(resized.data).toString("base64")}`,
    };
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    if (shouldFallbackToOriginalImage(error)) {
      const fallback = fallbackValidImageDataUrl(parsed);
      if (fallback) return fallback;
    }
    // Bash 图片输出是 best-effort 能力；无效图片解码失败时回退文本，避免把坏图片块发给 provider。
    return undefined;
  }
}

async function readBashImageSource(stdout: BashImageSource): Promise<string> {
  if (!stdout.artifactPath) return stdout.inline;

  try {
    const size = stdout.artifactSize ?? (await stat(stdout.artifactPath)).size;
    // 超过 20MB 的 artifact 不再读入内存，直接回退 inline stdout。
    if (size > MAX_IMAGE_FILE_BYTES) return stdout.inline;
    return await readFile(stdout.artifactPath, "utf8");
  } catch {
    // 图片识别是 provider-visible 增强；artifact 临时文件缺失时回退 inline 输出，保留 Bash 原始结果。
    return stdout.inline;
  }
}

function fallbackValidImageDataUrl(input: ParsedImageDataUrl): { stdout: string } | undefined {
  const detected = detectImageMediaType(input.data);
  if (!detected || detected !== input.mediaType) return undefined;
  // 图片 stdout 已经通过 magic 校验时，resize 只是模型预算优化，
  // 不能因为优化失败把模型可见的 image block 降级成原始 data URI 文本。
  return { stdout: input.dataUrl };
}

function shouldFallbackToOriginalImage(error: unknown): boolean {
  // 非端口错误（偶发异常）或端口返回 processing_failed 时都可退回原始 data URL；
  // 端口其它错误码（如不可用）不在此列，交由上层返回 undefined。
  if (!isImageProcessorPortError(error)) return true;
  return error.code === "processing_failed";
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
    },
  } as unknown as TraceContext;
}
