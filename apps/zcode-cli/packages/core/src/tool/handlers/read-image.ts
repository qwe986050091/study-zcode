// ============================================================
// Read 工具图片分支
// ============================================================
// 输入：绝对路径 + 由扩展名推断的 mime；输出结构化 ReadImageOutput（base64，不含 data URL）。
// 本文件不做任何图片算法：读取走 FileSystemPort，缩放/压缩/取尺寸全部委托
// ImageProcessorPort.prepareForModel。这样 core 不引入图像库，跨平台行为由 adapter 保证。
//
// 预算口径（全部来自 contracts，单位是字节/像素，不是 token）：
//   READ_IMAGE_MAX_INPUT_BYTES   读取上限（超过→read_image_input_too_large）
//   READ_IMAGE_MAX_BASE64_BYTES  base64 之后的载荷上限
//   READ_IMAGE_TARGET_BYTES      预处理后的原始字节目标
//   READ_IMAGE_MAX_DIMENSION     单边像素上限
// 两者顺序固定：先按原始文件大小拒绝，再让处理器做有损压缩；反过来会把大文件先读进
// 内存再失败。
//
// 失败语义：端口缺失→ConfigurationError（recoverable=false，装配故障）；
// 读取/预处理失败→ToolExecutionFailed 且 recoverable=true（模型可以换路径或缩小图片）；
// 取消信号原样上抛，不在此吞掉。
//
// 反直觉：processor 返回不支持的 mediaType 时保留**调用方 mime**（见 prepareForModel
// 之后的回退）。ReadImageOutput 的 mimeType 是封闭枚举，写入枚举外的值会让下游
// provider 载荷校验失败；保留原值至少保证 data URL 与声明一致。

import {
  CoreErrorType,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_MAX_INPUT_BYTES,
  READ_IMAGE_TARGET_BYTES,
  READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  isFileSystemPortError,
  isImageProcessorPortError,
  type ReadImageOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

type SupportedReadImageMime = ReadImageOutput["mimeType"];

/**
 * 读取并预处理一张图片，返回结构化媒体输出。
 *
 * 输入：`filePath` 必须已经过工作区路径约束（由 read.ts 的 resolveWorkspacePath 保证）；
 * `mimeType` 来自扩展名推断，是预处理与输出的基准类型。
 * 输出：base64 字符串（非 data URL）、输出 mime、原始/变换后字节数、是否缩放/压缩、
 * 原始与展示尺寸。`originalSize` 是磁盘文件大小，`transformedSize` 是预处理后的字节数，
 * 两者不能混用：前者用于 UI 说明，后者才是实际发给模型的载荷规模。
 * 副作用：读取文件；可能触发 adapter 的 CPU 密集型缩放/压缩。
 * 失败：端口缺失→ConfigurationError；过大/处理器拒绝→ToolExecutionFailed(recoverable)；
 * 取消→原样上抛。
 */
export async function readImageFile(
  filePath: string,
  mimeType: SupportedReadImageMime,
  context: ToolExecutionContext,
): Promise<ReadImageOutput> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }
  if (!context.imageProcessorPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ImageProcessorPort is not configured for image Read",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }

  const trace = createToolTrace(context);
  let read;
  try {
    read = await fileSystemPort.readBinaryFile(
      {
        path: filePath,
        maxBytes: READ_IMAGE_MAX_INPUT_BYTES,
        trace,
      },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 为什么在这里转换错误码：FileSystemPort 的 too_large 是通用 I/O 语义，
      // 进入 Read 的图片分支后必须带上"图片输入过大"的稳定判别码，才能让模型
      // 知道该压缩/裁剪，而不是怀疑路径写错。
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_image_input_too_large",
          filePath,
          maxBytes: READ_IMAGE_MAX_INPUT_BYTES,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }

  try {
    const prepared = await context.imageProcessorPort.prepareForModel(
      {
        data: read.content,
        maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
        maxDimension: READ_IMAGE_MAX_DIMENSION,
        maxRawBytes: READ_IMAGE_TARGET_BYTES,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        mediaType: mimeType,
        tokenToBase64CharRatio: READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
        trace,
      },
      { signal: context.abortSignal },
    );
    // 反直觉：处理器可能输出契约枚举外的 mediaType（例如它内部统一转成 jpeg 的变体）。
    // 此时保留调用方按扩展名推断的类型，避免下游 provider 载荷出现非法 mime；
    // 代价是声明类型可能与实际字节略有不一致，但 data URL 仍可被通用解码器接受。
    const outputMimeType = isSupportedImageMime(prepared.mediaType) ? prepared.mediaType : mimeType;

    return {
      type: "image",
      base64: Buffer.from(prepared.data).toString("base64"),
      mimeType: outputMimeType,
      originalSize: read.sizeBytes,
      transformedSize: prepared.transformedSizeBytes,
      resized: prepared.resized,
      compressed: prepared.compressed,
      compressionStrategy: prepared.strategy,
      dimensions: {
        originalWidth: prepared.originalWidth,
        originalHeight: prepared.originalHeight,
        displayWidth: prepared.width,
        displayHeight: prepared.height,
      },
    };
  } catch (error) {
    if (isImageProcessorPortError(error)) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: `read_image_${error.code}`,
          filePath,
          maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
          maxDimension: READ_IMAGE_MAX_DIMENSION,
          maxInputBytes: READ_IMAGE_MAX_INPUT_BYTES,
          maxRawBytes: READ_IMAGE_TARGET_BYTES,
          maxTokens: READ_MAX_OUTPUT_TOKENS,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }
}

/**
 * 按扩展名推断图片 mime（只做 lower-case 后缀匹配，不嗅探文件头）。
 *
 * 返回 undefined 表示"不是本分支支持的图片"，read.ts 会继续尝试视频/PDF/文本。
 * 只覆盖 jpeg/png/gif/webp 四种 provider 可接受的类型；svg 等文本型图片故意不在此列，
 * 它们走文本读取，避免把 XML 当作二进制媒体塞给 provider。
 * 纯函数、无 I/O；后缀判断对大小写不敏感，但不处理带查询参数的伪路径。
 */
export function inferImageMimeFromPath(path: string): SupportedReadImageMime | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

// 与 ReadImageOutput["mimeType"] 的封闭枚举保持一致；新增类型必须同时改契约，
// 否则这里的 type guard 会与 schema 漂移。
function isSupportedImageMime(value: string): value is SupportedReadImageMime {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

// TraceContext 需要 sessionId，而 ToolExecutionContext 的类型里没有直接暴露它；
// 这里集中做一次形状转换，保证所有 I/O 调用携带同一个 span，避免出现无 traceId 的读盘。
function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
