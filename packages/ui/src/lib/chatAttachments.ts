/* oxlint-disable eslint(max-lines) -- Composer 附件的收集、恢复和序列化必须共享同一套 MIME/大小边界。 */
// chatAttachments：Composer 附件（输入框 chip）的创建、草稿/历史/跨端恢复与发送前序列化的唯一入口。
// 边界：只做元数据归一、MIME 推断、内联 base64 的解码前上限判定与 objectUrl 生命周期；
// 不负责文件选择/拖拽/粘贴交互，不负责网络上传与重试，不负责把错误翻成用户文案
// （对外只抛结构化错误类型，由 UI 层按当前 locale 格式化）。
//
// INV-01 断言：任何 MIME 分支判断前都必须先过 normalizeComposerMimeType —— 守住它的位置：normalizeComposerMimeType 及所有 startsWith 判定点 —— 改错故障：带 charset 参数或大写扩展名的 PDF 掉进 file 分支，发出去被当成文本附件。
// INV-02 断言：归一化只把 PDF 改写为小写常量，其余类型原样返回 —— 守住它的位置：normalizeComposerMimeType 的返回值 —— 改错故障：远端按原始 mimeType 字符串匹配的附件类型全部失效。
// INV-03 断言：图片用 20MiB、视频用产品上限与 V4 上限的较小值、PDF 用协议 attachmentMaxBytes —— 守住它的位置：三个内联上限常量与序列化分支 —— 改错故障：Web 内联视频编码完成后才被 V4 拒绝。
// INV-04 断言：任何 base64 附件都必须在 atob 之前用 estimateDecodedBase64Bytes 判上限 —— 守住它的位置：restoreChatComposerAttachment 的三处超限分支 —— 改错故障：旧草稿恢复时出现整段解码内存峰值。
// INV-05 断言：有效大小取声明 sizeBytes 与 base64 估算值的较大者 —— 守住它的位置：effectiveSizeBytes 的计算 —— 改错故障：可选或低报的 sizeBytes 绕过上限，直到发送才失败。
// INV-06 断言：超限但存在 localPath 时降级为路径引用而不是抛错 —— 守住它的位置：三个超限分支内的 localPath 出口 —— 改错故障：桌面端大附件无法恢复，用户丢失草稿。
// INV-07 断言：恢复按仅有 localPath、无 base64、有 base64 的顺序短路 —— 守住它的位置：restoreChatComposerAttachment 的三个 return 区块 —— 改错故障：有路径附件被重建成 File，objectUrl 逐次泄漏。
// INV-08 断言：图片与 PDF 在既无内联内容又无路径时必须抛结构化缺失错误 —— 守住它的位置：无 base64 分支的两个 throw —— 改错故障：UI 显示可发送 chip，点发送必然失败。
// INV-09 断言：纯路径附件的 sizeBytes 为 0 表示未知而非空文件 —— 守住它的位置：createChatComposerPathAttachment 的初始化字段 —— 改错故障：展示层渲染 0 B 或把附件误判为空内容。
// INV-10 断言：objectUrl 只在 createChatComposerAttachment 内创建，并由 revokeChatComposerAttachment 成对释放 —— 守住它的位置：这两个函数 —— 改错故障：长会话反复增删附件后内存持续上涨。
// INV-11 断言：id 由 nanoid 每次生成，不能作为跨恢复的持久身份 —— 守住它的位置：所有构造对象的 id 字段 —— 改错故障：按 id 去重时同一附件被重复追加或误删。
// INV-12 断言：序列化分支顺序与恢复口径一致，依次为 image、video、pdf、file —— 守住它的位置：serializeChatComposerAttachment 的分支链 —— 改错故障：同一附件保存再恢复后类型改变。
// INV-13 断言：底层只抛结构化错误，不拼用户可见中文文案 —— 守住它的位置：全部 throw 点 —— 改错故障：英文界面里混入中文错误提示。
// INV-14 断言：readAttachmentText 超过 64K 字符截断并追加固定标记 —— 守住它的位置：readAttachmentText 与 file 分支的 textContent —— 改错故障：需要完整正文的链路拿到被截断内容且无从察觉。
// INV-15 断言：未匹配到 image/video/pdf 的附件一律按 file 处理并优先路径引用 —— 守住它的位置：序列化末尾两个分支 —— 改错故障：新增类型被静默降级为文本，或退化成空 File。
//
// 改这里前先确认：恢复与序列化是同一枚硬币的两面，任何一侧新增附件类型都要同步另一侧。
import { nanoid } from "nanoid";
import {
  VIDEO_INPUT_MAX_BYTES,
  type CreateTempTextAttachmentResult,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
import {
  basenameFromPath,
  countClipboardTextLines,
  createClipboardTextAttachmentFilename,
  inferAttachmentMimeType,
  isTextLikeAttachment,
} from "@/lib/chatAttachmentMetadata.js";

export {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
export {
  countClipboardTextLines,
  formatAttachmentSize,
  shouldPreferSpreadsheetClipboardText,
} from "@/lib/chatAttachmentMetadata.js";

// [契约] 8 是单条消息的附件条数上限，UI 据此禁用添加按钮；
// 它与协议侧校验共享同一语义，不要按附件类型分别放宽，
// 否则第 9 个附件能进 chip，却在发送校验时整条消息被拒。
export const MAX_CHAT_ATTACHMENTS = 8;
// [契约] 15K 是粘贴转附件的产品阈值，按 UTF-16 长度比较，与后端无关；
// 该常量同时被 shouldCreateClipboardTextAttachment 与提示文案引用，
// 改小会让普通多行粘贴突然变成附件 chip，改大会掩盖真正的长文本卡顿。
export const LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD = 15 * 1024;
// [权衡] 三套大小口径刻意不统一：图片 20MiB 是 renderer 可承受的内联解码上限，
// video 取产品输入上限与 V4 附件上限的较小值，PDF 直接跟随协议 attachmentMaxBytes。
// 合并它们会让 Web 内联视频先编码成功、到 RPC 才被 V4 拒绝（多一次整文件内存峰值）。
const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const INLINE_VIDEO_ATTACHMENT_MAX_BYTES = Math.min(
  VIDEO_INPUT_MAX_BYTES,
  PROTOCOL_V4_LIMITS.attachmentMaxBytes,
);
// [权衡] 64K 字符是内联 textContent 的展示上限，不是文件读取上限；
// 超过它的内容会在 readAttachmentText 里被截断并追加标记，
// 所以序列化侧不必再判一次，但需要完整正文的链路不能依赖这个字段。
const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64 * 1024;

export type ChatComposerAttachmentSourceKind = "clipboard-text" | "topic-history";

// [契约] 这是 composer 的展示态模型，不是协议类型：file 与 objectUrl 只在本地有效，
// 不能被序列化进 ZCodePromptAttachment，localPath 才是跨端稳定的引用方式。
// mimeType 允许带参数（如 charset），判定前必须归一化，不要直接比较字面量。
// sizeBytes 对纯路径附件可能是 0（未知），大小判断要容忍这种值而不是当空文件。
export interface ChatComposerAttachment {
  id: string;
  file?: File;
  filename: string;
  sourceKind?: ChatComposerAttachmentSourceKind;
  messageCount?: number;
  lineCount?: number;
  charCount?: number;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  localPath?: string;
}

// [契约] PDF 需要独立可比常量：协议里 PDF 既可能以 image 也可能以 file 形式出现，
// 只能靠这个精确字符串区分，扩展名推断并不可靠，归一化已保证落到这里时是纯 MIME。
const PDF_MIME_TYPE = "application/pdf";

// [契约] 归一化只为 image/video/pdf 分支判断服务，但返回值会原样写进协议字段：
// 只有 PDF 被改写成小写常量，其余类型保持调用方传入的原字符串。
// 不要顺手对全部类型做 trim 与小写，远端按原始 mimeType 字符串匹配，
// 改动会让历史草稿里的 Image/PNG 这类值从图片卡片掉成普通文件。
function normalizeComposerMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === PDF_MIME_TYPE ? PDF_MIME_TYPE : mimeType;
}

// [失败路径] FileReader 的 onload 结果可能是 ArrayBuffer（误用了 readAsArrayBuffer），
// 只有 string 才能当 dataURL 用；不 reject 会拿 undefined 去切 base64，得到空附件却不报错。
// onerror 里优先透传 reader.error，保留原始 DOMException 让上层日志能区分权限问题与文件被删。
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("读取附件失败"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("读取附件失败"));
    };
    reader.readAsDataURL(file);
  });
}

// [资源] 这里是全文件唯一创建 objectUrl 的位置，每次调用都新增一个浏览器级句柄，
// 调用方在移除 chip 或替换附件时必须走 revokeChatComposerAttachment，否则长会话持续泄漏内存。
// id 用 nanoid 每次生成，只适合做渲染 key，不能当作跨恢复的去重身份或持久化标识。
export function createChatComposerAttachment(
  file: File,
  localPath?: string,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
  return {
    id: nanoid(),
    file,
    filename: file.name,
    localPath,
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

// [契约] sizeBytes 写 0 表示未知，不是空文件：这条路径没有 File 可以 stat，
// 后续序列化按 localPath 走零拷贝，展示层也不能把 0 渲染成 0 B。
export function createChatComposerPathAttachment(localPath: string): ChatComposerAttachment {
  const filename = basenameFromPath(localPath);
  return {
    id: nanoid(),
    filename,
    localPath,
    mimeType: inferAttachmentMimeType(filename),
    sizeBytes: 0,
  };
}

// [权衡] 粘贴文本故意包成 text/plain 的 File 复用统一创建流程，从而拿到 objectUrl；
// charCount 与 lineCount 用原文计算而非读取 File，保证阈值判定与展示口径一致。
export function createClipboardTextComposerAttachment(
  text: string,
  options: { now?: Date } = {},
): ChatComposerAttachment {
  const filename = createClipboardTextAttachmentFilename(options.now ?? new Date());
  const file = new File([text], filename, { type: "text/plain" });
  return {
    ...createChatComposerAttachment(file),
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

// [契约] 这是文本已由主进程落盘的路径版本：不构造 File、不产生 objectUrl，
// 只保留 charCount 与 lineCount 供 UI 展示，内容读取全权交给 localPath 链路。
// 不要为了统一改成调用 createChatComposerAttachment，那会把整段文本再读进 renderer 一次。
export function createClipboardTextPathComposerAttachment(
  text: string,
  attachment: CreateTempTextAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: attachment.filename,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

// [契约] 判定用大于等于且按 UTF-16 code unit 计数（text.length），不是字节数：
// 改成严格大于会让恰好到达阈值的粘贴留在输入框内联，中文粘贴会明显晚于英文触发附件化。
export function shouldCreateClipboardTextAttachment(text: string): boolean {
  return text.length >= LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD;
}

// [契约] 日期文件名单独导出是给测试与调用方注入固定时间的入口，
// 不要在内部改成读取全局时钟，否则跨时区与快照断言都会漂移。
export function createClipboardTextAttachmentFilenameForDate(now: Date = new Date()): string {
  return createClipboardTextAttachmentFilename(now);
}

// [失败路径] atob 遇到非 latin1 字符会抛 InvalidCharacterError，所有调用点都已在
// 进入本函数前用 estimateDecodedBase64Bytes 完成上限拦截，这里不再做大小兜底。
function decodeBase64ToBytes(dataBase64: string) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// [权衡] 这是长度估算不是精确解码：按 4 字符 3 字节扣掉 padding，只用于上限判定；
// 最外层取 0 下限兜住空串与畸形输入，避免负数进入比较导致绕过检查。
function estimateDecodedBase64Bytes(dataBase64: string) {
  const paddingBytes = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - paddingBytes);
}

// [契约] 恢复有三条互斥出口，顺序是仅有路径、无 base64、有 base64，不能重排：
// 带本地路径的草稿必须原样复用路径，先走 base64 分支会为一个不可见附件造 File 和 objectUrl。
// 恢复出的对象是 composer 展示态而非发送态，这里的大小判定只是提前拦截，不是最终裁决。
export function restoreChatComposerAttachment(
  attachment: ZCodePromptAttachment,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  const sizeBytes = "sizeBytes" in attachment ? (attachment.sizeBytes ?? 0) : 0;

  // [契约] 这个分支覆盖绝大多数桌面草稿与历史回填：只有路径没有内联内容，
  // 直接复制 sourceKind 与 messageCount 保留来源语义，供 UI 区分剪贴板文本与话题历史。
  // 不要在这里补 File 或 objectUrl，重渲染会不断产生新句柄。
  if (attachment.localPath && !attachment.dataBase64) {
    return {
      id: nanoid(),
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...("sourceKind" in attachment &&
      (attachment.sourceKind === "clipboard-text" || attachment.sourceKind === "topic-history")
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
      sizeBytes,
    };
  }

  // [失败路径] 无内联内容的图片与 PDF 只能是可展示不可发送的坏草稿，必须结构化拒绝；
  // 小图缺 File、base64 与 localPath 时提前抛缺失错误，避免用户点了发送才失败。
  // 非媒体类型构造空 File 是给纯文本附件的 textContent 兜底，属于历史兼容路径，不要扩到图片与 PDF。
  if (!attachment.dataBase64) {
    if (mimeType.startsWith("image/")) {
      if (!attachment.localPath && sizeBytes <= INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
        // 修复原因：小图片 metadata-only 状态没有 File/base64/localPath，后续发送一定不可读；
        // 恢复阶段直接结构化拒绝，避免 UI 显示一个看似可发送但最终失败的附件 chip。
        throw new MissingInlineImageContentError({
          filename: attachment.filename,
          sizeBytes,
        });
      }
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes,
      };
    }
    if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
      if (!attachment.localPath) {
        throw new MissingInlinePdfContentError({
          filename: attachment.filename,
          sizeBytes,
        });
      }
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes,
      };
    }
    const file = new File(
      [attachment.kind === "file" ? (attachment.textContent ?? "") : ""],
      attachment.filename,
      {
        type: mimeType,
      },
    );
    return createChatComposerAttachment(file, attachment.localPath);
  }

  // [事务] 三个 has 标记在同一处、同一时刻算出，后面所有上限判断只能引用这三个布尔，
  // 不能再各自重新推断 MIME，否则 image 与 pdf 的判定口径会随分支漂移。
  // PDF 标记不看 dataBase64，是因为上方的无内容分支已经拦住了空内容。
  const hasImageBase64 = mimeType.startsWith("image/") && Boolean(attachment.dataBase64);
  const hasVideoBase64 = mimeType.startsWith("video/") && Boolean(attachment.dataBase64);
  const hasPdfBase64 = mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
  // Bug 根因：video 恢复最初复用了只为 image 计算的 effectiveSizeBytes，导致可选或低报的
  // sizeBytes 绕过解码前上限。inline 媒体统一以正文长度为准，metadata 只提供下限。
  const estimatedSizeBytes =
    hasImageBase64 || hasVideoBase64 || hasPdfBase64
      ? estimateDecodedBase64Bytes(attachment.dataBase64)
      : sizeBytes;
  const effectiveSizeBytes = Math.max(sizeBytes, estimatedSizeBytes);

  // [契约] 图片上限用 INLINE_IMAGE_ATTACHMENT_MAX_BYTES，必须与序列化侧同一常量；
  // 有 localPath 时降级为路径引用，超过 20MiB 的图片本来就该由 agent 侧按真实文件大小处理。
  if (hasImageBase64 && effectiveSizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
    if (attachment.localPath) {
      // 修复原因：有 localPath 的图片最终由 agent/core 按真实文件大小决定是否降级为路径引用；
      // renderer 恢复 composer chip 时不应为了旧草稿里残留的超大 dataBase64 再完整解码一次。
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    // 修复原因：草稿/预填恢复也在 renderer 内执行，且历史/跨端附件的 sizeBytes 是可选字段；
    // 必须在 atob 前用 base64 长度兜底拦截超大内联图片，避免旧草稿仍产生解码内存峰值。
    throw new OversizedInlineImageAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
      sizeBytes: effectiveSizeBytes,
    });
  }

  // video 与 image 同理由的超限拦截；有 localPath 的交给 agent 侧按真实大小降级。
  // [失败路径] 视频上限用 VIDEO_INPUT_MAX_BYTES（产品上限与 V4 附件上限的较小值），
  // 与序列化侧口径少一处对齐，就会出现恢复通过、发送必失败的不对称。
  // 这里拦不住的结果是用户在 composer 看到正常视频卡片，点发送瞬间收到裸协议错误。
  if (hasVideoBase64 && effectiveSizeBytes > VIDEO_INPUT_MAX_BYTES) {
    if (attachment.localPath) {
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    throw new OversizedInlineVideoAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: VIDEO_INPUT_MAX_BYTES,
      sizeBytes: effectiveSizeBytes,
    });
  }

  // [契约] PDF 只认协议 attachmentMaxBytes，localPath 存在时同样降级为路径引用，
  // 不要为 PDF 另加一份本地常量，协议上限调整时会漏改这一处。
  if (hasPdfBase64 && effectiveSizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    if (attachment.localPath) {
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    throw new OversizedInlinePdfAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
      sizeBytes: effectiveSizeBytes,
    });
  }

  // [资源] 只有走到这里才真正把 base64 展开成字节数组，前面所有 throw 都是为了
  // 避免为一个注定失败的附件制造整段内存峰值；不要在更早的分支调用解码。
  const bytes = decodeBase64ToBytes(attachment.dataBase64);
  const file = new File([bytes], attachment.filename, {
    type: mimeType,
  });
  return createChatComposerAttachment(file, attachment.localPath);
}

// [资源] 释放是幂等的：objectUrl 不存在时静默返回，调用方可以在多条移除路径上重复调用；
// 但必须保证 revoke 发生在组件卸载或附件替换时，而不是渲染期间。
export function revokeChatComposerAttachment(attachment: ChatComposerAttachment) {
  if (attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

// [契约] 序列化是恢复的镜像，分支顺序固定为 image、video、pdf、file：
// file 分支优先看 localPath 走零拷贝，只有真正没有路径的 Web 附件才读文本内联。
// 新增附件类型必须同时改恢复与这里的判定，只改一侧会让同一附件保存再恢复后换类型。
export async function serializeChatComposerAttachment(
  attachment: ChatComposerAttachment,
): Promise<ZCodePromptAttachment> {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  // [失败路径] 无 localPath 且超过 20MiB 的图片在这里直接拒绝，不再尝试编码：
  // renderer 转 base64 会同时放大内存与 RPC payload，而且最终仍会被协议上限拒绝。
  // localPath 分支的条件包含没有 File 或已超限两种情况，两者都交给 agent 侧读取真实文件。
  if (mimeType.startsWith("image/")) {
    if (!attachment.localPath && attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
      // 这里是底层序列化边界，不能直接拼用户可见中文文案；
      // 抛结构化错误交给 UI 层按当前 locale 格式化，避免英文环境混入中文。
      throw new OversizedInlineImageAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }

    if (
      attachment.localPath &&
      (!attachment.file || attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES)
    ) {
      // 大图片如果在 renderer 里转 base64，会同时放大内存和 RPC payload。
      // 有真实本地路径时改交给 agent 的图片读取链路，它已有 20MiB 等阈值和降级策略。
      return {
        kind: "image",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }

    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "image",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  // video：桌面 localPath 零拷贝；Web inline 在 base64 编码前遵守 V4 现有 transport 上限。
  // [权衡] 视频优先走 localPath 零拷贝，Web 端没有路径才内联；
  // 内联前必须按 INLINE_VIDEO_ATTACHMENT_MAX_BYTES 拦截，这是 V4 传输上限而非产品限制。
  // 少了这一步，用户会先等整段 base64 编码完成，再收到一条无法解释的协议层错误。
  if (mimeType.startsWith("video/")) {
    if (attachment.localPath) {
      return {
        kind: "video",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    // Web 无 localPath 时曾按全局 video 产品上限放行，完成整文件 base64 编码后
    // 才被 V4 20MiB 上传边界拒绝，既浪费内存又只能展示裸协议错误。
    // [失败路径] 这里是 Web 端内联视频唯一的提前拦截点：一旦放过，
    // 等 base64 编码完成才会在 V4 传输层被拒，用户看到的是无法解释的协议错误。
    // 有 localPath 的分支已在上方 return，能走到这里的一定是必须内联的附件。
    if (attachment.sizeBytes > INLINE_VIDEO_ATTACHMENT_MAX_BYTES) {
      throw new OversizedInlineVideoAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_VIDEO_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "video",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  // [契约] PDF 与图片不同，有 localPath 时无条件走路径引用，不比对 sizeBytes，
  // 因为 PDF 由 agent 侧流式读取；只有纯 Web 附件才需要在发送前做协议上限检查。
  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
    if (attachment.localPath) {
      return {
        kind: "pdf",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    if (attachment.sizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
      throw new OversizedInlinePdfAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "pdf",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (attachment.localPath) {
    // 普通文件过去会被 renderer 读成 base64 再进入 session/send，
    // 既占用内存也绕过 agent 侧文件读取阈值。桌面端已有真实路径时只传路径引用。
    return {
      kind: "file",
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...(attachment.sourceKind
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  // [权衡] 只有没有 localPath 的 file 附件才会被读成 textContent，且受 64K 字符截断；
  // 这段文本只用于展示与最小可用内容，需要完整正文的链路不能从这里取数据。
  // sourceKind 与 messageCount 只在有值时展开，避免给协议塞 undefined 字段。
  const textContent =
    attachment.file && isTextLikeAttachment(attachment)
      ? await readAttachmentText(attachment.file)
      : undefined;
  return {
    kind: "file",
    filename: attachment.filename,
    mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(textContent !== undefined ? { textContent } : {}),
    ...(attachment.sourceKind
      ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
      : {}),
  };
}

// [失败路径] 依赖 dataURL 的逗号切分：没有逗号说明 FileReader 返回的不是 dataURL 形态，
// 宁可抛内部错误也不能返回整段字符串，否则会把 data:image/png;base64 前缀当成正文发给远端。
async function readAttachmentBase64(attachment: ChatComposerAttachment): Promise<string> {
  if (!attachment.file) {
    throw new Error("附件缺少可读取内容");
  }
  const dataUrl = await readFileAsDataUrl(attachment.file);
  const base64MarkerIndex = dataUrl.indexOf(",");
  if (base64MarkerIndex === -1) {
    throw new Error("附件数据格式不正确");
  }
  return dataUrl.slice(base64MarkerIndex + 1);
}

// [契约] 只有带内联 base64 的附件才有预览 URL，纯路径附件返回 null 是正常态：
// 调用方必须准备无预览占位，不能把 null 当异常，也不能自己用 localPath 拼 file 协议地址。
export function getChatAttachmentPreviewUrl(attachment: ZCodePromptAttachment): string | null {
  if (!attachment.dataBase64) {
    return null;
  }
  return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
}

// [契约] 三个类型判定函数都用 startsWith 前缀匹配，image/svg+xml 等子类型因此自动归位；
// 不要改成精确相等比较，否则带参数或其它图片子类型的附件会掉进 file 卡片。
export function isImageChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function isVideoChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("video/");
}

export function isPdfChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

/** 图片与视频同属媒体组：输入框与消息流统一按媒体卡片渲染。 */
export function isMediaChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return isImageChatComposerAttachment(attachment) || isVideoChatComposerAttachment(attachment);
}

// [权衡] 超长文本截断后追加固定标记，是为了让远端能看出内容不完整；
// 这个标记是展示语义，不能出现在需要精确文本比对的场景，例如代码附件回填。
async function readAttachmentText(file: File): Promise<string> {
  const text = await file.text();
  return text.length > INLINE_TEXT_ATTACHMENT_MAX_CHARS
    ? `${text.slice(0, INLINE_TEXT_ATTACHMENT_MAX_CHARS)}\n\n[内容过长，已截断]`
    : text;
}
