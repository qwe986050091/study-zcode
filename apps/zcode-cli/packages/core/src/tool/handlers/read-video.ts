// Read 工具的视频分支：无转码/压缩依赖（CLI 不引 ffmpeg），只读 base64 + 大小校验。
// wire 侧由 adapter 把 video block 转成 video_url / anthropic video block（见 transform.ts 与两个 AI SDK patch）。
//
// 输入：绝对路径 + 由扩展名推断的 VideoInputMimeType（推断在 attachment-video.ts）。
// 输出：ReadVideoOutput，只有 base64/mime/originalSize 三个事实；不保证任何转码、
// 裁剪或码率处理——那会引入外部二进制依赖，且 provider 端也不接受任意编码。
// 失败语义：FileSystemPort 缺失→ConfigurationError（装配故障，recoverable=false）；
// 空文件/超过 READ_VIDEO_MAX_INPUT_BYTES→ToolExecutionFailed(recoverable=true)，
// 让模型改读其他文件或提示用户压缩；取消信号原样上抛。
// 副作用：仅读取文件；不写盘、不发网络请求。

import {
  CoreErrorType,
  READ_VIDEO_MAX_INPUT_BYTES,
  createCoreError,
  isFileSystemPortError,
  type ReadVideoOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import type { VideoInputMimeType } from "../../runtime/helpers/attachment-video.js";

/**
 * 读取视频文件并返回 provider 可内联的 base64 载荷。
 *
 * @param filePath 已通过工作区约束的绝对路径（由 read.ts 负责）。
 * @param mimeType 扩展名推断出的受支持视频 mime，直接作为输出声明。
 * @returns base64、mime、原始字节数；不返回时长/分辨率（core 不解析容器）。
 * 副作用：一次文件读取（abortSignal 可取消）。
 * 失败：端口缺失→ConfigurationError；空文件/超大→ToolExecutionFailed(recoverable)；
 * 其余 I/O 错误原样抛出。
 * 为什么空文件要单独报错：空的 base64 会生成空 data URL，adapter 随后静默丢弃它，
 * 但 Read 已经宣告成功，模型会以为自己"看过"一段并不存在的视频。
 */
export async function readVideoFile(
  filePath: string,
  mimeType: VideoInputMimeType,
  context: ToolExecutionContext,
): Promise<ReadVideoOutput> {
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

  const trace = createToolTrace(context);
  try {
    const read = await fileSystemPort.readBinaryFile(
      {
        path: filePath,
        maxBytes: READ_VIDEO_MAX_INPUT_BYTES,
        trace,
      },
      { signal: context.abortSignal },
    );
    if (read.bytesRead === 0) {
      // 空 video 会生成空 data URL，随后被 adapter 丢弃，但 Read 已宣告成功。
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "Cannot read an empty video file.", {
        context: {
          code: "read_video_input_empty",
          filePath,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    return {
      type: "video",
      base64: Buffer.from(read.content).toString("base64"),
      mimeType,
      originalSize: read.sizeBytes,
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 与图片分支同一思路：把通用 I/O 的 too_large 转成带 read_video_input_too_large
      // 判别码的业务失败，模型才知道是"视频太大"而不是"路径不对"。
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_video_input_too_large",
          filePath,
          maxBytes: READ_VIDEO_MAX_INPUT_BYTES,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
