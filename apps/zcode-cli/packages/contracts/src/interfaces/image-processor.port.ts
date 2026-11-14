// ============================================================
// Image Processor Port - 图片解码/缩放/压缩的宿主能力边界
// ============================================================
// core 不做图像算法：Read 图片分支、PDF 逐页渲染、MCP 图片规范化都把原始字节
// 交给本端口，由 adapter（Jimp）负责解码、缩放与有损压缩。两个方法职责分离：
// resizeToFit 只按像素上限缩放，prepareForModel 在缩放之外再按字节/token 预算
// 搜索压缩策略。所有方法都必须响应 options.signal，且不缓存任何输入。

import type { TraceContext } from "../tracing/tracer.js";

// 纯缩放请求。data 是原始图片字节（不解码前的状态），mediaType 是声明类型；
// maxDimension 是单边像素上限（宽高同时受约束），必须是正有限数。
// trace 只做日志/诊断关联，不影响处理结果。
export interface ImageResizeRequest {
  data: Uint8Array;
  mediaType: string;
  maxDimension: number;
  trace?: TraceContext;
}

// 缩放结果。data 在无需缩放或格式无法处理（如 webp 直通）时可以是输入原字节；
// resized=false 表示输出尺寸与原始一致。originalWidth/Height 仅在成功解码后存在，
// 直通路径缺席——调用方不得用它们的存在性判断"是否解码过"。
export interface ImageResizeResult {
  data: Uint8Array;
  mediaType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
}

// 稳定错误分类。empty=零字节输入；invalid_request=预算参数非法；
// processing_failed=解码/编码失败；too_large=有损压缩后仍超出预算；
// unsupported=当前实现不支持的媒体类型。调用方按 code 分支，不解析 message。
export type ImageProcessorErrorCode =
  | "empty"
  | "invalid_request"
  | "processing_failed"
  | "too_large"
  | "unsupported";

// 错误详情。cause 保留底层库异常供日志/调试，不进入模型可见文案；
// message 是人类可读说明，调用方不得据此做逻辑判断。
export interface ImageProcessorErrorDetails {
  code: ImageProcessorErrorCode;
  message: string;
  cause?: unknown;
}

// 端口错误类型。携带 code 以便调用方用 isImageProcessorPortError 做类型收窄；
// cause 单独声明是因为 Error.cause 在部分运行时/序列化链路里会丢失。
export class ImageProcessorPortError extends Error {
  readonly code: ImageProcessorErrorCode;
  override readonly cause?: unknown;

  constructor(details: ImageProcessorErrorDetails) {
    super(details.message);
    this.name = "ImageProcessorPortError";
    this.code = details.code;
    this.cause = details.cause;
  }
}

// 错误工厂。统一构造点，保证 name/code/cause 三件套一致；adapter 不应直接 new。
export function createImageProcessorError(
  details: ImageProcessorErrorDetails,
): ImageProcessorPortError {
  return new ImageProcessorPortError(details);
}

// 类型守卫。基于 instanceof，不做跨 realm/序列化后的结构判断：
// 端口错误只在同一进程内产生与消费，跨进程错误必须先映射成 CoreError。
export function isImageProcessorPortError(error: unknown): error is ImageProcessorPortError {
  return error instanceof ImageProcessorPortError;
}

// 压缩策略枚举。original=原样返回；preserve-format=保持源格式重编码；
// png-optimized=PNG 无损优化；png-quantized=PNG 量化；resized=缩放后保持格式；
// jpeg-quality=JPEG 质量阶梯；jpeg-fallback=兜底低质 JPEG。该值只用于诊断/展示
// 与结果归因，调用方不应据此推断输出质量或重试策略。
export type ImageCompressionStrategy =
  | "original"
  | "preserve-format"
  | "png-optimized"
  | "png-quantized"
  | "resized"
  | "jpeg-quality"
  | "jpeg-fallback";

// 模型预算预处理请求。maxBase64Bytes 约束 base64 后载荷；maxRawBytes 约束原始字节；
// maxTokens 与 tokenToBase64CharRatio 用于把 token 预算换算成字节预算（两者需成对使用）。
// 继承 ImageResizeRequest 的 maxDimension：缩放与压缩在同一趟内完成，不拆两次处理。
export interface ImagePrepareForModelRequest extends ImageResizeRequest {
  maxBase64Bytes: number;
  maxRawBytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio?: number;
}

// 预处理结果。compressed 表示输出与输入不同（字节数减少或格式改变）；
// originalSizeBytes 是输入原始大小，transformedSizeBytes 才是实际发送载荷——
// 预算核对/统计必须用后者。strategy 记录命中的压缩路径；resized 继承自缩放结果。
export interface ImagePrepareForModelResult extends ImageResizeResult {
  compressed: boolean;
  originalSizeBytes: number;
  strategy: ImageCompressionStrategy;
  transformedSizeBytes: number;
}

// 图片处理端口。resizeToFit 是无预算的纯缩放（只保证像素上限），
// prepareForModel 是预算驱动的预处理（可能改变格式与质量），调用方按需求选择：
// 只关心尺寸用前者，要交给模型必须用后者。两个方法都接受可选 signal，
// 取消时应尽快中止解码/编码，不得返回部分结果。
export interface ImageProcessorPort {
  resizeToFit(
    request: ImageResizeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImageResizeResult>;
  prepareForModel(
    request: ImagePrepareForModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImagePrepareForModelResult>;
}
