// ---------------------------------------------------------------
// 图片媒体契约：魔数探测、data URL 解析与媒体类型归一化
//
// 生产者：core 的附件/图片处理流程在把用户图片转成模型内容块之前调用。
// 消费者：adapter 以返回的 mediaType/dataUrl 组装 provider 请求；UI 只用 mediaType 展示。
// 边界：这里只做格式识别与解码，不做缩放、压缩或预算裁剪——媒体预算属于
// media-policy.ts，能否发给 provider 由 adapter 按模型能力判定。
// 不变量：解析结果必须自洽（data 与 base64 同源），mediaType 一律小写且 jpg 归一为 jpeg。
// ---------------------------------------------------------------

/**
 * 可识别的图片媒体类型白名单：只覆盖能可靠按魔数识别的格式。
 *
 * 生产者：detectImageMediaType 的返回类型。
 * 消费者：上传校验、content block 组装与 provider 能力判断。
 * 不变量：这是“已识别”的封闭集合；未列入的格式（如 heic/svg）会被当作未知，
 * 不得在此扩展成“任意 image/*”，否则下游会误以为数据可安全解码。
 */
export type DetectedImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * data URL 解析结果：同一张图的三份等价表示，供不同消费面使用。
 *
 * 生产者：parseImageDataUrl（仅解析，不做二次编码）。
 * 消费者：adapter 用 dataUrl 发请求，图片处理用 data 做尺寸/压缩，sha/去重可用 base64。
 * 不变量：base64 已去掉空白且通过字符集校验；dataUrl 由归一化后的 mediaType 与
 * base64 重建，不能与入参原串逐字相等（大小写/换行会被规范化）。
 */
export interface ParsedImageDataUrl {
  /** 去除空白后的 base64 正文；不含 data: 前缀，可直接作为缓存键的一部分。 */
  base64: string;
  /** 解码后的字节；长度与 base64 一致，供魔数探测或图片处理使用。 */
  data: Uint8Array;
  /** 归一化 mediaType 重建的完整 data URL，可直接进入模型内容块。 */
  dataUrl: string;
  /** 小写媒体类型；image/jpg 已归一为 image/jpeg。 */
  mediaType: string;
}

/**
 * data URL 解析开关：默认严格，宽松模式只放宽“base64 内部空白”。
 *
 * 生产者：调用方按来源选择（例如粘贴文本允许换行，内部生成的数据必须严格）。
 * 消费者：parseImageDataUrl 的空白校验与重编码。
 * 不变量：宽松模式只删除空白字符，不修补非法字符；两种模式都必须通过
 * base64 字符集与长度校验，不能因为宽松而接受损坏数据。
 */
export interface ParseImageDataUrlOptions {
  allowWhitespace?: boolean;
}

/**
 * 按文件头魔数识别图片类型，不信任扩展名或 data URL 声明。
 *
 * 生产者：附件/图片导入流程（拿原始字节做真实格式校验）。
 * 消费者：媒体类型归一、provider 能力判断与安全过滤。
 * 不变量：各分支各自校验最少字节数，避免短缓冲区越界误判；无法识别返回
 * undefined 而不是猜测，调用方必须按“不支持”处理。
 */
export function detectImageMediaType(buffer: Uint8Array): DetectedImageMediaType | undefined {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * 解析 `data:image/*;base64,...`，产出可直接用于模型请求的结构化结果。
 *
 * 生产者：附件导入、粘贴图片、工具产出的内联图片等所有 data URL 入口。
 * 消费者：adapter 的图片内容块组装与本地图片处理。
 * 不变量：媒体类型必须匹配 `image/*`；base64 需通过字符集/长度校验且解码非空；
 * 返回的 dataUrl 用归一化 mediaType 重建，保证同图不同写法得到同一结果。
 * 解析失败一律返回 undefined，由调用方降级成占位文本，而不是抛错中断请求装配。
 */
export function parseImageDataUrl(
  value: string,
  options: ParseImageDataUrlOptions = {},
): ParsedImageDataUrl | undefined {
  const dataUrl = value.trim();
  const match = /^data:(image\/[a-z0-9.+_-]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match?.[1] || !match[2]) return undefined;

  const rawBase64 = match[2];
  if (!options.allowWhitespace && /\s/.test(rawBase64)) return undefined;
  const base64 = options.allowWhitespace ? rawBase64.replace(/\s/g, "") : rawBase64;
  if (!isValidBase64Payload(base64)) return undefined;

  const data = Buffer.from(base64, "base64");
  if (data.byteLength === 0) return undefined;

  const mediaType = normalizeImageMediaType(match[1]);
  return {
    base64,
    data,
    dataUrl: `data:${mediaType};base64,${base64}`,
    mediaType,
  };
}

/**
 * 归一化图片媒体类型：统一小写，并把非标准的 image/jpg 映射为 image/jpeg。
 *
 * 生产者：parseImageDataUrl 在重建 dataUrl 之前调用。
 * 消费者：provider 请求与能力匹配（多数 provider 只认 image/jpeg）。
 * 不变量：只做别名与大小写归一，不猜测未知类型；非 image 类型原样返回，
 * 是否合法仍由上游 data URL 正则约束。
 */
export function normalizeImageMediaType(value: string): string {
  const lower = value.toLowerCase();
  return lower === "image/jpg" ? "image/jpeg" : lower;
}

function isValidBase64Payload(value: string): boolean {
  return value.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
