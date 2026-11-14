// ==========================================================================
// 职责边界（image-preview-dialog.tsx）
// 做：
//   - 渲染全屏媒体 gallery：图片缩放/拖拽/双指捏合，键盘左右切换。
//   - 下载当前图片：saveFile → 有界 fetch → 浏览器原生下载三级降级。
//   - 依据 MIME 与实际字节协商扩展名，并清洗文件名中的非法字符。
// 不做：
//   - 不持有 gallery 选中项所有权，activeIndex 只是 initialIndex 的本地投影。
//   - 不转码、不生成缩略图、不做断点续传，blob 会原样交给 createObjectURL。
//   - 下载失败不关闭弹窗、不切换索引、不改写 item 元数据。
// 依赖：
//   - IPlatformService.saveFile（桌面保存）与 useZCodeIntl（全部文案）。
//   - DOM 的 offsetWidth/clientWidth 是裁剪边界的唯一尺寸来源。
// 边界：
//   - 日志只能写脱敏后的 source；签名 URL 的 query/fragment 永不落盘。
//   - 视频与图片共享索引，但播放与变换生命周期完全隔离。
//   - 组件内状态只服务当前 activeIndex，不跨项复用，也不上升到 store。
//
// INV 不变量表（18 条；破坏任一条都是静默 UI 故障）：
// INV-01 断言：activeIndex 是唯一选中项，换项必须同时重置缩放与位移 —— 守住它的位置：navigate 与 open 同步 effect、resetPreviewTransform —— 改错故障：上一张的 transform 残留到下一张
// INV-02 断言：previewOffset 永远落在 clampImagePreviewOffset 给出的对称边界内 —— 守住它的位置：changePreviewScale、resize effect、handlePointerMove —— 改错故障：图片被拖出视口且无法找回
// INV-03 断言：previewScale 恒在 0.5 到 3 之间，由按钮与捏合分支共同收口 —— 守住它的位置：两处 Math.min 与 Math.max —— 改错故障：缩放越界，transform 溢出视口
// INV-04 断言：单次下载驻留内存的字节数不超过 MAX_DOWNLOAD_BYTES —— 守住它的位置：content-length 预检与 receivedBytes 累计 —— 改错故障：超大图占满 renderer 内存
// INV-05 断言：下载降级顺序固定为 saveFile、有界 fetch、原生下载 —— 守住它的位置：downloadImagePreview 的三个分支 —— 改错故障：桌面错走内存路径或 Web 失去上限
// INV-06 断言：file_too_large 永不进入原生下载回退 —— 守住它的位置：catch 分支的 code 判断 —— 改错故障：50MB 保护被静默绕过
// INV-07 断言：canceled 结果原样返回且不写错误日志 —— 守住它的位置：两个 saveFile 分支 —— 改错故障：用户取消被报成下载失败
// INV-08 断言：日志中的 source 不含 userinfo、query、fragment —— 守住它的位置：sanitizeImageSourceForLog —— 改错故障：签名 token 落入持久化日志
// INV-09 断言：data: 与 blob: 永不进入 URL 解析分支 —— 守住它的位置：isHttpSource 前置判断 —— 改错故障：new URL 抛错击穿整个下载
// INV-10 断言：最终扩展名必须与 blob.type 兼容，不相容后缀要丢弃 —— 守住它的位置：imageDownloadFilename 的 compatible —— 改错故障：png 被命名成 jpg，系统解码失败
// INV-11 断言：下载基名非空且已剥离路径与控制字符 —— 守住它的位置：safeDownloadBaseName —— 改错故障：主进程保存抛错，整个下载失败
// INV-12 断言：objectURL 创建后必定 revoke —— 守住它的位置：downloadImagePreview 末尾 —— 改错故障：blob 内存泄漏，长会话内存上涨
// INV-13 断言：pointer capture 必须在抬手与重置时释放 —— 守住它的位置：handlePointerEnd 与 resetPreviewTransform —— 改错故障：后续 hover/click 命中错误层级
// INV-14 断言：pointer map 与 pinchStartRef 同步增减 —— 守住它的位置：handlePointerDown、handlePointerMove、handlePointerEnd —— 改错故障：双指变单指时图片瞬移
// INV-15 断言：切项或关闭必须 pause 旧 video —— 守住它的位置：依赖 activeIndex 与 open 的清理 effect —— 改错故障：旧视频继续解码并发出声音
// INV-16 断言：键盘监听在 effect 清理中移除 —— 守住它的位置：依赖 activeIndex、items.length、open 的 effect —— 改错故障：监听器累积，左右键一次跳多张
// INV-17 断言：initialIndex 只在 open 或长度变化时归一化一次 —— 守住它的位置：同步 effect —— 改错故障：每次重渲染都把浏览位置拉回初值
// INV-18 断言：下载失败不改变弹窗可见性与 activeIndex —— 守住它的位置：downloadActiveImage 的 catch —— 改错故障：一次网络错误直接关闭预览
"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { IPlatformService } from "@zcode/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export interface ImagePreviewDialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  loading?: boolean;
  mediaType?: string;
  src?: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface PreviewSize {
  height: number;
  width: number;
}

// [契约] defaultPreviewOffset 是全模块共享的冻结起点，previewOffset 只允许从这里派生。
// 它必须保持引用稳定：resetPreviewTransform 直接写入该常量，避免多一次对象分配。
// 不要改成读取 DOM 初值：首次渲染时 ref 还没挂载，量到的一定是 0。
// 改错后果：图片首次打开带着上一张的位移，表现为新图偏移出屏。
const defaultPreviewOffset: PreviewOffset = { x: 0, y: 0 };
// [契约] 50MB 上限同时约束 content-length 预检和流式累计，两处必须用同一常量。
// 下调它会让 Web 下载提前失败；上调会让恶意响应直接撑爆 renderer 内存。
// 不要在这里按 mediaType 分支放宽，gif/apng 同样是原始字节。
// 改错后果：超限图片要么被误判失败，要么绕过保护占满内存。
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

// [契约] MIME 到扩展名的映射是下载文件名的唯一字典，键必须是小写无参数 MIME。
// 查表前调用方已做 toLowerCase 与分号截断，这里不要重复 normalize。
// 新增类型要与服务端 mediaType 白名单同步，否则会退化成 bin。
// 改错后果：保存出 .bin 文件，系统不再用图片查看器打开。
const imageExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function imageDownloadFilename(item: ImagePreviewDialogItem, mediaType = item.mediaType ?? "") {
  const knownExtension = imageExtensionByMediaType[mediaType.toLowerCase().split(";")[0] ?? ""];
  // [契约] 只有 http(s) 才解析 URL 取 pathname；data: 与 blob: 直接跳过。
  // 非法 URL 在 new URL 处抛错会击穿整个下载，必须先过 isHttpSource。
  // pathname 只用于推断后缀，不参与鉴权或实际请求。
  // 改错后果：data-url 预览点下载直接抛异常，toast 变成下载失败。
  let sourcePath: string | undefined;
  if (item.src && isHttpSource(item.src)) sourcePath = new URL(item.src).pathname;
  // [契约] 允许沿用的后缀集合由字典值推导，jpeg 是唯一额外别名。
  // sourceExtension 与 knownExtension 不相等时会被丢弃，避免 png 字节命名成 jpg。
  // 不要改成手写白名单，imageExtensionByMediaType 新增类型时两边必然漂移。
  // 改错后果：已知 MIME 的图片被错误后缀命名，下游按后缀解码失败。
  const supportedExtensions = new Set([...Object.values(imageExtensionByMediaType), "jpeg"]);
  const sourceExtension = [item.filename, sourcePath, item.alt]
    .map((name) => /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "")?.[1]?.toLowerCase())
    .find((extension) => extension !== undefined && supportedExtensions.has(extension));
  // 原字节不能统一命名成 PNG；未知 MIME 保留可信图片后缀，已知 MIME 拒绝不相容的后缀。
  const compatible =
    !knownExtension || (sourceExtension === "jpeg" ? "jpg" : sourceExtension) === knownExtension;
  const extension = (compatible ? sourceExtension : undefined) ?? knownExtension ?? "bin";
  return `${safeDownloadBaseName(item)}.${extension}`;
}

// [契约] 纯函数、无副作用，输入输出都是 PreviewOffset，组件内外必须共用它。
// 它假设 imageSize 与 viewportSize 都是缩放前尺寸，scale 由调用方单独传入。
// 不要在这里读 DOM 或 ref：渲染期读布局会造成测量抖动。
// 改错后果：拖拽边界分裂成两套算法，图片能被拖到视口外无法找回。
export function clampImagePreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: PreviewSize,
  viewportSize: PreviewSize,
): PreviewOffset {
  // [权衡] maxX/maxY 取 Math.max(0, ...) 是图片小于视口时禁止位移的语义。
  // 缩放到小于视口时必须强制归零，否则残留 offset 会让小图贴边而不是居中。
  // 不要省略 0 下限：负的上限会让 Math.min 与 Math.max 互相打架。
  // 改错后果：maxX/maxY 少了 0 下限会导致位移越界，缩小后图片停在角落，用户以为缩放按钮失灵。
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

// [契约] 基名只来自 filename 或 alt，先剥后缀再清洗非法字符，最后截断 80 字符。
// 清洗集合包含 Windows 保留字符与控制字符，顺序不能调换。
// 截断后为空要回退 image，保证 saveFile 一定拿到非空 suggestedName。
// 改错后果：文件名含冒号时主进程保存抛错，整个下载失败。
function safeDownloadBaseName(item: ImagePreviewDialogItem) {
  return (
    (item.filename || item.alt)
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
      .slice(0, 80) || "image"
  );
}

// [契约] 只有 download_failed 与 file_too_large 两个码，调用方按码决定是否回退。
// 它必须是 Error 子类且 code 只读，否则序列化后身份判断失效。
// 新增码要同步更新 catch 分支，否则会被当成未知错误直接提示失败。
// 改错后果：file_too_large 被误判成网络错误，触发无意义的重试或回退。
class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

// [契约] 日志里只允许出现 scheme、host、path，userinfo 与 query 全部抹掉。
// data: 统一折叠成 data-url，避免把整段 base64 写进日志文件。
// 解析失败返回 invalid-url 而不是抛错：日志路径不能反过来打断下载。
// 改错后果：签名 URL 的 token 落到持久化日志，属于凭据泄漏。
export function sanitizeImageSourceForLog(source: string) {
  if (source.startsWith("data:")) return "data-url";
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    // [资源] 清空 search 与 hash 后仍保留 pathname，排障时足够定位是哪个图片端点。
    // 不要顺手把 pathname 也脱敏：路径是区分不同附件的最小信息。
    // 三处赋值顺序无关，但必须都在 username/password 之后统一设置。
    // 改错后果：日志里出现 ?X-Amz-Signature=...，跨环境复制即可复用。
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

// [契约] 这是唯一允许把远端图片读进内存的地方，产出 Blob 交给调用方决定落盘。
// 它不做 MIME 校验，只透传 content-type，类型信任由扩展名协商兜底。
// 调用方必须在它 resolve 之后才使用 Blob，流取消后 reader 不可复用。
// 改错后果：绕过它直接用 response.blob() 会失去字节上限保护。
async function readBoundedImageBlob(source: string) {
  // [资源] AbortController 同时服务超限中断与 finally 收尾，必须是同一个实例。
  // 不要为超时另建 controller：双 controller 会让 abort 语义分裂。
  // abort 之后再 await cancel 是幂等的，用来关闭底层流而不是重试。
  // 改错后果：超限后连接不释放，反复预览会累积悬挂请求。
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ImageDownloadError("download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      // [并发] 累计字节只在 chunk 到达后判断，超过上限立即 abort 并抛 file_too_large。
      // 这个判断必须在 chunks.push 之前，否则超限块已经进内存。
      // 不要用 content-length 替代它：分块传输没有该头，预检会漏。
      // 改错后果：无 content-length 的响应可以无限写入 renderer 内存。
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Web 下载也必须在读取过程中截断，不能等 response.blob() 完整占用 renderer 内存。
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) throw new ImageDownloadError("download_failed");
    // [权衡] 分片需要一次性拼成连续 Uint8Array，Blob 才能正确持有 buffer。
    // 不要用字符串拼接：二进制会被编码破坏。
    // offset 必须按 byteLength 累加，不能用数组下标。
    // 改错后果：图片字节被截断或错位，预览显示损坏但不报错。
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  // [资源] finally 必须同时 abort 并 cancel reader，覆盖成功、超限、异常三条路径。
  // cancel 的 rejection 被 catch 吞掉是刻意的：收尾失败不能覆盖真实错误。
  // 不要在 finally 里改 receivedBytes 或返回值，返回值在 try 内已确定。
  // 改错后果：异常路径泄漏 ReadableStream，反复预览后下载失效。
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

// [失败路径] 原生下载只对 http(s) 有意义，用于 fetch 被 CORS 或鉴权阻断时的最后回退。
// rel 为 noopener noreferrer 与 target 为 _blank 必须同时存在，防止新窗口拿到 opener。
// link 必须挂到 body 再 click，否则部分 Chromium 版本不触发导航。
// 改错后果：回退静默失败，用户点了下载却没有任何文件产生。
function startBrowserNativeDownload(source: string) {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// [事务] 返回值三态 saved、started、canceled 是 UI toast 的唯一依据，不要新增第四态。
// saveFile 成功但 path 缺失视为失败，避免 UI 报成功却没有落盘位置。
// canceled 必须原样返回，不能被当成失败写日志。
// 改错后果：用户主动取消后被提示下载失败，并产生误导性错误日志。
export async function downloadImagePreview(
  item: ImagePreviewDialogItem,
  saveFile?: IPlatformService["saveFile"],
): Promise<{ kind: "saved"; path: string } | { kind: "started" } | { kind: "canceled" }> {
  // [失败路径] 没有 src 直接抛 download_failed，而不是回退浏览器下载。
  // 空 src 的 anchor 会导航到当前页面，等于把弹窗关掉。
  // 调用方已按 disabled 拦一次，这里是第二道闸，不能省。
  // 改错后果：空 src 的 anchor 会导航，点击下载触发页面跳转，预览上下文全部丢失。
  if (!item.src) throw new ImageDownloadError("download_failed");
  // [契约] 有 saveFile 且是 http(s) 时优先让主进程下载，renderer 不碰字节。
  // 这个分支必须在 fetch 之前，否则大图会先在内存里失败。
  // result.canceled 优先级高于 success：取消不是错误。
  // 改错后果：桌面端大图走内存路径，直接命中 file_too_large。
  if (saveFile && isHttpSource(item.src)) {
    const result = await saveFile({
      sourceUrl: item.src,
      suggestedName: imageDownloadFilename(item),
    });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  let blob: Blob;
  try {
    blob = await readBoundedImageBlob(item.src);
  } catch (error) {
    if (
      !saveFile &&
      isHttpSource(item.src) &&
      !(error instanceof ImageDownloadError && error.code === "file_too_large")
    ) {
      // [失败路径] 只有无 saveFile、是 http(s)、且错误不是 file_too_large 时才回退原生下载。
      // file_too_large 必须继续抛出：浏览器下载无法保证上限。
      // started 与 saved 的 toast 文案不同，回退不能复用 saved。
      // 改错后果：超大图片绕过 50MB 保护，或网络错误被伪装成已开始下载。
      startBrowserNativeDownload(item.src);
      return { kind: "started" };
    }
    throw error;
  }
  // [契约] 最终文件名用 blob.type 重新协商，因为服务端可能改写实际类型。
  // 两者不一致时以字节为准，这也是拒绝不相容后缀的原因。
  // 它必须在 readBoundedImageBlob 之后调用，之前拿不到 blob。
  // 改错后果：imageDownloadFilename 与 blob.type 不符，系统预览器按错误解码器打开。
  const filename = imageDownloadFilename(item, blob.type);
  if (saveFile) {
    const result = await saveFile({ data: await blob.arrayBuffer(), suggestedName: filename });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  // [资源] createObjectURL 与 revokeObjectURL 必须成对，revoke 在 click 之后执行。
  // 不要延迟 revoke：链接已拿到 blob 引用，提前 revoke 才会取消下载。
  // 这里不使用 item.src 直链，避免跨域时浏览器忽略 download 属性。
  // 改错后果：blob URL 泄漏，长时间预览会话内存持续上涨。
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return { kind: "started" };
}

// [契约] 组件是受控弹窗：open 与 onOpenChange 由调用方持有，内部不维护可见性。
// initialIndex 只在 open 或长度变化时同步一次，之后由内部导航接管。
// 不要再包一层 Dialog 状态，否则会出现两个可见性来源。
// 改错后果：关闭动画期间内部状态被重置，重开时跳回第一张。
export function ImagePreviewDialog({
  dialogTestId,
  imageTestId,
  initialIndex,
  items,
  onActiveIndexChange,
  onOpenChange,
  open,
}: {
  dialogTestId?: string;
  imageTestId?: string;
  initialIndex: number;
  items: readonly ImagePreviewDialogItem[];
  onActiveIndexChange?: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // [契约] activeIndex 初值直接取 initialIndex，不做 clamp；归一化放在 open 的 effect。
  // 这样首帧就能渲染正确项，不会闪一下索引再跳回。
  // 不要改成受控 prop：gallery 导航必须在本地即时生效。
  // 改错后果：首帧越界，activeItem 为 undefined 导致空白预览。
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewOffset, setPreviewOffset] = useState(defaultPreviewOffset);
  const [isDownloading, setIsDownloading] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewPointersRef = useRef(new Map<number, PreviewOffset>());
  const dragStartRef = useRef<{
    offset: PreviewOffset;
    pointer: PreviewOffset;
  } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  // [契约] activeItem、activeItemIsVideo、hasMultiple 必须同帧派生，不能缓存进 state。
  // activeItemIsVideo 只看 mediaType 前缀，不看扩展名，避免文件名伪装。
  // 三者必须随 activeIndex 同帧更新，否则视频项会短暂出现下载按钮。
  // 改错后果：activeItemIsVideo 未同帧更新，视频项会短暂显示缩放条与下载按钮。
  const activeItem = items[activeIndex];
  const activeItemIsVideo = activeItem?.mediaType?.startsWith("video/") === true;
  const hasMultiple = items.length > 1;

  // [事务] 重置顺序固定：先释放 pointer capture，再清 map 与 ref，最后 setState。
  // 必须先 release 再 clear：capture 未释放时 map 已空，无法再找到 pointerId。
  // 三个 ref 与两个 state 必须一起清，遗漏任何一个都会残留拖拽起点。
  // 改错后果：切图后第一下拖拽出现跳跃位移，或 hover 命中错误层级。
  const resetPreviewTransform = () => {
    const viewport = previewViewportRef.current;
    if (viewport) {
      for (const pointerId of previewPointersRef.current.keys()) {
        if (viewport.hasPointerCapture(pointerId)) {
          viewport.releasePointerCapture(pointerId);
        }
      }
    }
    previewPointersRef.current.clear();
    dragStartRef.current = null;
    pinchStartRef.current = null;
    setPreviewScale(1);
    setPreviewOffset(defaultPreviewOffset);
  };

  // [契约] 索引取模实现环状切换，方向为 -1 或 1，只有多于一项时才生效。
  // setActiveIndex 与 onActiveIndexChange 必须连续调用，外部才能同步选中项。
  // resetPreviewTransform 放在最后，确保下一轮渲染拿到已清空的状态。
  // 改错后果：外部索引与内部索引漂移，下一次切换跳两格。
  const navigate = (direction: -1 | 1) => {
    if (items.length <= 1) return;
    const next = (activeIndex + direction + items.length) % items.length;
    setActiveIndex(next);
    onActiveIndexChange?.(next);
    resetPreviewTransform();
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0)));
    resetPreviewTransform();
  }, [initialIndex, items.length, open]);

  useEffect(() => {
    setVideoState("loading");
  }, [activeIndex, activeItem?.src, open]);

  useEffect(() => {
    return () => {
      // 媒体 gallery 切离 video 时旧播放器可能继续解码或发声；显式暂停，
      // 让图片/视频混合导航只保留当前项的播放生命周期。
      // [资源] 卸载或切项时显式 pause 旧 video，effect 清理函数是唯一暂停点。
      // 只依赖 activeIndex 与 open：加更多依赖会让 pause 在无关渲染里重复执行。
      // 不要用 key 重建 video 代替 pause：重建会丢失播放进度并重复拉流。
      // 改错后果：切到图片后旧视频继续解码与发声，CPU 和音量都失控。
      previewVideoRef.current?.pause();
    };
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") navigate(-1);
      else if (event.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, items.length, open]);

  const clampPreviewOffset = (offset: PreviewOffset, scale: number) => {
    const image = previewImageRef.current;
    const viewport = previewViewportRef.current;
    if (!image || !viewport) return defaultPreviewOffset;
    return clampImagePreviewOffset(
      offset,
      scale,
      { height: image.offsetHeight, width: image.offsetWidth },
      { height: viewport.clientHeight, width: viewport.clientWidth },
    );
  };

  useEffect(() => {
    if (!open) return;
    const clampCurrentOffset = () => {
      setPreviewOffset((current) => clampPreviewOffset(current, previewScale));
    };
    window.addEventListener("resize", clampCurrentOffset);
    return () => window.removeEventListener("resize", clampCurrentOffset);
  }, [open, previewScale]);

  const changePreviewScale = (delta: number) => {
    const nextScale = Math.min(3, Math.max(0.5, previewScale + delta));
    setPreviewScale(nextScale);
    setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
  };

  // [契约] 单指按下记录拖拽起点，第二指按下切换为捏合，两者共用 pointer map。
  // 首个 pointer 必须同时清空 pinchStartRef，否则会沿用上一轮的捏合基准。
  // distance 为 0 直接返回，避免除零把 scale 变成 Infinity。
  // 改错后果：双指缩放手感错乱，或 scale 变 NaN 导致 transform 失效。
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    previewPointersRef.current.set(event.pointerId, pointer);
    if (previewPointersRef.current.size === 1) {
      dragStartRef.current = { offset: previewOffset, pointer };
      pinchStartRef.current = null;
      return;
    }
    const [first, second] = Array.from(previewPointersRef.current.values());
    if (!first || !second) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (distance === 0) return;
    pinchStartRef.current = { distance, scale: previewScale };
  };

  // [并发] 移动事件只处理已登记的 pointer，未按下的事件全部忽略。
  // 双指分支优先于拖拽分支，且必须有 pinchStartRef 才计算比例。
  // 拖拽位移以按下时的 offset 为基准累加，不能把累计 delta 再叠加。
  // 改错后果：双指缩放同时触发平移，图片抖动或被夹到边界。
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!previewPointersRef.current.has(event.pointerId)) return;
    previewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const pointers = Array.from(previewPointersRef.current.values());
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      if (!first || !second || !pinchStartRef.current) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const nextScale = Math.min(
        3,
        Math.max(0.5, pinchStartRef.current.scale * (distance / pinchStartRef.current.distance)),
      );
      setPreviewScale(nextScale);
      setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
      return;
    }
    const dragStart = dragStartRef.current;
    const pointer = pointers[0];
    if (!dragStart || !pointer) return;
    setPreviewOffset(
      clampPreviewOffset(
        {
          x: dragStart.offset.x + pointer.x - dragStart.pointer.x,
          y: dragStart.offset.y + pointer.y - dragStart.pointer.y,
        },
        previewScale,
      ),
    );
  };

  // [并发] 抬手时删除 pointer、清空 pinch，并把剩余指针重新作为拖拽起点。
  // 剩余指针的起点用当前 previewOffset，而不是松手前的 dragStart。
  // 必须先 delete 再取剩余值，否则会把刚抬起的指针算成仍按着。
  // 改错后果：pointer 未先 delete，双指变单指后图片瞬移或拖拽方向反向。
  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 显式释放图片拖拽捕获；残留 capture 会让后续 hover/click 继续命中视口而非浮层按钮。
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    previewPointersRef.current.delete(event.pointerId);
    pinchStartRef.current = null;
    const remainingPointer = Array.from(previewPointersRef.current.values())[0];
    dragStartRef.current = remainingPointer
      ? { offset: previewOffset, pointer: remainingPointer }
      : null;
  };

  const downloadActiveImage = async () => {
    if (!activeItem?.src || activeItemIsVideo || isDownloading) return;
    setIsDownloading(true);
    try {
      const result = await downloadImagePreview(activeItem, platform?.saveFile);
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
    } catch (error) {
      logger.warn("[ImagePreviewDialog] 图片下载失败", {
        // 签名 URL 的 userinfo/query/fragment 不参与排障，禁止写入持久化日志。
        src: sanitizeImageSourceForLog(activeItem.src),
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        // Radix modal 会禁用 body 指针事件；预览层需显式恢复命中并退出 Electron 拖拽区。
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        data-testid={dialogTestId}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {activeItem?.alt || intl.formatMessage({ id: "chat.attachments.preview.title" })}
        </DialogTitle>
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-linux-desktop:top-4 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
          {!activeItemIsVideo ? (
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.download" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              disabled={!activeItem?.src || isDownloading}
              onClick={downloadActiveImage}
              size="icon-md"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              size="icon-md"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        {hasMultiple ? (
          <>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.previous" })}
              className="pointer-events-auto absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(-1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.next" })}
              className="pointer-events-auto absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowRightIcon />
            </Button>
          </>
        ) : null}
        {activeItem ? (
          activeItemIsVideo ? (
            <div className="flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {activeItem.src ? (
                videoState === "unsupported" ? (
                  <p
                    className="max-w-xl px-6 text-center text-ui-base text-foreground-subtle"
                    role="alert"
                  >
                    {intl.formatMessage({
                      id: "chat.attachments.preview.videoUnsupported",
                    })}
                  </p>
                ) : (
                  <>
                    {videoState === "loading" ? (
                      <p className="text-ui-base text-foreground-subtle" role="status">
                        {intl.formatMessage({
                          id: "chat.attachments.preview.videoLoading",
                        })}
                      </p>
                    ) : null}
                    {/* 可发送的 video MIME 不保证当前 Chromium 能解码其容器或 codec；
                解码失败只收口当前 gallery item，不能关闭预览或影响相邻媒体。 */}
                    <video
                      controls
                      playsInline
                      className={cn(
                        "max-h-full max-w-full rounded-xl border border-border bg-background shadow-2xl",
                        videoState === "loading" && "invisible absolute",
                      )}
                      onError={() => setVideoState("unsupported")}
                      onLoadedMetadata={() => setVideoState("ready")}
                      ref={previewVideoRef}
                      src={activeItem.src}
                    />
                  </>
                )
              ) : activeItem.error ? (
                <p className="px-6 text-center text-ui-base text-destructive" role="alert">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoUnavailable",
                  })}
                </p>
              ) : activeItem.loading ? (
                <p className="text-ui-base text-foreground-subtle" role="status">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoLoading",
                  })}
                </p>
              ) : null}
            </div>
          ) : activeItem.src ? (
            <div
              className="flex size-full min-h-0 min-w-0 touch-none cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
              onPointerCancel={handlePointerEnd}
              onPointerDown={handlePointerDown}
              onLostPointerCapture={handlePointerEnd}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              ref={previewViewportRef}
            >
              <img
                alt={activeItem.alt}
                className="max-h-full max-w-full select-none rounded-xl border border-border bg-background object-contain shadow-2xl"
                data-testid={imageTestId}
                draggable={false}
                onLoad={resetPreviewTransform}
                ref={previewImageRef}
                src={activeItem.src}
                style={{
                  transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale})`,
                }}
              />
            </div>
          ) : null
        ) : null}
        {!activeItemIsVideo ? (
          <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-popover-border bg-popover/95 p-1 shadow-md [app-region:no-drag]">
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              className="rounded-full"
              disabled={previewScale <= 0.5}
              onClick={() => changePreviewScale(-0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <MinusIcon />
            </Button>
            <span className="min-w-12 text-center text-ui-base text-foreground">
              {Math.round(previewScale * 100)}%
            </span>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              className="rounded-full"
              disabled={previewScale >= 3}
              onClick={() => changePreviewScale(0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
