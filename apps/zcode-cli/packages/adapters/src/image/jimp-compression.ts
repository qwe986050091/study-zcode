/**
 * ============================================================================
 * image/jimp-compression.ts —— 图片进模型的压缩策略搜索
 * ============================================================================
 *
 * 【定位】在"尺寸上限 + 原始字节上限 + base64 上限 + token 上限"四维预算下，
 * 按由轻到重的顺序尝试编码候选，返回第一个满足预算的结果：
 *   原图直通 → 原格式无损/质量压缩 → 等比缩放同格式 → JPEG 质量阶梯 →
 *   逐级缩小 + JPEG → 激进 JPEG 兜底。
 *
 * 【为什么不一次性固定参数】不同源图对"缩小"和"降质量"的敏感度差异很大；
 * 先保住分辨率再降质量通常观感更好，所以顺序是分辨率优先、质量为辅。
 *
 * 【副作用】纯 CPU 编解码 + 多次 clone，不写文件、不发网络。
 *
 * 【失败语义】空文件 / 解码失败 / 所有候选都超预算分别抛
 * ImageProcessorError(code="empty" | "processing_failed" | "too_large")；
 * 取消在各编码步骤之间检查并抛普通 Error。
 * ============================================================================
 */
import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import {
  createImageProcessorError,
  type ImageCompressionStrategy,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
} from "@zcode/contracts";
import {
  detectImageMediaType,
  jimpOutputMediaType,
  normalizeMediaType,
  throwIfAborted,
} from "./jimp-media.js";
import {
  createImageBudget,
  fitsImageBudget,
  validatePrepareRequest,
  type ImageBudget,
} from "./image-budget.js";
import { prepareWebpPassthrough } from "./webp-passthrough.js";

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

type ImageCandidate = {
  data: Buffer;
  /** 候选图实际高度；编码失败未填充时为 undefined。 */
  height?: number;
  /** 候选图实际 MIME（可能与源格式不同，例如 PNG 转 JPEG）。 */
  mediaType: string;
  /** 产生该候选的策略名，用于结果回传和诊断。 */
  strategy: ImageCompressionStrategy;
  /** 候选图实际宽度；与 height 同口径。 */
  width?: number;
};

const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;
const PROGRESSIVE_SCALE_FACTORS = [0.75, 0.5, 0.25] as const;
const AGGRESSIVE_JPEG_MAX_EDGES = [1000, 800, 600, 400, 300, 200] as const;
const MIN_IMAGE_EDGE = 1;

/**
 * 按预算准备一张图片。
 *
 * 输入为原始字节与预算参数；输出可能是原图、缩放图或转码图，strategy 标明
 * 最终路径。空文件先失败；WebP 走无转码直通；其余交给候选搜索。
 * 全部候选都超预算时抛 too_large，不返回"超预算但勉强可用"的结果。
 */
export async function prepareJimpImageForModel(
  request: ImagePrepareForModelRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ImagePrepareForModelResult> {
  throwIfAborted(options.signal);
  validatePrepareRequest(request);

  const input = Buffer.from(request.data);
  if (input.byteLength === 0) {
    throw createImageProcessorError({
      code: "empty",
      message: "Image file is empty (0 bytes)",
    });
  }

  const detectedMediaType =
    detectImageMediaType(input) ?? normalizeMediaType(request.mediaType);
  // 以字节探测结果为准；探测失败才信任调用方声明，避免扩展名/MIME 撒谎导致解码错路。
  if (detectedMediaType === "image/webp") {
    return prepareWebpPassthrough(input, request);
  }

  let image: JimpImage;
  try {
    image = await Jimp.read(input);
  } catch (cause) {
    // 解码失败不重试：同一字节再解一次必然还是失败，直接归一成可上报错误。
    throw createImageProcessorError({
      code: "processing_failed",
      message: "Unable to decode image data",
      cause,
    });
  }
  throwIfAborted(options.signal);

  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;
  const budget = createImageBudget(request);
  const sourceMediaType = normalizeMediaType(detectedMediaType);

  if (
    originalWidth <= request.maxDimension &&
    originalHeight <= request.maxDimension &&
    fitsImageBudget(input, budget)
  ) {
    // 原图已满足尺寸与全部字节预算：不重新编码，避免无谓的画质损失。
    return {
      data: input,
      mediaType: sourceMediaType,
      originalHeight,
      originalSizeBytes: input.byteLength,
      originalWidth,
      height: originalHeight,
      width: originalWidth,
      resized: false,
      compressed: false,
      strategy: "original",
      transformedSizeBytes: input.byteLength,
    };
  }

  const candidate = await findFirstFittingCandidate({
    budget,
    image,
    maxDimension: request.maxDimension,
    signal: options.signal,
    sourceMediaType,
  });

  if (candidate) {
    return candidateToResult(candidate, {
      input,
      originalHeight,
      originalWidth,
      sourceMediaType,
    });
  }

  throw createImageProcessorError({
    code: "too_large",
    message: `Unable to compress image (${input.byteLength} bytes) within the requested model image budget`,
  });
}

/**
 * 按固定优先级搜索第一个满足预算的编码候选。
 *
 * 顺序不是随意定的：先试"不动分辨率、只动编码"（对截图/文字图最友好），
 * 再试等比缩小，最后才用低质量 JPEG 兜底。返回 undefined 表示所有候选都超预算，
 * 由调用方抛 too_large。
 */
async function findFirstFittingCandidate(input: {
  budget: ImageBudget;
  image: JimpImage;
  maxDimension: number;
  signal?: AbortSignal;
  sourceMediaType: string;
}): Promise<ImageCandidate | undefined> {
  const originalWithinDimensions =
    input.image.bitmap.width <= input.maxDimension &&
    input.image.bitmap.height <= input.maxDimension;
  // PNG 原尺寸优化失败后，旧策略会在每个缩放档重新尝试 PNG，导致较大尺寸 JPEG
  // 尚可满足预算时先命中低分辨率 PNG。PNG 只保留一次原尺寸无损优化机会；失败后单向转 JPEG。
  const preserveSourceFormatAfterInitialAttempt =
    input.sourceMediaType !== JimpMime.png;

  if (originalWithinDimensions) {
    // 尺寸已达标时，优先在原分辨率上做格式内优化（PNG 重压缩 / JPEG 降质量）。
    const candidate = await findFormatPreservingCandidate(
      input.image,
      input.sourceMediaType,
      input.budget,
      input.signal,
    );
    if (candidate) return candidate;
  }

  const boundedImage = resizeToMaxEdge(input.image, input.maxDimension);
  if (
    preserveSourceFormatAfterInitialAttempt &&
    !sameDimensions(input.image, boundedImage)
  ) {
    const candidate = await fitCandidate(
      encodeCandidate(
        boundedImage,
        input.sourceMediaType,
        "resized",
        input.signal,
      ),
      input.budget,
    );
    if (candidate) return candidate;
  }

  if (!originalWithinDimensions && preserveSourceFormatAfterInitialAttempt) {
    const boundedFormatCandidate = await findFormatPreservingCandidate(
      boundedImage,
      input.sourceMediaType,
      input.budget,
      input.signal,
    );
    if (boundedFormatCandidate) return boundedFormatCandidate;
  }

  const boundedJpegCandidate = await findJpegQualityCandidate(
    boundedImage,
    input.budget,
    input.signal,
  );
  if (boundedJpegCandidate) return boundedJpegCandidate;

  // 分辨率阶梯：每级先试原格式（PNG 除外），再试 JPEG 质量阶梯；
  // 这样能在保住较高分辨率的前提下逐步降体积。
  for (const scale of PROGRESSIVE_SCALE_FACTORS) {
    const scaled = resizeToMaxEdge(
      boundedImage,
      Math.max(MIN_IMAGE_EDGE, Math.round(longestEdge(boundedImage) * scale)),
    );
    if (preserveSourceFormatAfterInitialAttempt) {
      const formatCandidate = await findFormatPreservingCandidate(
        scaled,
        input.sourceMediaType,
        input.budget,
        input.signal,
      );
      if (formatCandidate) return formatCandidate;
    }

    const jpegCandidate = await findJpegQualityCandidate(
      scaled,
      input.budget,
      input.signal,
    );
    if (jpegCandidate) return jpegCandidate;
  }

  // 最后兜底：固定长边上限 + 固定低质量 JPEG，只求"进得去预算"。
  for (const maxEdge of AGGRESSIVE_JPEG_MAX_EDGES) {
    const scaled = resizeToMaxEdge(
      input.image,
      Math.min(maxEdge, input.maxDimension),
    );
    const candidate = await fitCandidate(
      encodeJpegCandidate(scaled, 20, "jpeg-fallback", input.signal),
      input.budget,
    );
    if (candidate) return candidate;
  }

  return undefined;
}

/**
 * 尝试保持源格式输出一个候选。
 *
 * PNG 走高压缩比无损；JPEG 走质量阶梯；GIF 直接原格式重编码。
 * 其他格式返回 undefined，让调用方进入 JPEG 转换路径。
 */
async function findFormatPreservingCandidate(
  image: JimpImage,
  mediaType: string,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<ImageCandidate | undefined> {
  throwIfAborted(signal);
  if (mediaType === "image/png") {
    return fitCandidate(
      encodePngCandidate(image, "png-optimized", signal),
      budget,
    );
  }
  if (mediaType === "image/jpeg") {
    return findJpegQualityCandidate(image, budget, signal);
  }
  if (mediaType === "image/gif") {
    return fitCandidate(
      encodeCandidate(image, "image/gif", "preserve-format", signal),
      budget,
    );
  }
  return undefined;
}

/**
 * 在固定质量阶梯 [80,60,40,20] 中找第一个满足预算的 JPEG。
 *
 * 质量越低体积越小；一旦命中即返回，避免继续产出更差的画质。
 */
async function findJpegQualityCandidate(
  image: JimpImage,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<ImageCandidate | undefined> {
  for (const quality of JPEG_QUALITY_STEPS) {
    const candidate = await fitCandidate(
      encodeJpegCandidate(image, quality, "jpeg-quality", signal),
      budget,
    );
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * 编码后立即做预算判定：超预算返回 undefined，而不是抛出。
 *
 * 这是"候选搜索"的核心语义——单个候选失败是正常路径，只有全部失败才由
 * 最外层抛 too_large。
 */
async function fitCandidate(
  candidatePromise: Promise<ImageCandidate>,
  budget: ImageBudget,
): Promise<ImageCandidate | undefined> {
  const candidate = await candidatePromise;
  return fitsImageBudget(candidate.data, budget) ? candidate : undefined;
}

async function encodeCandidate(
  image: JimpImage,
  mediaType: string,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const outputMediaType = jimpOutputMediaType(mediaType, image.mime);
  const data = await image.getBuffer(outputMediaType);
  throwIfAborted(signal);
  return {
    data,
    mediaType: outputMediaType,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

/**
 * PNG 专用候选：deflateLevel=9 + 过滤策略 3，尽量在不改变像素的前提下压小。
 *
 * 只用于原图尺寸阶段（见 findFirstFittingCandidate 的 PNG 单次尝试注释），
 * 失败后不再对缩放图重复尝试 PNG。
 */
async function encodePngCandidate(
  image: JimpImage,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const data = await image.getBuffer(JimpMime.png, {
    deflateLevel: 9,
    deflateStrategy: 3,
  });
  throwIfAborted(signal);
  return {
    data,
    mediaType: JimpMime.png,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

async function encodeJpegCandidate(
  image: JimpImage,
  quality: number,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const data = await image.getBuffer(JimpMime.jpeg, { quality });
  throwIfAborted(signal);
  return {
    data,
    mediaType: JimpMime.jpeg,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

/**
 * 把候选编码结果折算成对外结果。
 *
 * resized 以宽高是否变化判定；compressed 以"体积变小或格式改变"判定，
 * 两者都可为 false（原图直通）。原始尺寸/体积始终回填源图口径。
 */
function candidateToResult(
  candidate: ImageCandidate,
  input: {
    input: Buffer;
    originalHeight: number;
    originalWidth: number;
    sourceMediaType: string;
  },
): ImagePrepareForModelResult {
  const resized =
    candidate.width !== undefined &&
    candidate.height !== undefined &&
    (candidate.width !== input.originalWidth ||
      candidate.height !== input.originalHeight);
  return {
    data: candidate.data,
    mediaType: normalizeMediaType(candidate.mediaType),
    originalHeight: input.originalHeight,
    originalSizeBytes: input.input.byteLength,
    originalWidth: input.originalWidth,
    height: candidate.height,
    width: candidate.width,
    resized,
    compressed:
      candidate.data.byteLength < input.input.byteLength ||
      normalizeMediaType(candidate.mediaType) !== input.sourceMediaType,
    strategy: candidate.strategy,
    transformedSizeBytes: candidate.data.byteLength,
  };
}

function resizeToMaxEdge(image: JimpImage, maxEdge: number): JimpImage {
  const clone = image.clone();
  if (longestEdge(clone) <= maxEdge) return clone;
  clone.scaleToFit({
    h: maxEdge,
    mode: ResizeStrategy.BICUBIC,
    w: maxEdge,
  });
  return clone;
}

function sameDimensions(left: JimpImage, right: JimpImage): boolean {
  return (
    left.bitmap.width === right.bitmap.width &&
    left.bitmap.height === right.bitmap.height
  );
}

function longestEdge(image: JimpImage): number {
  return Math.max(image.bitmap.width, image.bitmap.height);
}
