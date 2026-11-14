// INV-01 文件名由工具调用与产物标识拼成：守住位置 fileName 模板；改错故障 同会话产物互相覆盖。
// INV-02 会话目录名经白名单化：守住位置 sanitizePathSegment；改错故障 特殊字符逃逸出根目录。
// INV-03 空白路径段回落 unknown：守住位置 空串判断；改错故障 产物写进根目录本身。
// INV-04 路径段长度上限一百二十：守住位置 slice 调用；改错故障 超长名触发系统错误。
// INV-05 产物标识每次随机生成：守住位置 randomUUID；改错故障 重试复用旧标识。
// INV-06 写入前先检查取消信号：守住位置 aborted 判断；改错故障 取消后仍落盘。
// INV-07 目录创建允许已存在：守住位置 recursive 选项；改错故障 第二次写同一会话失败。
// INV-08 字节数取实际内容长度：守住位置 byteLength；改错故障 声明值与真实大小不符。
// INV-09 文本与二进制写入口分离：守住位置 两个方法；改错故障 二进制被当 utf8 损坏。
// INV-10 扩展名优先取显式值：守住位置 空值合并顺序；改错故障 调用方指定后缀被忽略。
// INV-11 未识别扩展名归一为 bin：守住位置 normalizeArtifactExtension；改错故障 未知格式按 JSON 读回。
// INV-12 读回按 MIME 决定编码：守住位置 isTextArtifactContentType；改错故障 二进制被转成乱码字符串。
// INV-13 找不到文件必须抛错：守住位置 fileName 判断；改错故障 返回空串掩盖数据丢失。
// INV-14 定位靠目录扫描匹配标识：守住位置 readdir 加 find；改错故障 依赖内存索引导致重启丢失。
// INV-15 派生媒体按 URI 去重：守住位置 flights 映射；改错故障 并发请求重复物化。
// INV-16 去重表在完成后清理：守住位置 finally 分支；改错故障 映射持续增长泄漏内存。
// INV-17 派生媒体先写临时文件再改名：守住位置 rename 调用；改错故障 读者看到半截文件。
// INV-18 失败时删除临时文件后原样抛出：守住位置 catch 分支；改错故障 残留碎片且错误被吞。
//
// 模块职责：提供本地文件系统的工具产物存储，以及派生媒体附件的物化能力。
// 状态所有权：仅缓存进行中的物化任务；产物元数据完全以文件系统为准。
// 阅读顺序：先看写入路径，再看读取与元数据，最后看媒体物化与工具函数。
// ============================================================
// Storage adapters - EventStore, ArtifactStore, MemoryStore implementations
// ============================================================
// 定位：adapters 层对外暴露的存储入口，包含 tool 产物落盘（NodeToolArtifactStore）
// 与 session store / trust store 的 re-export；业务侧只依赖本模块路径，不直接碰 fs。
// 输入输出：写接口接收 tool call 的 sessionId / toolCallId / 内容与 MIME；返回带
// zcode-artifact:// URI 的结果，读取接口按 URI 反解出会话目录与文件。
// 副作用：mkdir / writeFile / readdir / rename / unlink，全部落在配置的 rootDir
// 与媒体 cache 目录内；不做网络与数据库写入。
// 失败语义：参数预检失败、文件不存在、URI 非法、媒体解码不匹配均 throw，
// 由上层转成 tool 错误；派生媒体写失败会清理临时文件后重新抛出。
// 不变量：产物文件名 = sanitize(toolCallId)-<artifactId><扩展名>，artifactId 用
// 随机 UUID 保证同一 tool call 多次写入不会互相覆盖；派生媒体按 URI singleflight。

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ImageAttachmentPathPrimeRequest,
  MediaAttachmentPathPrimeRequest,
  MediaAttachmentPathEnsureRequest,
  MediaAttachmentPathResult,
  ToolBinaryArtifactWriteRequest,
  ToolArtifactStorePort,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactStatRequest,
  ToolArtifactStatResult,
  ToolArtifactWriteRequest,
  ToolArtifactWriteResult,
  ToolBinaryArtifactReadResult,
} from "@zcode/contracts";
import { maybeThrowStorageFsFault } from "./fs-fault-injection.js";

export * from "./session-store.js";

// 内存 event store 实现已下沉到 @zcode/contracts，
// 这里保持 `@zcode/adapters/storage` 的导出路径不变，避免调用方改 import。
export {
  InMemorySessionEventStore,
  createInMemorySessionEventStore,
  type InMemorySessionEventStoreOptions,
} from "@zcode/contracts";

export interface NodeToolArtifactStoreOptions {
  /** 派生图片缓存根目录；同一 sessionId 的图片按 URI 哈希落盘。 */
  imageCacheRootDir: string;
  /** 派生 PDF 缓存根目录；缺省为 rootDir 同级 pdf-cache。 */
  pdfCacheRootDir?: string;
  /** tool 产物根目录；每个 session 一个子目录，目录名经 sanitize。 */
  rootDir: string;
  /** 派生视频缓存根目录（mp4/mov/webm 等）。 */
  videoCacheRootDir: string;
}

// 基于本地文件系统的 ToolArtifactStorePort 实现：负责 tool 结果原文/二进制与
// 派生媒体（图片/PDF/视频）的落盘、读回、stat。所有写入都带上可注入的 fs 故障
// 钩子，供 E2E 验证失败路径；不维护内存索引，读取时靠 readdir 反查文件名。
// rootDir 等四个根目录在构造函数里一次性固化，实例生命周期内不再读 options，避免运行期路径漂移。
// 产物按 <rootDir>/<sessionId>/ 分层，sessionId 先过 sanitizePathSegment 再做目录名。
// imageCacheRootDir 与 videoCacheRootDir 独立于 rootDir，派生媒体由各自根目录承载，清理时不会波及产物目录。
// mediaAttachmentPathFlights 只登记在途的物化 Promise，完成后由 finally 立刻 delete，避免表里留结果。
// 实例不持有产物索引，读回一律 readdir 会话目录后按 artifactId 匹配文件名。
export class NodeToolArtifactStore implements ToolArtifactStorePort {
  private readonly imageCacheRootDir: string;
  private readonly pdfCacheRootDir: string;
  private readonly rootDir: string;
  private readonly videoCacheRootDir: string;
  private readonly mediaAttachmentPathFlights = new Map<
    string,
    Promise<MediaAttachmentPathResult>
  >();

  // 只保存路径配置；pdf 缓存缺省推导到 rootDir 同级，避免与产物目录混淆。
  constructor(options: NodeToolArtifactStoreOptions) {
    this.imageCacheRootDir = options.imageCacheRootDir;
    this.rootDir = options.rootDir;
    this.pdfCacheRootDir = options.pdfCacheRootDir ?? join(dirname(options.rootDir), "pdf-cache");
    this.videoCacheRootDir = options.videoCacheRootDir;
  }

  /**
   * 写入文本型 tool 结果：内容以 utf8 落盘到 <rootDir>/<sessionId>/<toolCallId>-<artifactId><ext>。
   * 返回的 uri 只含 sessionId + artifactId，读取时再反查真实文件名。
   * 副作用：mkdir -p + writeFile；无事务，失败可能留下已建的空目录（可安全重试）。
   * 幂等性不靠覆盖：artifactId 每次随机生成，重复调用会产生新文件。
   */
  async writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const contentType = request.contentType ?? "application/json";
    const extension = extensionForContentType(contentType);
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, request.content, "utf8");

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType,
      createdAt: new Date(),
    };
  }

  /**
   * 写入二进制 tool 结果（图片/Office/PDF 等）。扩展名优先取请求显式值，
   * 否则按 MIME 推导，最后经 normalizeArtifactExtension 兜底为 .bin。
   * 副作用同样是 mkdir + writeFile；byteLength 来自实际 Buffer，而非请求声明。
   */
  async writeToolResultBinaryArtifact(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool binary artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const extension = normalizeArtifactExtension(
      request.extension ?? extensionForBinaryContentType(request.contentType),
    );
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);
    const content = Buffer.from(request.content);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, content);

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: content.byteLength,
      contentType: request.contentType,
      createdAt: new Date(),
    };
  }

  /**
   * 读回文本型产物：content 为 utf8 字符串；非文本 MIME 则退化为 base64，
   * 保证调用方总拿到可序列化内容。文件不存在 → throw（不返回空串）。
   */
  async readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }

    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    const content = isTextArtifactContentType(contentType)
      ? bytes.toString("utf8")
      : bytes.toString("base64");
    return {
      uri: request.uri,
      path,
      content,
      bytes: bytes.byteLength,
      contentType,
    };
  }

  /**
   * 直接读取原始字节，供 v4 分块查询和查看器使用，避免编解码改变内容。
   * contentType 仍按文件名推断，仅作兜底。
   */
  async readToolResultBinaryArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }
    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    return { uri: request.uri, path, bytes: new Uint8Array(bytes), contentType };
  }

  /** 两条读回共用的定位 + 读文件：uri → 会话目录里含 artifactId 的那个文件。 */
  // 先从 URI 解出会话与产物标识。
  // 再 readdir 会话目录，用 includes(artifactId) 找文件名，不为读回单独维护索引。
  // 找不到含 artifactId 的文件就 throw，调用方不能把「没找到」当成空产物继续。
  // contentType 由 contentTypeForFileName(fileName) 反推，与落盘时的扩展名保持同一来源。
  // readArtifactFile 只做 readdir 与 readFile，不 mkdir 也不写临时文件，所以可以并发调用。
  private async readArtifactFile(
    uri: string,
  ): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const { artifactId, sessionId } = parseArtifactUri(uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) {
      throw new Error(`Tool artifact not found: ${uri}`);
    }
    const path = join(sessionDir, fileName);
    return { path, contentType: contentTypeForFileName(fileName), bytes: await readFile(path) };
  }

  /**
   * 只读元数据：bytes/mtimeMs 来自 fs.stat，contentType 按文件名后缀推断。
   * 文件不存在 → throw；不产生任何写入副作用，可并发调用。
   */
  async statToolResultArtifact(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact stat cancelled");
    }
    const { artifactId, sessionId } = parseArtifactUri(request.uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) throw new Error(`Tool artifact not found: ${request.uri}`);
    const path = join(sessionDir, fileName);
    const artifactStat = await stat(path);
    return {
      uri: request.uri,
      bytes: artifactStat.size,
      contentType: contentTypeForFileName(fileName),
      path,
      mtimeMs: artifactStat.mtimeMs,
    };
  }

  /** 图片 prime 是通用媒体 prime 的语义别名；两者共用同一 URI 级 singleflight。 */
  primeImageAttachmentPath(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.primeMediaAttachmentPath(request);
  }

  /**
   * 预先把媒体附件从 artifact 派生物化到缓存目录，返回 status：
   * ready（已存在或刚写入）、unsupported（MIME 无法命名，调用方应回退）。
   */
  primeMediaAttachmentPath(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, () =>
      this.writeDerivedMediaAttachment(request.uri, request.mediaType, Buffer.from(request.bytes)),
    );
  }

  /**
   * 确保派生媒体文件存在（幂等）：已存在直接返回 ready；否则把 artifact 里的
   * base64 data URL 解码后写入缓存。PDF 会额外校验 %PDF- 魔数，防止把伪装
   * 内容当 PDF 交给查看器。解码/校验失败 → throw，不落半成品。
   */
  ensureMediaAttachmentPath(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, async () => {
      const requestedPath = derivedMediaAttachmentPath(
        this.imageCacheRootDir,
        this.pdfCacheRootDir,
        this.videoCacheRootDir,
        request.uri,
        request.mediaType,
      );
      if (!requestedPath) return { status: "unsupported" };
      if (await isRegularFile(requestedPath)) return { status: "ready", path: requestedPath };

      const artifact = await this.readToolResultArtifact({ uri: request.uri });
      const decoded = decodeMediaDataUrlArtifact(
        artifact.content,
        request.uri,
        mediaKindForContentType(request.mediaType)!,
      );
      if (mediaKindForContentType(decoded.mediaType) === "pdf" && !isPdfBytes(decoded.bytes)) {
        throw new Error(`Media attachment artifact is not a PDF: ${request.uri}`);
      }
      return this.writeDerivedMediaAttachment(request.uri, decoded.mediaType, decoded.bytes);
    });
  }

  /**
   * 同一 URI 的物化任务只执行一次：并发调用共享同一个 Promise。
   * 不缓存结果本身（文件系统即缓存），flight 完成后从 Map 删除，避免泄漏。
   */
  // 同一 URI 复用已存在的任务。
  // 只有未命中时才调用 materialize()，paste 落盘与随后的发送因此共用同一次写。
  // finally 里先比对 get(uri) === flight 再 delete，只删自己那条，不误删后来者的 flight。
  // 物化结果不留在 Map 里，只保留在途状态，长会话不会随 URI 数量累积内存。
  // 完成态由文件系统承担：isRegularFile 为真即视为就绪，不再加第二层结果缓存。
  private runMediaAttachmentPathFlight(
    uri: string,
    materialize: () => Promise<MediaAttachmentPathResult>,
  ): Promise<MediaAttachmentPathResult> {
    const inFlight = this.mediaAttachmentPathFlights.get(uri);
    if (inFlight) return inFlight;

    // paste 落盘与紧随其后的发送会并发进入物化；URI 级 singleflight
    // 保证发送等待同一写任务，不会对同一派生媒体重复落盘。
    let flight!: Promise<MediaAttachmentPathResult>;
    flight = materialize().finally(() => {
      if (this.mediaAttachmentPathFlights.get(uri) === flight) {
        this.mediaAttachmentPathFlights.delete(uri);
      }
    });
    this.mediaAttachmentPathFlights.set(uri, flight);
    return flight;
  }

  /**
   * 写派生媒体：先写 <target>.tmp-<uuid> 再 rename，保证读者永远看不到半截文件。
   * 不再支持的 MIME 返回 unsupported（不阻断原始 media/base64 请求）。
   * 失败时删除临时文件后原样抛出，不重试、不覆盖既有文件。
   */
  // 无法命名的 MIME 返回不支持。
  // isRegularFile(path) 为真就直接返回 ready，重复物化同一 URI 不会重写既有文件。
  // 先写 <target>.tmp-<uuid>，与目标同目录，rename 才是同卷原子操作，读者看不到半截字节。
  // rename 成功之后才返回路径，失败先 unlink 临时文件再原样抛出，不重试也不覆盖。
  private async writeDerivedMediaAttachment(
    uri: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<MediaAttachmentPathResult> {
    const path = derivedMediaAttachmentPath(
      this.imageCacheRootDir,
      this.pdfCacheRootDir,
      this.videoCacheRootDir,
      uri,
      mediaType,
    );
    // 既有媒体处理链可接收派生缓存无法命名的格式。
    // 派生 path 是增强信息，不支持该 MIME 时应跳过，不能阻断原 media/base64 请求。
    if (!path) return { status: "unsupported" };
    if (await isRegularFile(path)) return { status: "ready", path };

    const sessionDir = dirname(path);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    try {
      maybeThrowStorageFsFault({ operation: "writeFile", path: temporaryPath });
      await writeFile(temporaryPath, bytes);
      maybeThrowStorageFsFault({ operation: "rename", path });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return { status: "ready", path };
  }
}

// 工厂函数，供 DI 装配使用；返回接口类型而非具体类，避免调用方依赖实现细节。
export function createNodeToolArtifactStore(
  options: NodeToolArtifactStoreOptions,
): ToolArtifactStorePort {
  return new NodeToolArtifactStore(options);
}

// 路径段白名单化：只留字母数字与 ._-，避免 sessionId / toolCallId 里的特殊字符
// 造成跨目录写入；空结果回落 unknown，长度上限 120 防超长路径。
function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

// MIME → 扩展名映射；未知类型回落 .json，这是文本写入的默认落盘格式。
function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return ".json";
  }
}

// 二进制产物的扩展名：若 MIME 未被映射表识别（推出 .json）且本身不是 JSON，
// 改用 .bin，避免把二进制当 JSON 用 utf8 读回而损坏。
function extensionForBinaryContentType(contentType: string): string {
  const extension = extensionForContentType(contentType);
  return extension === ".json" && !contentType.toLowerCase().includes("json") ? ".bin" : extension;
}

// 归一化调用方给的扩展名：补点、去非法字符、小写、限长；不满足 [.a-z0-9]+ 时用 .bin。
function normalizeArtifactExtension(extension: string): string {
  const withDot = extension.startsWith(".") ? extension : `.${extension}`;
  const sanitized = withDot
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16)
    .toLowerCase();
  return /^\.[a-z0-9]+$/.test(sanitized) ? sanitized : ".bin";
}

// 由落盘文件名反推 MIME：识别已知文本/图片/办公后缀；未知二进制一律
// octet-stream，绝不落入 application/json 被 utf8 读回。
function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  // dwf 产物按原扩展名落盘（`extension` 入参），推断表补齐它们。文本类给 text/*
  // （utf8 读回正确），办公文件与 svg 之外的未知二进制一律 octet-stream——**绝不**再让一个
  // 不认识的扩展名落到 application/json 走 utf8（那正是读回损坏的根因）。
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  // 文本写入的默认扩展名就是 .json（extensionForContentType 的 default），所以既有文件全部
  // 落在上面的分支里；到这里的只有按原扩展名落盘的二进制产物（.xlsx / .docx / .pptx …）。
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

// 只有 JSON 与 text/* 可以安全 utf8 读回；其余按 base64 返回。
function isTextArtifactContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.startsWith("text/");
}

// PDF 魔数校验（%PDF-），只覆盖文件头 5 字节；用于拒绝伪装成 PDF 的 data URL。
function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

type DerivedMediaKind = "image" | "video" | "pdf";

// 派生媒体路径：<cacheRoot>/<session>/<kind>-<sha256(uri) 前 32 位><ext>。
// MIME 无法归类或无法命名扩展名时返回 undefined，由调用方转成 unsupported。
// 用 URI 哈希而非原文，避免超长/非法字符，并保证同一 URI 稳定命中同一文件。
function derivedMediaAttachmentPath(
  imageCacheRootDir: string,
  pdfCacheRootDir: string,
  videoCacheRootDir: string,
  uri: string,
  mediaType: string,
): string | undefined {
  const { sessionId } = parseArtifactUri(uri);
  const kind = mediaKindForContentType(mediaType);
  const extension = extensionForDerivedMediaContentType(mediaType);
  if (!kind || !extension) return undefined;
  const cacheRootDir =
    kind === "image" ? imageCacheRootDir : kind === "video" ? videoCacheRootDir : pdfCacheRootDir;
  const uriHash = createHash("sha256").update(uri).digest("hex").slice(0, 32);
  return join(cacheRootDir, sanitizePathSegment(sessionId), `${kind}-${uriHash}${extension}`);
}

// MIME 大类归类：image/* → image、video/* → video、application/pdf → pdf，其余 undefined。
function mediaKindForContentType(mediaType: string): DerivedMediaKind | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return undefined;
}

// 派生媒体允许的扩展名白名单；视频/图片/PDF 之外一律 undefined（不物化）。
function extensionForDerivedMediaContentType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-matroska":
      return ".mkv";
    case "video/x-m4v":
      return ".m4v";
    case "video/x-msvideo":
      return ".avi";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

// 解析 artifact 里的 base64 data URL。要求：前缀 data:、MIME 大类与期望一致、
// 末段标记 base64、逗号分隔且解码非空；任一不满足即 throw（不猜格式、不静默降级）。
function decodeMediaDataUrlArtifact(
  content: string,
  uri: string,
  expectedKind: DerivedMediaKind,
): { bytes: Buffer; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = headerParts.shift()?.trim();
  if (
    mediaKindForContentType(mediaType ?? "") !== expectedKind ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    commaIndex < 0
  ) {
    throw new Error(`Media attachment artifact is not a base64 ${expectedKind} data URL: ${uri}`);
  }
  const bytes = Buffer.from(content.slice(commaIndex + 1), "base64");
  if (bytes.byteLength === 0) {
    throw new Error(`Media attachment artifact is empty: ${uri}`);
  }
  return { bytes, mediaType: mediaType! };
}

// 存在且为普通文件 → true；ENOENT → false；其余 IO 错误照常抛出（不吞权限/IO 故障）。
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// 解析 zcode-artifact://<sessionId>/<artifactId>；hostname 承载 sessionId，
// pathname 承载 artifactId。协议不符、URL 非法或任一段为空均 throw。
function parseArtifactUri(uri: string): { artifactId: string; sessionId: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new Error(`Invalid tool artifact URI: ${uri}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (parsed.protocol !== "zcode-artifact:") {
    throw new Error(`Unsupported tool artifact URI: ${uri}`);
  }

  const sessionId = decodeURIComponent(parsed.hostname);
  const artifactId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId || !artifactId) {
    throw new Error(`Invalid tool artifact URI: ${uri}`);
  }

  return { artifactId, sessionId };
}
export * from "./workspace-hook-trust-store.js";
