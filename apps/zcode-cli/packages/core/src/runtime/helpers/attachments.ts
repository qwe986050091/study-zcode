/**
 * attachments.ts —— 一轮用户附件的统一解析入口
 *
 * 职责：把 TurnState.attachments 变成可发给模型的 ResolvedTurnAttachment 列表。
 * 两条出口：
 * - summarizeTurnAttachmentsForEvent：TurnStarted 事件的展示元信息，纯内存推断、允许先于正文解析；
 * - resolveTurnAttachments：真正解析（读文件 / 读 artifact / 缩放 / 落盘），供请求组装使用。
 *
 * 【分派顺序（顺序本身是语义）】
 * 1. type=url → resource_link（远程引用，不下载）；
 * 2. clipboard-text / topic-history → 物化为会话 artifact 文件，只交付路径引用；
 * 3. content 存在 → pdf 强校验 / 非图片文本内联 / 媒体走 attachment-media-resolver；
 * 4. path + fileSystemPort → 媒体走 media resolver，文本走本地读；
 * 5. 其余 → read_failed 占位。
 *
 * 【不变量】
 * - 同一附件在 live 与冷恢复中必须得到同一形态：降级原因写进 metadata（placeholder 的 errorCode、
 *   路径引用的 pathReferenceText），不能只存在于 contentBlock 文本里。
 * - PDF 绝不走"按文本解码"分支；二进制文件绝不按文本读入 prompt。
 * - 文本材料化失败是硬失败（抛出），其余失败一律降级为占位，不阻断本轮请求。
 */
import { basename, resolvePath } from "../deps.js";
import { READ_DEFAULT_MAX_LINES, READ_MAX_FILE_SIZE_BYTES } from "@zcode/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnAttachmentMeta,
  TurnState,
  TurnId,
} from "../deps.js";
import { readTextFileForModel } from "../../tool/handlers/read-text.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { readInlineAttachmentContent } from "./attachment-artifacts.js";
import { parseDataUrlHeader } from "./attachment-data-url.js";
import {
  resolveInlineMediaAttachment,
  resolveLocalMediaAttachment,
} from "./attachment-media-resolver.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath } from "./attachment-image.js";
import {
  inferAttachmentMimeFromPath,
  isDataOrArtifactUrl,
  isTextLikePath,
  resolvedInlineTextAttachment,
  resolvedPathReferenceAttachment,
} from "./attachment-path-reference.js";

/**
 * 附件解析的统一选项。
 *
 * 字段口径：
 * - abortSignal：取消信号，穿透到文件读、图片缩放与 artifact 写；取消时按“读失败”降级，
 *   但文本材料化路径会直接抛出（见 resolveTurnAttachment 的说明）。
 * - artifactStore：附件物化落盘端口；缺席时媒体只能 inline 发送，文本材料化直接失败。
 * - fileSystemPort：本地文件 stat/read 的唯一入口；缺席时 path 附件降级为 read_failed。
 * - imageProcessorPort：图片缩放能力；缺席时原图直发。
 * - sessionId / turnId：落盘归属；sessionId 缺失会同时影响媒体落盘与文本材料化。
 * - traceContext：贯穿所有 IO 的追踪上下文。
 * - workingDirectory：相对 path 的解析基准（会话 cwd）。
 */
type ResolveAttachmentOptions = {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
};

/**
 * 附件 → TurnStarted 事件的轻量展示元信息（TurnAttachmentMeta）。
 * 在 resolve/persist 之前即可用（TurnStarted 先于 resolveTurnAttachments 发出），
 * 因此只做无 IO 推断：filename/mimeType/sizeBytes 优先取协议边界透传值，
 * 缺省按 path basename / 扩展名 / data URL 头 / content 长度兜底。
 *
 * 输出口径（TurnAttachmentMeta 逐字段）：
 * - fileName：显式 filename > path 的 basename > `attachment-N`（N 从 1 开始）；
 * - mime：显式 mimeType > data URL 头 > url 类型固定 text/uri-list > 按扩展名推断 > octet-stream；
 * - bytes：显式 sizeBytes > content 的 UTF-8 字节数 > 0（没有 content 时不做猜测）；
 * - ref：只有"可展示的稳定引用"才填——本地/远程 path；data URL 与 artifact URI 不填；
 *   url 类型用 content（或 path）作为 URI，因为它的内容本身就是引用地址。
 *
 * 副作用：无（不读盘、不缩放、不落盘）。
 * 失败与降级：不抛错；信息不全时用兜底值，宁可展示近似元数据也不阻断 TurnStarted。
 * 不变量：这里推断出的 mime/bytes 仅用于展示，绝不反向影响 resolve 阶段的真实解析。
 */
export function summarizeTurnAttachmentsForEvent(
  attachments: TurnState["attachments"],
): TurnAttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => {
    const path = attachment.path;
    const fileName =
      attachment.filename ?? (path ? basename(path) : undefined) ?? `attachment-${index + 1}`;
    const dataUrlMime =
      attachment.content !== undefined
        ? parseDataUrlHeader(attachment.content)?.mediaType
        : undefined;
    const mime =
      attachment.mimeType ??
      dataUrlMime ??
      (attachment.type === "url"
        ? "text/uri-list"
        : path
          ? attachment.type === "image"
            ? inferImageMimeFromPath(path)
            : inferAttachmentMimeFromPath(path)
          : "application/octet-stream");
    const bytes =
      attachment.sizeBytes ??
      (attachment.content !== undefined ? Buffer.byteLength(attachment.content, "utf8") : 0);
    // data URL/inline 内容无稳定引用；路径/URL 作为展示层引用。
    const ref =
      path && !isDataOrArtifactUrl(path)
        ? path
        : attachment.type === "url"
          ? (attachment.content ?? path)
          : undefined;
    return { fileName, mime, bytes, ...(ref ? { ref } : {}) };
  });
}

/**
 * 解析本轮所有附件，保持输入顺序。
 *
 * 为什么串行而不是 Promise.all：附件顺序决定 contentBlock 顺序，也决定 artifact 的 toolCallId
 * 编号（attachment-1/2/...），并发会打乱编号与日志可读性；附件数量通常很小，串行成本可接受。
 *
 * 输入：attachments 允许 undefined/空数组，此时返回空数组。
 * 输出：ResolvedTurnAttachment[]，每项都已"可发送或已降级"，不会出现空洞。
 * 副作用：逐个产生文件读、图片缩放、artifact 写（见各分支）。
 * 失败语义：单个附件内部失败会被降级吸收；但 clipboard-text/topic-history 材料化失败会抛出，
 * 使本轮请求失败（见 resolveTurnAttachment 的说明）。
 */
export async function resolveTurnAttachments(
  attachments: TurnState["attachments"],
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment[]> {
  const resolved: ResolvedTurnAttachment[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    resolved.push(await resolveTurnAttachment(attachment, index, options));
  }
  return resolved;
}

/**
 * 单个附件的分派器（resolveTurnAttachments 的实现核心）。
 *
 * 分支优先级（改动顺序会改变语义，尤其是 pdf 与 inline 文本之间）：
 * 1. url → resource_link：不下载、不读盘；recoverability=metadata_only，storageKind=remote_ref；
 * 2. clipboard-text / topic-history 且有 content → 必须先物化成会话文件再给路径引用：
 *    上传材料（可能在别的 runtime 落盘）不允许解码成正文注入，也不允许使用 Host 本机路径；
 *    缺少 artifactStore/sessionId/写二进制能力时抛错，这是"宁可失败也不污染 prompt"的硬边界；
 * 3. 有 content：pdf 若不是 data:/artifact 一律 placeholder_invalid（历史 bug：曾被 UTF-8 解码）；
 *    非 image 且不是 data:/artifact → 当纯文本内联；其余走 inline 媒体解析；
 * 4. 有 path 且 fileSystemPort 可用 → 媒体类型走 media resolver，其它走本地文本读；
 * 5. 兜底 read_failed 占位（例如没有 fileSystemPort 的远程 runtime）。
 *
 * 输出：ResolvedTurnAttachment（总是有值）。
 * 副作用与失败：见各分支；除文本材料化外均不抛错。
 * 不变量：每个分支都必须返回带 metadata 的完整对象，metadata 里的 recoverability/storageKind
 * 是冷恢复判断"还能不能用"的唯一依据。
 */
async function resolveTurnAttachment(
  attachment: TurnAttachment,
  index: number,
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment> {
  if (attachment.type === "url") {
    const uri = attachment.content ?? attachment.path ?? `attachment-${index + 1}`;
    return {
      contentBlock: { type: "resource_link", uri },
      metadata: {
        originalUrl: uri,
        recoverability: "metadata_only",
        storageKind: "remote_ref",
      },
      mime: "text/uri-list",
      url: uri,
    };
  }

  if (
    attachment.content &&
    (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text")
  ) {
    // 上传后的文本材料在所属 runtime 落盘，禁止解码后当正文注入，也不使用 Host 本机路径。
    const inline = await readInlineAttachmentContent(attachment, options);
    // 文本材料化是硬边界:拿不到内容就不能把长文本当正文,也不能只给一个读不到的路径。
    const write = options.artifactStore?.writeToolResultBinaryArtifact?.bind(options.artifactStore);
    if (!inline || !write || !options.sessionId)
      throw new Error("Text attachment materialization unavailable");
    const encoded = /^data:text\/plain(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      inline.dataUrl,
    );
    if (!encoded) throw new Error("Invalid text attachment encoding");
    const data = Buffer.from(encoded[1]!, "base64");
    const file = await write(
      {
        sessionId: options.sessionId,
        turnId: options.turnId,
        trace: options.traceContext,
        toolCallId: `text-attachment-${index}`,
        toolName: "prompt-attachment:text",
        content: data,
        contentType: "text/plain",
        extension: "txt",
        retention: "session",
      },
      { signal: options.abortSignal },
    );
    if (!file.path) throw new Error("Text attachment path unavailable");
    return resolvedPathReferenceAttachment({ ...attachment, path: file.path }, file.path, {
      filename: attachment.filename,
      mime: "text/plain",
      sizeBytes: data.length,
      reason:
        attachment.sourceKind === "topic-history"
          ? "deferred_topic_history"
          : "deferred_clipboard_text",
    });
  }
  if (attachment.content) {
    if (attachment.type === "pdf" && !isDataOrArtifactUrl(attachment.content)) {
      // PDF 曾沿用普通 file 的 inline 文本分支，损坏或伪造的正文会被 UTF-8
      // 解码后送进 provider；PDF 必须只接受 data URL 或 artifact URI，并在请求前明确降级。
      return resolvedPlaceholderAttachment(
        attachment,
        attachment.path ?? `attachment-${index + 1}`,
        "attachment_pdf_invalid",
        {
          filename: attachment.filename,
          mime: "application/pdf",
          sizeBytes: attachment.sizeBytes,
        },
      );
    }
    if (attachment.type !== "image" && !isDataOrArtifactUrl(attachment.content)) {
      return resolvedInlineTextAttachment(attachment, index);
    }

    const inline = await readInlineAttachmentContent(attachment, options);
    if (!inline) {
      // 内容读不出来(artifact 缺失/形态不符)时只给占位;不回落到"发原始 content"，
      // 因为 content 可能是 artifact URI，直接发送会把 URI 当正文。
      const placeholder = attachment.path ?? `attachment-${index + 1}`;
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
    }
    return await resolvedInlineAttachment({ ...attachment, content: inline.dataUrl }, index, {
      ...options,
      existingArtifactUri: inline.artifactUri,
    });
  }

  const fileSystemPort = options.fileSystemPort;
  if (attachment.path && fileSystemPort) {
    if (attachment.type === "image" || attachment.type === "video" || attachment.type === "pdf") {
      // 媒体类型必须走专门的 resolver:只有它负责体积闸、缩放、落盘与降级码。
      return await resolveLocalMediaAttachment(attachment, index, {
        ...options,
        fileSystemPort,
      });
    }
    return await resolveLocalFileAttachment(attachment, {
      ...options,
      fileSystemPort,
    });
  }

  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
}

/**
 * 解析"内容是 data URL / artifact URI"的媒体附件。
 *
 * 职责：先解析 data URL 头得到 mediaType，再交给 resolveInlineMediaAttachment 处理 image/pdf/video；
 * 若媒体解析返回 undefined（不是媒体类型，或格式不匹配），退化为纯文本 text block。
 *
 * 输出口径（文本兜底分支）：mime 优先取 data URL 头，其次按 attachment.type 兜底 image/* 或 text/plain；
 * preview.truncated 恒 false（这里不做截断，截断由后续媒体预算/能力投影负责）。
 * 副作用：媒体分支可能读 artifact、缩放、写 artifact；文本分支无 IO。
 * 失败与降级：媒体解析内部失败已降级为占位；本函数自身不再抛错。
 * 不变量：返回的 contentBlock 类型只可能是 image/file/video/text，且一定对应"能发送"的形态。
 */
async function resolvedInlineAttachment(
  attachment: TurnAttachment,
  index: number,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    imageProcessorPort?: ImageProcessorPort;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<ResolvedTurnAttachment> {
  const parsed = attachment.content?.startsWith("data:")
    ? parseDataUrlHeader(attachment.content)
    : undefined;
  const media = await resolveInlineMediaAttachment(attachment, index, parsed?.mediaType, options);
  if (media) return media;

  const content = attachment.content ?? "";
  return {
    contentBlock: { type: "text", text: content },
    metadata: {
      originalUrl: attachment.path ?? attachment.content,
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: parsed?.mediaType ?? (attachment.type === "image" ? "image/*" : "text/plain"),
    url: attachment.content ?? "",
  };
}

/**
 * 解析"本地普通文件"（非 image/video/pdf）。
 *
 * 决策顺序与理由：
 * 1. stat 失败 → read_failed；非文件 → not_file（目录等不能误当内容发送）。
 * 2. 非文本扩展名 → binary_file 路径引用：疑似二进制绝不解码进 prompt。
 * 3. clipboard-text / topic-history → 路径引用：长粘贴/历史材料已经物化成临时文件，
 *    预读会把正文重新塞回系统提示，抵消"延后读取"的初衷。
 * 4. 超过 READ_MAX_FILE_SIZE_BYTES → 走 readTextFileForModel 的局部回退（offset=1 起、
 *    默认行数上限），避免一次性读入超大文件。
 *
 * 输出口径：metadata.preview 记录截断状态/行号/是否被 token cap 截断/局部视图提示；
 * recoverability 随 read.truncated 在 provider_ready 与 preview_only 之间切换——
 * 一旦截断，模型看到的就是预览而不是全文，冷恢复不能假装它是完整正文。
 * 副作用：一次 stat + 一次（可能带分段的）文本读。
 * 失败与降级：任何异常统一转 attachment_read_failed 占位，保留绝对路径与原始 path。
 */
async function resolveLocalFileAttachment(
  attachment: TurnAttachment,
  options: {
    abortSignal?: AbortSignal;
    fileSystemPort: FileSystemPort;
    traceContext: TraceContext;
    workingDirectory: string;
  },
): Promise<ResolvedTurnAttachment> {
  const absolutePath = resolvePath(options.workingDirectory, attachment.path!);
  const filename = basename(absolutePath);
  const mime = "text/plain";
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachment.path!, start: 0, end: attachment.path!.length },
  };

  try {
    const stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
    if (stat.kind !== "file") {
      return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_not_file", {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
      });
    }

    if (!isTextLikePath(absolutePath)) {
      // 疑似二进制文件不能误当文本读入 prompt，只交付路径引用给后续工具处理。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: inferAttachmentMimeFromPath(absolutePath),
        sizeBytes: stat.sizeBytes,
        source,
        reason: "binary_file",
      });
    }

    if (attachment.sourceKind === "clipboard-text" || attachment.sourceKind === "topic-history") {
      // 长粘贴文本已经落成临时文件，预读会重新把正文塞进 prompt_attachment 系统提示。
      // 这里只交付真实本地附件引用，等模型明确需要时再通过文件读取工具进入上下文。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
        reason:
          attachment.sourceKind === "topic-history"
            ? "deferred_topic_history"
            : "deferred_clipboard_text",
      });
    }

    const isOversizedText = stat.sizeBytes > READ_MAX_FILE_SIZE_BYTES;
    const read = await readTextFileForModel({
      abortSignal: options.abortSignal,
      filePath: absolutePath,
      fileSystemPort: options.fileSystemPort,
      ...(isOversizedText
        ? {
            allowPartialFallback: true,
            limit: READ_DEFAULT_MAX_LINES,
            offset: 1,
          }
        : {}),
      trace: options.traceContext,
    });
    return {
      contentBlock: { type: "text", text: read.content },
      filename,
      metadata: {
        originalUrl: attachment.path,
        preview: {
          text: read.content,
          truncated: read.truncated ?? false,
          ...(read.sizeBytes !== undefined ? { originalBytes: read.sizeBytes } : {}),
          startLine: read.startLine,
          totalLines: read.totalLines,
          ...(read.truncatedByTokenCap !== undefined
            ? { truncatedByTokenCap: read.truncatedByTokenCap }
            : {}),
          ...(read.partialViewNotice !== undefined
            ? { partialViewNotice: read.partialViewNotice }
            : {}),
        },
        recoverability: read.truncated ? "preview_only" : "provider_ready",
        ...(read.sizeBytes !== undefined ? { sizeBytes: read.sizeBytes } : {}),
        storageKind: "inline",
      },
      mime: "text/plain",
      source,
      url: attachment.path!,
    };
  } catch {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
      filename,
      mime,
      source,
    });
  }
}

export { parseDataUrlHeader } from "./attachment-data-url.js";
export { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
