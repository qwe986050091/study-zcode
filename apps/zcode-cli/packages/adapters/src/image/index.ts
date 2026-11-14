/**
 * ============================================================================
 * image/index.ts —— ImageProcessorPort 的 Jimp 实现
 * ============================================================================
 *
 * 【定位】把模型图片预算（尺寸/字节数/token）落到本地图像编解码：
 * resizeToFit 只做"不超过 maxDimension"的等比缩放；prepareForModel 走
 * jimp-compression 的多策略压缩。
 *
 * 【副作用】纯 CPU 编解码，不写文件、不发网络请求。
 *
 * 【失败语义】参数非法抛普通 Error；取消通过 signal 在 read/scale/getBuffer
 * 之后检查，抛出 "Image resize was cancelled"；WebP 不做转码，直接透传
 * （预算超限由 prepareForModel 侧失败）。
 * ============================================================================
 */
import { Jimp, ResizeStrategy } from "jimp";
import {
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
  type ImageProcessorPort,
  type ImageResizeRequest,
  type ImageResizeResult,
} from "@zcode/contracts";
import { prepareJimpImageForModel } from "./jimp-compression.js";
import { jimpOutputMediaType, throwIfAborted } from "./jimp-media.js";

/** 创建 Jimp 图片处理器；无状态，调用方通常只创建一次复用。 */
export function createJimpImageProcessorAdapter(): ImageProcessorPort {
  return new JimpImageProcessorAdapter();
}

class JimpImageProcessorAdapter implements ImageProcessorPort {
  /**
   * 等比缩放到 maxDimension 以内。
   *
   * 输入 data 为原始图片字节，maxDimension 是宽高共同上限；输出 mediaType 可能
   * 变化（Jimp 按原格式或回退 png）。resized=false 表示原样返回（含 WebP 透传
   * 与本就够小的图片）。副作用仅 CPU 编解码，不落盘。
   */
  async resizeToFit(
    request: ImageResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageResizeResult> {
    throwIfAborted(options.signal);
    if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
      throw new Error("Image resize maxDimension must be a positive finite number");
    }

    const input = Buffer.from(request.data);
    // 当前 Jimp 构建不支持 WebP 解码/编码，透传比静默转码成 png 更可预期；
    // 预算是否超限由 prepareForModel 的 webp-passthrough 分支负责判定。
    if (request.mediaType === "image/webp") {
      return {
        data: input,
        mediaType: request.mediaType,
        resized: false,
      };
    }

    const image = await Jimp.read(input);
    throwIfAborted(options.signal);

    const originalWidth = image.bitmap.width;
    const originalHeight = image.bitmap.height;
    // 已在上限内时不重新编码，避免无意义的画质损失与 CPU 开销。
    if (originalWidth <= request.maxDimension && originalHeight <= request.maxDimension) {
      return {
        data: input,
        mediaType: request.mediaType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }

    image.scaleToFit({
      h: request.maxDimension,
      mode: ResizeStrategy.BICUBIC,
      w: request.maxDimension,
    });
    throwIfAborted(options.signal);

    const outputMediaType = jimpOutputMediaType(request.mediaType, image.mime);
    const data = await image.getBuffer(outputMediaType);
    throwIfAborted(options.signal);

    return {
      data,
      mediaType: outputMediaType,
      originalWidth,
      originalHeight,
      width: image.bitmap.width,
      height: image.bitmap.height,
      resized: true,
    };
  }

  /**
   * 按模型预算准备图片（缩放 + 压缩策略）。
   *
   * 转发到 jimp-compression：返回的 strategy 标明最终采用了哪种策略
   * （original/resize/compress 等），compressed/resized 是调用方判断是否需要
   * 继续降级的依据。取消与非法参数语义同 resizeToFit。
   */
  prepareForModel(
    request: ImagePrepareForModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImagePrepareForModelResult> {
    return prepareJimpImageForModel(request, options);
  }
}
