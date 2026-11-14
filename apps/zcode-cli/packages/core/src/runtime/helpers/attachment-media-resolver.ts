// INV-01 按类型分派：守住位置 attachment.type 三个分支；改错故障 其它类型被本文件误接管。
// INV-02 非本职责返回 undefined：守住位置 video 之后的 return；改错故障 文本/引用附件被吞掉。
// INV-03 降级不抛错：守住位置 各占位返回；改错故障 单个坏附件让整轮请求失败。
// INV-04 图片缩放失败有专码：守住位置 attachment_image_resize_failed；改错故障 与格式非法混为一谈。
// INV-05 PDF 不做文本解码：守住位置 结构化 file 分支；改错故障 二进制被当文本读取。
// INV-06 PDF 零字节与超限同拒：守住位置 sizeBytes 判断；改错故障 截断出非法 PDF 发给 provider。
// INV-07 视频超限降级为路径：守住位置 video_too_large 分支；改错故障 用户不知道该文件在哪。
// INV-08 id 同轮稳定：守住位置 turn-attachment-${index+1}；改错故障 事件与投影无法对齐附件。
// INV-09 复用 artifact 时 mime 分开：守住位置 source.mimeType 三元；改错故障 把缩放后的类型写成原始类型。
// INV-10 本地路径以会话 cwd 解析：守住位置 resolvePath(workingDirectory)；改错故障 相对路径按进程 cwd 解析。
// INV-11 本地 I/O 只走 fileSystemPort：守住位置 stat / read；改错故障 绕过权限与取消。
// INV-12 stat 失败与不是文件分开：守住位置 read_failed 与 not_file；改错故障 排障时无法区分原因。
// INV-13 读端二次限流：守住位置 readBinaryFile 的 maxBytes；改错故障 stat 后文件变大仍被整读。
// INV-14 原始相对路径保留在 source：守住位置 text / placeholder；改错故障 UI 回显变成绝对路径。
//
// 模块职责：把 inline 与本地文件两类媒体附件解析成 provider 可用的 contentBlock。
// 阅读顺序：先看 inline 三分支，再看本地解析与 stat 校验，最后看三条本地子链路。
import { basename, isFileSystemPortError, resolvePath } from "../deps.js";
import { VIDEO_INPUT_MAX_BYTES } from "@zcode/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";
import { INLINE_MEDIA_ATTACHMENT_MAX_BYTES } from "../types.js";
import type { PreparedImageData, ResolvedTurnAttachment } from "../types.js";
import { persistAttachmentDataUrl } from "./attachment-artifacts.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
import { inferVideoMimeFromPath, parseInlineVideoDataUrl } from "./attachment-video.js";
import { isPdfBytes, parseInlinePdfDataUrl, PDF_INPUT_MAX_BYTES } from "./attachment-pdf.js";
import { resolvedPathReferenceAttachment } from "./attachment-path-reference.js";

/**
 * inline（data URL / artifact）媒体的解析选项。
 *
 * - abortSignal：取消信号，透传给 artifact 写盘与图片缩放；取消时让当前 turn 失败而不是降级。
 * - artifactStore：附件物化的落盘端口；缺席或没有 sessionId 时媒体只能 inline 发送。
 * - existingArtifactUri：上游已经落盘的 artifact URI；命中时跳过重复写盘（也意味着内容形态
 *   仍是"原始未缩放"版本，见 resolveInlineMediaAttachment 里 mimeType 的取法）。
 * - imageProcessorPort：图片缩放能力；缺席时原图直发。
 * - sessionId/turnId：artifact 归属；sessionId 同时是"能否落盘"的开关。
 * - traceContext：贯穿三层的追踪上下文，落盘与缩放都要带上。
 */
interface InlineMediaResolverOptions {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  existingArtifactUri?: string;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
}

/**
 * 本地文件媒体解析选项：在 inline 选项基础上去掉 existingArtifactUri（本地文件每次都要重新读），
 * 并强制要求 fileSystemPort 与 workingDirectory。
 *
 * - fileSystemPort：所有 stat/read 的唯一 I/O 入口；不允许在此处直接用 fs，保证权限与取消统一。
 * - workingDirectory：相对路径 attachment.path 的解析基准（会话 cwd，不是进程 cwd）。
 */
interface LocalMediaResolverOptions extends Omit<
  InlineMediaResolverOptions,
  "existingArtifactUri"
> {
  fileSystemPort: FileSystemPort;
  workingDirectory: string;
}

/**
 * 本地媒体分支的中间上下文：一次 stat 之后、真正读取之前的所有确定事实。
 *
 * 字段口径：
 * - absolutePath：resolvePath(workingDirectory, attachment.path) 的结果，用于实际 I/O 与 source.path。
 * - attachment：原始 TurnAttachment，保留 path/sourceKind 等元信息。
 * - filename：绝对路径的 basename，写入 contentBlock.name 与展示元数据。
 * - index：在本轮附件列表中的下标，用于生成稳定 id `turn-attachment-${index+1}`。
 * - mime：由扩展名/附件声明推断出的 mime，尚未经过实际字节校验。
 * - options：解析选项（含 fileSystemPort/sessionId/artifactStore 等）。
 * - source：FilePartSource（type=file），text 指向原始相对路径。
 * - stat：首次 stat 结果；后续读取仍可能因文件变化而不同（见各分支的二次判断）。
 */
interface LocalMediaContext {
  absolutePath: string;
  attachment: TurnAttachment;
  filename: string;
  index: number;
  mime: string;
  options: LocalMediaResolverOptions;
  source: FilePartSource;
  stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
}

/**
 * 解析"内容已在内存里"的媒体附件（data URL 形态）。
 *
 * 职责：按 attachment.type 分派到 image / pdf / video 三条子链路，产出发给 provider 的 contentBlock
 * 与持久化元数据；不属于这三种类型时返回 undefined，交回 attachments.ts 走文本/引用分支。
 *
 * 输入：attachment.content 必须已是 data URL（或 artifact URI，此时由 existingArtifactUri 复用）；
 * parsedMediaType 来自 parseDataUrlHeader，仅用于 image 分支判定。
 *
 * 输出：ResolvedTurnAttachment；或 undefined（非本函数职责）。
 * 副作用：成功分支都会调用 persistAttachmentDataUrl（可能落盘），图片分支还可能触发缩放。
 * 失败与降级（全部不抛错，改为占位文本，让请求继续）：
 * - 图片：缩放抛错 → attachment_image_resize_failed；无法解析 → attachment_image_invalid；
 * - PDF：非法 data URL / 0 字节 / 超 20MiB → attachment_pdf_invalid；
 * - 视频：非法 data URL 或 0 字节 → attachment_video_invalid；超 VIDEO_INPUT_MAX_BYTES →
 *   降级为路径引用（video 不能像 pdf 那样直接拒绝，用户仍需要知道文件在哪）。
 * 不变量：contentBlock.source.id 恒为 `turn-attachment-${index+1}`，同轮内稳定，供事件/投影关联；
 * 图片分支里 source.mimeType 与 block.mediaType 在"复用已有 artifact"时可能不同（见行内注释）。
 */
export async function resolveInlineMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions,
): Promise<ResolvedTurnAttachment | undefined> {
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  // 图片分支要求真 data URL 头。
  if (attachment.type === "image" && attachment.content && parsedMediaType?.startsWith("image/")) {
    let prepared: PreparedImageData | undefined;
    // 缩放是"可选优化":失败只降级为占位文本,不能把整个请求打成失败,
    // 但也不能退回原始超大图(可能仍超 provider 限制)。
    try {
      // 缩放是可选优化，失败不进主错。
      prepared = await prepareImageDataUrl(attachment.content, parsedMediaType, options);
    } catch {
      return resolvedPlaceholderAttachment(
        attachment,
        placeholder,
        "attachment_image_resize_failed",
      );
    }
    if (!prepared) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_image_invalid");
    }
    // 落盘能力全部透传，缺席则 inline。
    const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "image",
        mediaType: prepared.mediaType,
        dataUrl: prepared.dataUrl,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          // 复用已落盘 artifact 时,store 里存的是原始未缩放内容,所以 source.mimeType
          // 描述 artifact 本身;block.mediaType 描述当前 dataUrl(可能已被缩放重编码)。
          // 复用 artifact 时类型描述存储原文。
          mimeType: options.existingArtifactUri ? parsedMediaType : prepared.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      metadata: {
        ...(prepared.metadata ? { image: prepared.metadata } : {}),
        recoverability: resource.metadata.recoverability,
        sizeBytes: Buffer.byteLength(attachment.content, "utf8"),
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: prepared.mediaType,
      url: resource.url,
    };
  }

  // PDF 只走结构化 file 分支:非法载荷必须显式降级,不允许回落到文本解码。
  // PDF 只走结构化 file 形态。
  if (attachment.type === "pdf" && attachment.content) {
    const pdfData = parseInlinePdfDataUrl(attachment.content);
    if (!pdfData) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: attachment.sizeBytes,
      });
    }
    // 0 字节 PDF 没有可发送内容;超限 PDF 直接拒绝而不是截断,截断后不再是合法 PDF。
    // 空与超限都拒绝，不做截断。
    if (pdfData.sizeBytes === 0 || pdfData.sizeBytes > PDF_INPUT_MAX_BYTES) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: pdfData.sizeBytes,
      });
    }
    const resource = await persistAttachmentDataUrl(attachment.content, index, pdfData.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "file",
        mediaType: pdfData.mediaType,
        name: attachment.filename,
        dataUrl: attachment.content,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: pdfData.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      filename: attachment.filename,
      metadata: {
        recoverability: resource.metadata.recoverability,
        sizeBytes: pdfData.sizeBytes,
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: pdfData.mediaType,
      url: resource.url,
    };
  }

  // 到此只剩 video 才由本函数负责;其它类型(含 file/url)返回 undefined 让上层继续分派。
  if (attachment.type !== "video" || !attachment.content) return undefined;

  const videoData = parseInlineVideoDataUrl(attachment.content);
  if (!videoData) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: attachment.mimeType ?? parsedMediaType ?? "video/*",
      sizeBytes: attachment.sizeBytes,
    });
  }
  // 空 payload 曾绕过视频大小校验并被持久化，导致实时与冷恢复消息形态不一致。
  if (videoData.sizeBytes === 0) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
    });
  }
  // 超限视频不截断(会破坏容器),改为"路径 + 读取提示",让模型用工具按需查看。
  // 超限视频转路径引用而非报错。
  if (videoData.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, placeholder, {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
      reason: "video_too_large",
    });
  }
  const resource = await persistAttachmentDataUrl(attachment.content, index, videoData.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    existingArtifactUri: options.existingArtifactUri,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "video",
      mediaType: videoData.mediaType,
      dataUrl: attachment.content,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "inline",
        mimeType: videoData.mediaType,
        placeholder,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    metadata: {
      recoverability: resource.metadata.recoverability,
      sizeBytes: videoData.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: videoData.mediaType,
    url: resource.url,
  };
}

/**
 * 解析"内容在本地磁盘"的媒体附件（image / pdf / video）。
 *
 * 职责：把相对 path 解析成会话 cwd 下的绝对路径 → stat → 按类型交给三条本地子链路。
 *
 * 输入口径：attachment.path 必须存在（调用方已保证）；workingDirectory 是会话 cwd；
 * mime 先按扩展名推断，pdf 固定 application/pdf，video 允许回退到附件声明的 mimeType 或 video/mp4。
 *
 * 输出：ResolvedTurnAttachment，永不返回 undefined（失败也会落到占位/引用形态）。
 * 副作用：stat 一次；子链路还会 read（并可能写 artifact）。
 * 失败与降级：
 * - stat 抛错 → attachment_read_failed 占位（读不到与"不是文件"区分开）；
 * - stat.kind !== "file"（目录/符号链接等）→ attachment_not_file；
 * - 其余大小/格式问题由子链路给出更精确的错误码（统一 attachment_* 前缀）。
 * 不变量：source 里的 text 始终保留用户输入的原始相对路径，便于 UI 回显；实际 I/O 只用 absolutePath。
 */
// 本地媒体先解析路径再 stat。
export async function resolveLocalMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  options: LocalMediaResolverOptions,
): Promise<ResolvedTurnAttachment> {
  const attachmentPath = attachment.path!;
  const absolutePath = resolvePath(options.workingDirectory, attachmentPath);
  const filename = basename(absolutePath);
  const mime =
    attachment.type === "image"
      ? inferImageMimeFromPath(absolutePath)
      : attachment.type === "pdf"
        ? "application/pdf"
        : (inferVideoMimeFromPath(absolutePath) ?? attachment.mimeType ?? "video/mp4");
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachmentPath, start: 0, end: attachmentPath.length },
  };
  let stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
  // stat 失败不当成"文件不存在也不当成功":统一走 read_failed 占位,保留原始引用供用户排查。
  try {
    stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  // 目录与特殊文件统一拒绝。
  if (stat.kind !== "file") {
    return resolvedPlaceholderAttachment(attachment, attachmentPath, "attachment_not_file", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }

  const context: LocalMediaContext = {
    absolutePath,
    attachment,
    filename,
    index,
    mime,
    options,
    source,
    stat,
  };
  if (attachment.type === "image") return resolveLocalImageAttachment(context);
  if (attachment.type === "pdf") return resolveLocalPdfAttachment(context);
  return resolveLocalVideoAttachment(context);
}

/**
 * 本地 PDF：大小/魔数校验通过后转 data URL 并落盘。
 *
 * 边界口径：stat.sizeBytes 先挡一次超限（避免无谓读盘）；readBinaryFile 的 maxBytes 是第二道闸，
 * 因为 stat 与 read 之间文件仍可能变大（read 端的 too_large 分支同样降级为路径引用）。
 * 输出：结构化 file contentBlock（type=file, mediaType=application/pdf），
 * metadata 里保留 originalUrl（用户给的相对路径）、sha256（读取端 revision.hash）与 artifactUri。
 * 失败与降级：
 * - 超限 → resolvedPathReferenceAttachment(pdf_too_large)，只给路径不给正文；
 * - 读失败 → attachment_read_failed；
 * - 0 字节或魔数不符（isPdfBytes 看 %PDF-）→ attachment_pdf_invalid。
 * 不变量：绝不对 PDF 做文本解码；bytes 校验与 Base64 编码之间不再接受任何"猜测式"修复。
 */
// 先按 stat 挡超限，再看读取端。
async function resolveLocalPdfAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, mime, options, source, stat } = context;
  if (stat.sizeBytes > PDF_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "pdf_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: PDF_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // stat 之后文件可能继续增长:以读取端 maxBytes 的判定为最终事实,不按 stat 结果继续读。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "pdf_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (read.bytesRead === 0 || !isPdfBytes(read.content)) {
    // 空文件与伪 PDF 同码：两者都"不是可发送的 PDF",细分对用户没有额外价值。
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_pdf_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, context.index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "file",
      mediaType: mime,
      name: filename,
      dataUrl,
      source: {
        id: `turn-attachment-${context.index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: read.sizeBytes,
        sha256: read.revision?.hash,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    filename,
    metadata: {
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime,
    source,
    url: resource.url,
  };
}

/**
 * 本地图片：大小闸 → base64 读取 → 缩放 → 落盘。
 *
 * 口径：
 * - 先看 stat.sizeBytes 是否超 INLINE_MEDIA_ATTACHMENT_MAX_BYTES（20MiB）；超限不再读盘，
 *   直接降级为路径引用 image_too_large，避免把超大文件读进内存；
 * - 用 readTextFile(encoding="base64") 读取，得到的内容直接拼成 data URL；
 * - 缩放失败/无法解析 → 占位文本（不阻断请求）；
 * - 成功落盘后 metadata 记录 sha256（读取端 revision.hash）与 image 尺寸元数据。
 * 副作用：一次读 + 一次图片处理 + 一次 artifact 写。
 * 不变量：contentBlock.source.kind 固定 local_file，path 指向绝对路径，placeholder 保留用户输入路径；
 * 图片分支不像 PDF 分支那样把 artifact URI 写进 source（图片只保留本地路径，便于模型用工具回读原图）。
 */
// 图片用 base64 读文本端口。
async function resolveLocalImageAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > INLINE_MEDIA_ATTACHMENT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "image_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readTextFile"]>>;
  try {
    read = await options.fileSystemPort.readTextFile(
      { path: absolutePath, encoding: "base64", trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  const dataUrl = `data:${mime};base64,${read.content}`;
  let prepared: PreparedImageData | undefined;
  try {
    prepared = await prepareImageDataUrl(dataUrl, mime, options);
  } catch {
    return resolvedPlaceholderAttachment(
      attachment,
      attachment.path!,
      "attachment_image_resize_failed",
      { filename, mime, sizeBytes: stat.sizeBytes, source },
    );
  }
  if (!prepared) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_image_invalid", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }
  const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "image",
      mediaType: prepared.mediaType,
      dataUrl: prepared.dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: prepared.mediaType,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: stat.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      ...(prepared.metadata ? { image: prepared.metadata } : {}),
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: stat.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: prepared.mediaType,
    source,
    url: resource.url,
  };
}

/**
 * 本地视频：大小闸 → 二进制读取 → data URL 落盘。
 *
 * 与 PDF 的差异：视频不做魔数校验（容器格式多，交给 provider），只校验"非空"与"不超限"；
 * 读端 too_large（stat 后文件变大）同样降级为路径引用。
 * 输出：video contentBlock + metadata（originalUrl/sha256/sizeBytes/artifactUri）。
 * 失败与降级：0 字节 → attachment_video_invalid；其它读失败 → attachment_read_failed。
 * 不变量：视频正文永远不写进 part.data 之外的字段（见 attachment-placeholder 对 url 的约束）。
 */
async function resolveLocalVideoAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "video_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: VIDEO_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 外层 stat 后文件仍可能增长；以读取端的 maxBytes 结果为最终边界。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "video_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  // 文件可能在 stat 后被清空，必须以实际读取结果判断是否为有效视频。
  if (read.bytesRead === 0) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_video_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "video",
      mediaType: mime,
      dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: read.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime,
    source,
    url: resource.url,
  };
}

/**
 * 本地媒体读取失败的统一出口。
 *
 * 只产出 attachment_read_failed 占位（metadata_only），不做任何 IO 补偿；
 * 保留原始 path 作为 url，便于用户在 UI 里定位到底是哪个文件读不出来。
 */
function localMediaReadFailure(
  attachment: TurnAttachment,
  filename: string,
  mime: string,
  source: FilePartSource,
): ResolvedTurnAttachment {
  return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
    filename,
    mime,
    source,
  });
}
