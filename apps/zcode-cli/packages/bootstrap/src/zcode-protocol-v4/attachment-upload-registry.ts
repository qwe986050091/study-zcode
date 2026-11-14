// v4 attachment 分片上传的进程内 staging 权威表。
//
// 生命周期：begin 建 staged → chunk 逐片追加 → commit 校验完整性后落 artifact 并转 committed
// → abort 丢弃；未提交的 staged 由 TTL（5 分钟）与并发/总字节配额兜底回收。
// 配额：最多 16 个并发 staged、全局 staged 字节 64MiB、单片 512KiB、最多 64 片。
// 幂等：同 uploadId 重复 begin/chunk/commit 返回相同 nextChunkIndex/ref；内容不一致按
// conflict 类 fault 拒绝，绝不静默覆盖。进程重启即丢失（staging 不是 durable 事实）。
import { createHash } from "node:crypto";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginParams,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkParams,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitParams,
  type V4AttachmentCommitResult,
} from "@zcode/shared/zcode-protocol-v4";

// begin 时客户端声明的不可变事实；重试必须逐字段一致，否则视为别的上传。
interface UploadMetadata {
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

// 未提交的分片缓冲；chunks 按 chunkIndex 顺序存放，receivedBytes 是已收字节数。
interface StagedUpload {
  // uploadKey(connectionId, sessionId, uploadId)：连接隔离，避免跨连接撞 uploadId。
  key: string;
  connectionId: string;
  sessionId: string;
  uploadId: string;
  // begin 参数快照，后续 chunk/commit 只校验、不更新。
  metadata: UploadMetadata;
  chunks: Uint8Array[];
  // 累计已收字节；与 metadata.totalBytes、stagedBytes 双重对账。
  receivedBytes: number;
  // TTL 绝对时间戳；begin/chunk 会续期，过期且无在途 commit 才可被回收。
  expiresAt: number;
  // 在途 commit 的单飞句柄：同 uploadId 的并发 commit 共享同一 Promise。
  commitPromise: Promise<V4AttachmentCommitResult> | null;
}

// 已提交记录：保留 ref 以支撑 commit 重试返回同一 artifact 引用。
interface CommittedUpload {
  connectionId: string;
  sessionId: string;
  uploadId: string;
  metadata: UploadMetadata;
  // 提交时的分片总数，供 begin 重试告知客户端“无需再传”。
  nextChunkIndex: number;
  // artifact 引用（由 putSessionAttachment 分配，durable 落在会话存储）。
  ref: string;
  // committed 记录同样有 TTL，仅用于幂等窗口，不改变 artifact 本身的持久性。
  expiresAt: number;
}

// 外部依赖：时钟（TTL 判定，测试可注入）与 artifact 落盘回调。
// putSessionAttachment 成功即代表 bytes 已 durable，失败则整个 commit 视为失败。
export interface AttachmentUploadRegistryOptions {
  now: () => number;
  putSessionAttachment: (
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ) => Promise<{ ref: string }>;
}

// 三元组精确键：uploadId 只保证连接内唯一，必须带连接与会话才能隔离。
function uploadKey(connectionId: string, sessionId: string, uploadId: string): string {
  return `${connectionId}\0${sessionId}\0${uploadId}`;
}

// 只摘取不可变的 begin 事实，避免把连接/会话等可变上下文混进同一性判断。
function metadataOf(params: V4AttachmentBeginParams): UploadMetadata {
  return {
    fileName: params.fileName,
    mime: params.mime,
    totalBytes: params.totalBytes,
    totalChunks: params.totalChunks,
    checksum: params.checksum,
  };
}

// 逐字段全等：任一字段变化都说明是另一次上传意图，不能复用已 staged/committed 状态。
function sameMetadata(left: UploadMetadata, right: UploadMetadata): boolean {
  return (
    left.fileName === right.fileName &&
    left.mime === right.mime &&
    left.totalBytes === right.totalBytes &&
    left.totalChunks === right.totalChunks &&
    left.checksum === right.checksum
  );
}

// 重传分片必须字节级一致（不是“长度相同”），否则拒绝以保证 checksum 语义。
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// 所有权：本类独占 staged/committed 两张表与 stagedBytes 计数，其它模块只能经
// begin/chunk/commit/abort 访问；clear* 是连接/会话/进程回收入口，不是业务撤销。
// 不变量：stagedBytes 恒等于所有 staged.receivedBytes 之和；staged.size 恒 ≤ 16；
// 任一 staged 的 receivedBytes 恒 ≤ metadata.totalBytes。
// 失败语义：配额/冲突/乱序/不完整/校验不通过一律抛 fault.*，调用方映射成 rejected ACK，
// 已 staged 的数据保持原状，可由客户端修正后继续或显式 abort。
/**
 * CLI 进程内 attachment staging 权威表。
 *
 * 旧 attachment/put 会把 20MiB bytes 扩成约 26.7MiB NDJSON 单行，mobile
 * 外层再膨胀一次。这里逐片解码后计账，只有 commit 校验完整事实才落 artifact。
 */
export class AttachmentUploadRegistry {
  private readonly staged = new Map<string, StagedUpload>();
  private readonly committed = new Map<string, CommittedUpload>();
  private stagedBytes = 0;

  constructor(private readonly options: AttachmentUploadRegistryOptions) {}

  /**
   * 开始或恢复一次上传：先回收过期记录，再按 uploadKey 命中 committed/staged。
   *
   * 输入：连接/会话/uploadId + 不可变 metadata（fileName/mime/size/chunks/checksum）。
   * 输出：state=committed 时直接给 ref 与 nextChunkIndex（无需重传）；staging 时给
   * 已收片数，客户端据此断点续传。返回不是 ACK，只是 staging 视图。
   * 失败：同 key 但 metadata 不同 → beginConflict；并发超 16 → tooManyUploads；
   * totalBytes 超过 totalChunks 可容纳上限 → chunkCountInsufficient（防止不可能完成的上传）。
   * 副作用：可能新建 staged 或续期 TTL；不写 durable artifact。
   */
  begin(params: V4AttachmentBeginParams): V4AttachmentBeginResult {
    this.pruneExpired();
    const key = uploadKey(params.connectionId, params.sessionId, params.uploadId);
    const metadata = metadataOf(params);
    const committed = this.committed.get(key);
    if (committed) {
      if (!sameMetadata(committed.metadata, metadata)) {
        throw new Error("fault.attachment.beginConflict");
      }
      return {
        uploadId: params.uploadId,
        state: "committed",
        nextChunkIndex: committed.nextChunkIndex,
        ref: committed.ref,
      };
    }
    const existing = this.staged.get(key);
    if (existing) {
      if (!sameMetadata(existing.metadata, metadata)) {
        throw new Error("fault.attachment.beginConflict");
      }
      existing.expiresAt = this.options.now() + PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
      return {
        uploadId: params.uploadId,
        state: "staging",
        nextChunkIndex: existing.chunks.length,
      };
    }
    // 并发配额按 staged 条数计（含已收 0 片的），防止只 begin 不传的句柄占满内存。
    if (this.staged.size >= PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent) {
      throw new Error("fault.attachment.tooManyUploads");
    }
    if (
      params.totalChunks > 0 &&
      params.totalBytes > params.totalChunks * PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes
    ) {
      throw new Error("fault.attachment.chunkCountInsufficient");
    }
    this.staged.set(key, {
      key,
      connectionId: params.connectionId,
      sessionId: params.sessionId,
      uploadId: params.uploadId,
      metadata,
      chunks: [],
      receivedBytes: 0,
      expiresAt: this.options.now() + PROTOCOL_V4_LIMITS.attachmentUploadTtlMs,
      commitPromise: null,
    });
    return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 };
  }

  /**
   * 追加一片（base64 解码后计入 stagedBytes）。
   *
   * 顺序口径：chunkIndex 必须等于当前已收片数（严格顺序）；小于已收数按重传处理，
   * 只有字节完全一致才幂等返回，否则 chunkConflict；大于已收数为 chunkGap。
   * 失败：上传不存在/在途 commit/片号越界/空片/累计超 totalBytes/全局 staged 超配额。
   * 副作用：成功时 push 分片、累加 receivedBytes 与 stagedBytes、续期 TTL。
   * 返回值只报告 nextChunkIndex，不含 artifact 信息。
   */
  chunk(params: V4AttachmentChunkParams): V4AttachmentChunkResult {
    this.pruneExpired();
    const key = uploadKey(params.connectionId, params.sessionId, params.uploadId);
    const upload = this.staged.get(key);
    if (!upload) throw new Error("fault.attachment.uploadNotFound");
    if (upload.commitPromise) throw new Error("fault.attachment.commitInProgress");
    const bytes = new Uint8Array(Buffer.from(params.dataBase64, "base64"));
    if (params.chunkIndex < upload.chunks.length) {
      if (!sameBytes(upload.chunks[params.chunkIndex], bytes)) {
        throw new Error("fault.attachment.chunkConflict");
      }
      return { uploadId: params.uploadId, nextChunkIndex: upload.chunks.length };
    }
    if (params.chunkIndex > upload.chunks.length) {
      throw new Error("fault.attachment.chunkGap");
    }
    if (params.chunkIndex >= upload.metadata.totalChunks) {
      throw new Error("fault.attachment.tooManyChunks");
    }
    if (bytes.byteLength === 0) throw new Error("fault.attachment.emptyChunk");
    if (upload.receivedBytes + bytes.byteLength > upload.metadata.totalBytes) {
      throw new Error("fault.attachment.totalBytesExceeded");
    }
    if (
      this.stagedBytes + bytes.byteLength >
      PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes
    ) {
      throw new Error("fault.attachment.stagingCapacityExceeded");
    }
    upload.chunks.push(bytes);
    upload.receivedBytes += bytes.byteLength;
    upload.expiresAt = this.options.now() + PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
    this.stagedBytes += bytes.byteLength;
    return { uploadId: params.uploadId, nextChunkIndex: upload.chunks.length };
  }

  /**
   * 提交上传：完整性与 checksum 校验通过后才落 artifact，并把 staged 转为 committed。
   *
   * 幂等：已 committed 直接返回同一 ref；同 key 并发 commit 共享同一 commitPromise。
   * 失败：不存在/分片数或字节数不符/checksum 不匹配一律抛 fault.*；失败后清除
   * commitPromise，允许客户端补片或重新提交（staged 数据不会半提交到 artifact）。
   * 副作用：调用 putSessionAttachment 产生 durable 写入；成功后释放 stagedBytes。
   * 成功语义：返回 ref 即表示 artifact 已存在，可安全用于后续消息附件引用。
   */
  async commit(params: V4AttachmentCommitParams): Promise<V4AttachmentCommitResult> {
    this.pruneExpired();
    const key = uploadKey(params.connectionId, params.sessionId, params.uploadId);
    const committed = this.committed.get(key);
    if (committed) return { ref: committed.ref };
    const upload = this.staged.get(key);
    if (!upload) throw new Error("fault.attachment.uploadNotFound");
    if (upload.commitPromise) return upload.commitPromise;
    const promise = this.commitStaged(upload);
    upload.commitPromise = promise;
    try {
      return await promise;
    } catch (error) {
      // 仅当条目仍属于本次 upload 才清空单飞句柄：被并发 abort/回收替换后不能误清。
      if (this.staged.get(key) === upload) upload.commitPromise = null;
      throw error;
    }
  }

  /**
   * 放弃上传并释放 staged 缓冲；对已 commit 的引用不做任何事（artifact 已 durable）。
   *
   * 在有在途 commit 时先 await 它，再返回：保证 abort 不会与 append 交错留下泄漏计数。
   * 幂等：重复 abort 或对不存在的 key 调用都是 no-op，不抛错。
   */
  async abort(params: V4AttachmentCommitParams): Promise<void> {
    this.pruneExpired();
    const key = uploadKey(params.connectionId, params.sessionId, params.uploadId);
    const upload = this.staged.get(key);
    if (upload?.commitPromise) {
      await upload.commitPromise;
      return;
    }
    this.deleteStaged(key);
  }

  // 连接断开时的回收：同时清该连接 staged（含字节计数）与 committed 幂等记录。
  clearConnection(connectionId: string): void {
    this.clearWhere((upload) => upload.connectionId === connectionId);
    for (const [key, upload] of this.committed) {
      if (upload.connectionId === connectionId) this.committed.delete(key);
    }
  }

  // 会话删除/关闭时的回收；只清幂等记录，不删除已落盘的 artifact。
  clearSession(sessionId: string): void {
    this.clearWhere((upload) => upload.sessionId === sessionId);
    for (const [key, upload] of this.committed) {
      if (upload.sessionId === sessionId) this.committed.delete(key);
    }
  }

  // 进程级清空（测试/关停）：两张表与 stagedBytes 一起重置，避免计数漂移。
  clear(): void {
    this.staged.clear();
    this.committed.clear();
    this.stagedBytes = 0;
  }

  // TTL 回收：跳过有在途 commit 的 staged（其 promise 仍会自行收尾），committed 到期即删。
  pruneExpired(): void {
    const now = this.options.now();
    this.clearWhere((upload) => upload.expiresAt <= now && upload.commitPromise === null);
    for (const [key, upload] of this.committed) {
      if (upload.expiresAt <= now) this.committed.delete(key);
    }
  }

  // 真正的提交流水线：片数/字节全等 → sha256 与声明 checksum 比对 → 顺序拼成整块
  // → 落 artifact → 删 staged、写 committed。artifact 写入失败时 staged 保持完整，
  // 因而客户端可原样重试 commit，不会产生重复 artifact。
  private async commitStaged(upload: StagedUpload): Promise<V4AttachmentCommitResult> {
    if (
      upload.chunks.length !== upload.metadata.totalChunks ||
      upload.receivedBytes !== upload.metadata.totalBytes
    ) {
      throw new Error("fault.attachment.uploadIncomplete");
    }
    const hash = createHash("sha256");
    for (const chunk of upload.chunks) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== upload.metadata.checksum) {
      throw new Error("fault.attachment.checksumMismatch");
    }
    const bytes = new Uint8Array(upload.metadata.totalBytes);
    let offset = 0;
    for (const chunk of upload.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const { ref } = await this.options.putSessionAttachment(upload.sessionId, {
      fileName: upload.metadata.fileName,
      mime: upload.metadata.mime,
      bytes,
    });
    if (this.staged.get(upload.key) === upload) this.deleteStaged(upload.key);
    this.committed.set(upload.key, {
      connectionId: upload.connectionId,
      sessionId: upload.sessionId,
      uploadId: upload.uploadId,
      metadata: upload.metadata,
      nextChunkIndex: upload.chunks.length,
      ref,
      expiresAt: this.options.now() + PROTOCOL_V4_LIMITS.attachmentUploadTtlMs,
    });
    return { ref };
  }

  // 唯一删除 staged 的位置：同时扣减 stagedBytes，保证计数不会变成负数或漏减。
  private deleteStaged(key: string): void {
    const upload = this.staged.get(key);
    if (!upload) return;
    this.staged.delete(key);
    this.stagedBytes -= upload.receivedBytes;
  }

  // 按谓词批量回收 staged；一边遍历一边删是安全的，因为 delete 只影响当前项。
  private clearWhere(predicate: (upload: StagedUpload) => boolean): void {
    for (const [key, upload] of this.staged) {
      if (predicate(upload)) this.deleteStaged(key);
    }
  }
}
