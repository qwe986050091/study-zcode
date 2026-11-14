// INV-01 首帧截图在缺少归一化能力时必须原样返回：守住位置 第一个 early return；改错故障 宿主无降采样能力时反而丢帧。
// INV-02 只有目标尺寸解析成功且首帧为等比缩放时才进入校正：守住位置 expected 与 firstDimensions 两个判断；改错故障 非等比截图被强行拉伸。
// INV-03 已高于目标的等比首帧走宿主降采样，不再二次抓图：守住位置 尺寸比较分支；改错故障 重抓引入文字细节丢失。
// INV-04 校正倍率必须大于原倍率且差异超过容差才重抓：守住位置 correctedScale 判断；改错故障 无意义重抓让截图耗时翻倍。
// INV-05 重抓最多一次，异常一律回落首帧：守住位置 try/catch 包裹的第二次抓图；改错故障 协议抖动导致截图直接失败。
// INV-06 重抓结果必须重新校验 PNG 尺寸与等比性：守住位置 correctedDimensions 后的两个判断；改错故障 返回被裁剪的残帧。
// INV-07 校正帧仍高于目标时先降采样再比较：守住位置 resize 分支；改错故障 高分辨率帧被直接丢弃。
// INV-08 最终兜底在首帧与校正帧之间取信息量更高者：守住位置 末尾选择函数；改错故障 质量回退到更低的一帧。
// INV-09 PNG 尺寸只解析前 64 字节，不整图解码：守住位置 readPngDimensions 的 slice；改错故障 大图截图让主进程内存飙升。
// INV-10 长度、签名、块类型任一不符必须视为未知尺寸：守住位置 头部校验；改错故障 把非 PNG 数据当图片读。
// INV-11 质量倍率上限 2、下限 1.25，且受 4096 边与 16M 像素约束：守住位置 resolveScreenshotQualityScale；改错故障 生成超大栅格触发图形上限。
// INV-12 目标尺寸由当次 clip 的 CSS 值四舍五入，不假设固定像素比：守住位置 readScreenshotTarget 的 target 构造；改错故障 高分屏与普通屏表现不一致。
// INV-13 clip 缺字段或非有限正数时不校正：守住位置 readScreenshotTarget 校验链；改错故障 非法倍率被送进协议层。
// INV-14 降采样结果必须与目标尺寸误差小于 1px 才采纳：守住位置 resizeScreenshotToTarget 判断；改错故障 返回尺寸不符的图给上层断言。
// INV-15 信息量比较先比像素数，再比与首帧的尺寸距离：守住位置 chooseHigherInformationScreenshot；改错故障 选到更模糊的一帧。
// INV-16 所有降采样与重抓失败都回落到首帧，而不是抛错：守住位置 各 return first 分支；改错故障 截图能力退化为整体失败。
// INV-17 归一化能力缺失时不进入校正链：守住位置 第二个 early return；改错故障 旧宿主上出现未定义行为。
// INV-18 第二次抓图复用原参数的全部字段，只覆盖 scale：守住位置 clip 展开；改错故障 丢失 clip 之外的质量参数。
//
// 模块职责：对协议层截图做 CSS 像素校正，保证返回的栅格与调用方 clip 的 CSS 尺寸一致且信息量最大。
// 状态所有权：本模块不持有状态，所有判据都来自本次调用的参数与 readPngDimensions 读到的首帧/校正帧文件头。
// 阅读顺序：先看主链，再回读尺寸解析、等比判定、质量倍率与降采样四个辅助函数。
import type { ControlledView } from "./browserCommandTypes.js";

interface ScreenshotCaptureResult {
  data?: string;
}

interface ScreenshotDimensions {
  height: number;
  width: number;
}

// 这些常量把「一次截图最多做多少额外工作」固定下来，避免参数化带来跨平台差异。
// 质量倍率上限 MAX_SCREENSHOT_QUALITY_SCALE 必须取 2，用于高分屏；下限 MIN_SCREENSHOT_QUALITY_SCALE 必须取 1.25，表示收益太小的重抓直接放弃。
// MAX_SCREENSHOT_RASTER_EDGE 取 4096：多数图形栈的单边纹理上限；MAX_SCREENSHOT_RASTER_PIXELS 约等于 4096 见方，两者共同兜底显存。
// SCREENSHOT_DIMENSION_EPSILON 取 1px 吸收取整误差；SCREENSHOT_SCALE_EPSILON 取 0.001 吸收浮点除法误差。
// [权衡] 常量而非配置：截图是高频路径，读配置会引入额外 IO 与缓存一致性负担。
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const SCREENSHOT_DIMENSION_EPSILON = 1;
const SCREENSHOT_SCALE_EPSILON = 0.001;
const MAX_SCREENSHOT_QUALITY_SCALE = 2;
const MIN_SCREENSHOT_QUALITY_SCALE = 1.25;
const MAX_SCREENSHOT_RASTER_EDGE = 4096;
const MAX_SCREENSHOT_RASTER_PIXELS = 16_777_216;

// [资源] 只解 base64 前 64 字节，够覆盖 8 字节签名与块头。
// 返回 null 表示「不是可识别的 PNG」，调用方据此放弃校正而不是抛错。
// 宽高任一为 0 必须视为非法尺寸，避免 readPngDimensions 后续除法出现无穷大。
// 内部捕获兜住解码异常，保证这条路径永不向上抛。
function readPngDimensions(data: string): ScreenshotDimensions | null {
  try {
    // PNG 的 signature + IHDR 尺寸只占前 24 bytes，避免为了读宽高复制整张大图。
    const header = Buffer.from(data.slice(0, 64), "base64");
    if (
      header.byteLength < 24 ||
      PNG_SIGNATURE.some((byte, index) => header[index] !== byte) ||
      header.toString("ascii", 12, 16) !== "IHDR"
    ) {
      return null;
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function screenshotDimensionDistance(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): number {
  return (
    Math.abs(actual.width - target.width) / target.width +
    Math.abs(actual.height - target.height) / target.height
  );
}

function screenshotMatchesTarget(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): boolean {
  return (
    Math.abs(actual.width - target.width) < SCREENSHOT_DIMENSION_EPSILON &&
    Math.abs(actual.height - target.height) < SCREENSHOT_DIMENSION_EPSILON
  );
}

function screenshotHasUniformScale(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): boolean {
  return (
    Math.abs(actual.width / target.width - actual.height / target.height) <=
    SCREENSHOT_SCALE_EPSILON
  );
}

// 综合三个上限必须取最小值：边上限、像素总量上限、固定倍率上限。
// 目标本身很小时倍率可能被算成极大值，因此必须有固定上限夹住。
// [权衡] 低于下限时返回 1：多抓一次大图再降采样的收益抵不过延迟。
// Number.isFinite 检查兜住目标为 0 时的除法结果，防止非法值流入协议层。
function resolveScreenshotQualityScale(target: ScreenshotDimensions): number {
  const targetPixels = target.width * target.height;
  const qualityScale = Math.min(
    MAX_SCREENSHOT_QUALITY_SCALE,
    MAX_SCREENSHOT_RASTER_EDGE / target.width,
    MAX_SCREENSHOT_RASTER_EDGE / target.height,
    Math.sqrt(MAX_SCREENSHOT_RASTER_PIXELS / targetPixels),
  );

  // 大视口本身已有足够像素。倍率过小时收益有限，却仍会增加一次大图 capture。
  return Number.isFinite(qualityScale) && qualityScale >= MIN_SCREENSHOT_QUALITY_SCALE
    ? qualityScale
    : 1;
}

// 宿主未提供降采样能力时返回 null，调用方沿用原始帧。
// [失败路径] 降采样抛错或返回空数据都不影响主链，只是放弃这次优化。
// 结果必须重新解析文件头，确认尺寸真的落到目标上而不是近似值。
// 只有尺寸精确匹配才替换数据，其余情况返回 null 让调用方保留首帧。
async function resizeScreenshotToTarget(
  view: ControlledView,
  result: ScreenshotCaptureResult,
  target: ScreenshotDimensions,
): Promise<ScreenshotCaptureResult | null> {
  if (!view.resizeScreenshotToCssPixels || !result.data) return null;
  try {
    const resizedData = await view.resizeScreenshotToCssPixels(result.data, target);
    if (!resizedData) return null;
    const resizedDimensions = readPngDimensions(resizedData);
    return resizedDimensions && screenshotMatchesTarget(resizedDimensions, target)
      ? { ...result, data: resizedData }
      : null;
  } catch {
    return null;
  }
}

// 像素数更多意味着细节更多，这是 chooseHigherInformationScreenshot 的首要比拼维度。
// 像素数相同时必须比较 screenshotDimensionDistance 得到的尺寸距离，距离更近说明缩放更少、重采样损失更小。
// 两个候选都来自同一 clip，因此不需要再校验等比性。
// 返回的一定是入参之一，不会新建对象，避免调用方误判数据来源。
function chooseHigherInformationScreenshot(
  first: ScreenshotCaptureResult,
  firstDimensions: ScreenshotDimensions,
  second: ScreenshotCaptureResult,
  secondDimensions: ScreenshotDimensions,
): ScreenshotCaptureResult {
  const firstPixels = firstDimensions.width * firstDimensions.height;
  const secondPixels = secondDimensions.width * secondDimensions.height;
  if (secondPixels !== firstPixels) return secondPixels > firstPixels ? second : first;
  return screenshotDimensionDistance(secondDimensions, firstDimensions) <= SCREENSHOT_SCALE_EPSILON
    ? second
    : first;
}

// clip 必须是普通对象，数组与空值都视为未提供。
// 三个字段都要是有限正数，缺一即放弃校正，走原样返回。
// 栅格只有整数像素，CSS 侧的亚像素尺寸在这里取整并以 1 为下限。
// 返回的倍率保留原始值，后续计算以它为基线。
function readScreenshotTarget(params: Record<string, unknown>): {
  scale: number;
  target: ScreenshotDimensions;
} | null {
  const clip = params.clip;
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) return null;
  const value = clip as { height?: unknown; scale?: unknown; width?: unknown };
  if (
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    value.scale <= 0
  ) {
    return null;
  }
  return {
    scale: value.scale,
    // PNG raster 只有整数像素；CSS clip 可能来自带小数的 content metrics。
    target: {
      width: Math.max(1, Math.round(value.width)),
      height: Math.max(1, Math.round(value.height)),
    },
  };
}

// 主链：抓首帧 → 解析目标 → 判等比 → 高帧降采样或小幅重抓 → 择优返回。
// [时序] attach 初期首帧可能只是低清栅格，因此尺寸匹配并不能证明细节完整。
// 所有分支都以「返回一帧」为终点，宁可质量略低也不让截图失败。
export async function captureScreenshotWithCssPixelCorrection(
  view: ControlledView,
  params: Record<string, unknown>,
): Promise<ScreenshotCaptureResult> {
  const first = (await view.cdp.send("Page.captureScreenshot", params)) as ScreenshotCaptureResult;
  if (!view.normalizeScreenshotToCssPixels || !first.data) return first;

  const expected = readScreenshotTarget(params);
  const firstDimensions = readPngDimensions(first.data);
  if (!expected || !firstDimensions) return first;
  if (!screenshotHasUniformScale(firstDimensions, expected.target)) return first;

  if (
    firstDimensions.width > expected.target.width &&
    firstDimensions.height > expected.target.height
  ) {
    // Retina/guest compositor 返回高分辨率首帧后，再用小数 CDP
    // scale capture 会在 Chromium 渲染阶段丢失文字细节。目标尺寸必须来自当次
    // CSS clip，对已渲染的高分辨率 PNG 做宿主侧高质量降采样，不假设固定 DPR。
    return (await resizeScreenshotToTarget(view, first, expected.target)) ?? first;
  }

  const firstMatchesTarget = screenshotMatchesTarget(firstDimensions, expected.target);
  const widthCorrection = expected.target.width / firstDimensions.width;
  const heightCorrection = expected.target.height / firstDimensions.height;
  const qualityScale = view.resizeScreenshotToCssPixels
    ? resolveScreenshotQualityScale(expected.target)
    : 1;
  if (firstMatchesTarget && qualityScale === 1) return first;

  const correctedScale =
    expected.scale *
    (firstMatchesTarget ? qualityScale : ((widthCorrection + heightCorrection) / 2) * qualityScale);
  if (
    !Number.isFinite(correctedScale) ||
    correctedScale < expected.scale ||
    Math.abs(correctedScale - expected.scale) < SCREENSHOT_SCALE_EPSILON
  ) {
    return first;
  }

  // attach/首帧时序下，IHDR 恰好等于 CSS 目标也可能只是已经丢失细节的
  // 低清 raster。不能把固定的 1280×720/Retina DPR 当判据；按当次 clip 动态计算
  // 有界质量源，最多重抓一次，再由宿主图像引擎降采样到 CSS 目标。
  let corrected: ScreenshotCaptureResult;
  try {
    corrected = (await view.cdp.send("Page.captureScreenshot", {
      ...params,
      clip: {
        ...(params.clip as Record<string, unknown>),
        scale: correctedScale,
      },
    })) as ScreenshotCaptureResult;
  } catch {
    return first;
  }
  if (!corrected.data) return first;
  const correctedDimensions = readPngDimensions(corrected.data);
  if (!correctedDimensions) return first;
  if (!screenshotHasUniformScale(correctedDimensions, expected.target)) return first;
  if (screenshotMatchesTarget(correctedDimensions, expected.target)) return corrected;
  if (
    correctedDimensions.width > expected.target.width &&
    correctedDimensions.height > expected.target.height
  ) {
    const resized = await resizeScreenshotToTarget(view, corrected, expected.target);
    if (resized) return resized;
  }
  return chooseHigherInformationScreenshot(first, firstDimensions, corrected, correctedDimensions);
}
