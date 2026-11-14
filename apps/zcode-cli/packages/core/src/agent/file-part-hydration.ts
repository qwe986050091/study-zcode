import type {
  AttachmentRef,
  FilePart,
  ModelMessageContentBlock,
  ToolArtifactStorePort,
} from "@zcode/contracts";

// 把一条 FilePart 还原成发给模型的内容块，是冷恢复（resume/重放）时唯一的转换入口。
// 优先级：local_ref 原文说明 > image > video > PDF > text 预览 > 通用占位文本。
// artifactStore 可为 undefined：此时只能使用 part.url 自带的内联 data url，读不到二进制就降级为文本。
// 副作用：可能读取一次 artifact 存储（磁盘或远端）；读取异常在内部吞掉并降级，不向上抛。
// 输出恒为一个内容块，不会返回 null/undefined，调用方无需再做空值兜底。
export async function filePartToContentBlock(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<ModelMessageContentBlock> {
  const pathReferenceText = part.metadata?.pathReferenceText;
  if (part.metadata?.storageKind === "local_ref" && typeof pathReferenceText === "string") {
    // 这是已发给模型的说明，不是文件内容；直接恢复原文，不重新读取或推测降级原因。
    return { type: "text", text: pathReferenceText };
  }
  const source = attachmentRefFromFilePart(part);
  const dataUrl = await filePartDataUrl(part, artifactStore);
  // 图片必须拿到真实 data url 才转 image 块；取不到就落到末尾文本占位，绝不伪造内容。
  if (isImageMime(part.mime) && dataUrl) {
    return {
      type: "image",
      mediaType: concreteMediaType(part.mime, dataUrl),
      dataUrl,
      source,
    };
  }

  // 视频只有内联 data url 直传一种路径，无转码或分片，取不到字节即降级。
  if (part.mime.startsWith("video/") && dataUrl) {
    return {
      type: "video",
      mediaType: part.mime,
      dataUrl,
      source,
    };
  }

  // 增加 video 时曾把原有 PDF allowlist 泛化为所有非文本 MIME，
  // 导致 audio 等未支持类型在冷恢复后意外变成 provider file 输入。
  if (isPdfMime(part.mime) && dataUrl) {
    return {
      type: "file",
      mediaType: "application/pdf",
      name: part.filename,
      dataUrl,
      source,
    };
  }

  const previewText = part.metadata?.preview?.text;
  // 文本类只认持久化的预览快照，不回头读原文件：原文件可能已被改，快照才是当时的真实输入。
  if (part.mime.startsWith("text/") && typeof previewText === "string") {
    return { type: "text", text: previewText };
  }

  // 兜底占位只说明“曾有一个附件”，不暴露内容；label 依次取 source 文本、路径、原始 URL、文件名。
  const label =
    part.metadata?.storageKind === "local_ref"
      ? (part.source?.text.value ??
        (part.source?.type === "file" || part.source?.type === "symbol"
          ? part.source.path
          : undefined) ??
        part.metadata.originalUrl ??
        part.url)
      : (part.filename ?? part.url);
  return { type: "text", text: `[Attached ${part.mime}: ${label}]` };
}

// 持久化工具媒体排版的一项：要么是纯文本，要么引用第 N 个已恢复的附件块。
// attachmentIndex 为 0-based 下标，语义指向调用方传入的 attachmentBlocks 数组。
type PersistedToolMediaLayoutEntry =
  | { type: "attachment"; attachmentIndex: number }
  | { type: "text"; text: string };

// 按持久化排版把文本与附件块重新交织成一份完整 content 数组。
// value 为未知来源的历史 JSON：结构不合法返回 undefined；任一下标缺块也整体返回 undefined，
// 让调用方回退到旧格式，而不是产出缺内容的半成品。
// attachmentBlocks 由调用方预先从 artifact 恢复，索引与 layout 条目一一对应，顺序即最终顺序。
// 纯函数：不读 IO、不发事件；返回新数组，block 元素复用引用。
export function projectPersistedToolMediaContent(
  value: unknown,
  attachmentBlocks: ModelMessageContentBlock[],
): ModelMessageContentBlock[] | undefined {
  const layout = parsePersistedToolMediaLayout(value);
  if (!layout) return undefined;
  const content: ModelMessageContentBlock[] = [];
  for (const entry of layout) {
    if (entry.type === "text") {
      content.push({ type: "text", text: entry.text });
      continue;
    }
    const block = attachmentBlocks[entry.attachmentIndex];
    // 缺块说明附件恢复失败或索引与历史错位；整份排版判定不可信，交给调用方走降级路径。
    if (!block) return undefined;
    content.push(block);
  }
  return content;
}

// 校验并归一持久化排版结构，逐项必须是「非空 text 字符串」或「非负整数 attachmentIndex」。
// 空数组、非数组、任一条目非法都返回 undefined（整体不可信），不做部分采纳。
function parsePersistedToolMediaLayout(
  value: unknown,
): PersistedToolMediaLayoutEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const layout: PersistedToolMediaLayoutEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (entry.type === "text" && typeof entry.text === "string") {
      layout.push({ type: "text", text: entry.text });
      continue;
    }
    if (
      entry.type === "attachment" &&
      typeof entry.attachmentIndex === "number" &&
      Number.isInteger(entry.attachmentIndex) &&
      entry.attachmentIndex >= 0
    ) {
      layout.push({ type: "attachment", attachmentIndex: entry.attachmentIndex });
      continue;
    }
    return undefined;
  }
  return layout;
}

// 取出该 part 可用的内联 data url：优先用 part.url 自带值，缺失时才回查 durable artifact。
// 无 artifactStore、无 artifact uri、内容不是合法 data url 时返回 undefined，表示「没有可用字节」。
// 副作用：最多一次 artifact 读取；异常一律吞掉转 undefined，由调用方降级为文本占位。
async function filePartDataUrl(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<string | undefined> {
  if (isUsableDataUrl(part.url)) return part.url;
  const artifactUri = durableArtifactUriFromFilePart(part);
  if (!artifactStore || !artifactUri) return undefined;
  try {
    const artifact = await artifactStore.readToolResultArtifact({ uri: artifactUri });
    return isUsableDataUrl(artifact.content) ? artifact.content : undefined;
  } catch {
    return undefined;
  }
}

// 构造附件引用描述，供内容块与请求投影共同使用。
// kind 为已落 artifact 时固定 inline（正文来自 artifact）；resource 保留远端 uri；本地文件保留 path。
// 字段均可空：sizeBytes/sha256/mimeType 来自持久化 metadata，缺失即 undefined，不做推测。
// 纯函数，不读 IO。
function attachmentRefFromFilePart(part: FilePart): AttachmentRef {
  const artifactUri =
    (part.source?.type === "file" || part.source?.type === "symbol") &&
    (isImageMime(part.mime) || part.mime.startsWith("video/") || isPdfMime(part.mime))
      ? durableArtifactUriFromFilePart(part)
      : undefined;
  return {
    id: part.id,
    // 冷恢复的正文来自 durable artifact，若仍把持久化的原始 path 当作
    // 当前请求路径，原文件删除或修改后会让 base64 与 source path 指向不同内容；
    // image/video 有 artifact 时统一按 inline 恢复，由请求投影从同一 artifact 重建 path。
    kind: artifactUri
      ? "inline"
      : part.source?.type === "resource"
        ? "resource"
        : part.source
          ? "local_file"
          : "inline",
    uri: artifactUri ?? (part.source?.type === "resource" ? part.source.uri : part.url),
    path:
      !artifactUri && (part.source?.type === "file" || part.source?.type === "symbol")
        ? part.source.path
        : undefined,
    mimeType: part.mime,
    sizeBytes: part.metadata?.sizeBytes,
    sha256: part.metadata?.sha256,
    placeholder: part.source?.text.value ?? part.filename,
  };
}

// 提取该 part 指向的 durable artifact uri；非 zcode-artifact:// 前缀一律视为没有 artifact。
// 优先 metadata.artifactUri，其次 part.url；返回 undefined 表示只能走内联或降级路径。
function durableArtifactUriFromFilePart(part: FilePart): string | undefined {
  const artifactUri = part.metadata?.artifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

// 图片 MIME 判定；通配 "image/*" 也视为图片，具体类型由 concreteMediaType 从 data url 推断。
function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

// PDF 判定：先按 ";" 截断参数（如 application/pdf; charset=...）再小写比较，避免带参数时漏判。
function isPdfMime(mime: string): boolean {
  return mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

// data url 有效性判定：必须 "data:" 开头、含逗号、且逗号后负载非空；只有协议头不算可用内容。
function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

// 把 "image/*" 通配还原成 data url 头部声明的具体类型；解析不出时按 image/png 兜底。
function concreteMediaType(mime: string, dataUrl: string): string {
  if (mime !== "image/*") return mime;
  const match = /^data:([^;,]+)(?:;base64)?,/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? "image/png";
}

// 普通对象判定：排除 null 与数组，供解析未知持久化结构时做类型收窄。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
