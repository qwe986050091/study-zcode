// ============================================================
// 文件定位：通用（非 Bash 文件直写）执行的输出聚合器，负责内联预算、落盘预算与尾部预览。
// 输入输出：append(Buffer) 累积；result() 返回内联文本/总字节/截断标记/artifact 元数据。
// 副作用：按需 mkdir 并 createWriteStream(outputPath)，写满预算后停止写盘并回调一次。
// 失败语义：写流错误只标 artifactTruncated，不影响命令退出码；close() 等待 end 回调。
// 不变量：totalBytes 恒等于收到的全部字节；内联永远只保留前 maxInlineBytes；预算递减不可回滚。
// ============================================================
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { OutputPersistenceMode } from "./execution-adapter-types.js";
import type { ExecutionStreamResult } from "@zcode/contracts";

// 多条流（stdout+stderr）共享的落盘预算：bytes 为已消耗字节，maxBytes 为总上限。
export interface AggregatePersistedOutputBudget {
  bytes: number;
  maxBytes: number;
}

// 单路输出收集器：内存只留内联前缀与固定大小尾部，其余按策略落盘。
// 状态机：未落盘 → activatePersistence（always 或 on_truncate 触发）→ 写满后 artifactTruncated。
export class OutputCollector {
  // 内联前缀（最多 maxInlineBytes）与固定长度的滚动尾部（用于进度预览）。
  private readonly chunks: Buffer[] = [];
  private readonly maxPersistedBytes: number;
  private readonly maxInlineBytes: number;
  private readonly maxTailBytes: number;
  private readonly legacyOutputEncoding: string | null;
  private onPersistedLimit?: () => void;
  private readonly outputPath?: string;
  private readonly persistOutput: OutputPersistenceMode;
  private readonly aggregatePersistedBudget?: AggregatePersistedOutputBudget;
  private stream?: WriteStream;
  private artifactBytes = 0;
  private artifactTruncated = false;
  private inlineBytes = 0;
  private persistenceActive = false;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private truncated = false;

  constructor(options: {
    // 回灌模型的内联字节上限；0 表示不留内联文本。
    maxInlineBytes: number;
    // 单路落盘上限；<=0 表示禁用落盘。
    maxPersistedBytes: number;
    // Windows 旧代码页回退编码；null 表示按 UTF-8 解码。
    legacyOutputEncoding: string | null;
    // 进度预览保留的尾部字节数；0 表示不保留。
    maxTailBytes: number;
    // 首次触达落盘上限时回调一次，用于通知上层截断。
    onPersistedLimit?: () => void;
    // artifact 路径；缺省则即便 persistOutput 也不落盘。
    outputPath?: string;
    // always=立即落盘；on_truncate=超内联预算才落盘；never=不落盘。
    persistOutput: OutputPersistenceMode;
    // stdout/stderr 共享预算；缺省时各自独立按 maxPersistedBytes 计算。
    aggregatePersistedBudget?: AggregatePersistedOutputBudget;
  }) {
    this.maxInlineBytes = Math.max(0, options.maxInlineBytes);
    this.maxPersistedBytes = Math.max(0, options.maxPersistedBytes);
    this.maxTailBytes = Math.max(0, options.maxTailBytes);
    this.legacyOutputEncoding = options.legacyOutputEncoding;
    this.onPersistedLimit = options.onPersistedLimit;
    this.outputPath = options.outputPath;
    this.persistOutput = options.persistOutput;
    this.aggregatePersistedBudget = options.aggregatePersistedBudget;
  }

  // 追加一段输出：先判断是否触发落盘，再累积总字节与尾部，最后在预算内保留内联前缀。
  // 返回 void；截断只置标记，不抛出，也不丢弃已落盘内容。
  append(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    // on_truncate 在“本块会越过内联上限”时提前落盘，避免丢掉此前只留在内存的前缀。
    const shouldStartPersisting =
      this.persistOutput === "always" ||
      (this.persistOutput === "on_truncate" &&
        this.inlineBytes + chunk.byteLength > this.maxInlineBytes);

    if (shouldStartPersisting) this.activatePersistence(source);

    this.totalBytes += chunk.byteLength;
    this.appendTail(chunk);

    // 内联预算已满：后续字节只进 artifact（若已落盘），内联保持原样。
    if (this.inlineBytes >= this.maxInlineBytes) {
      this.truncated = this.truncated || chunk.byteLength > 0;
      if (this.persistenceActive) this.writePersisted(chunk, source);
      return;
    }

    const remaining = this.maxInlineBytes - this.inlineBytes;
    const take = Math.min(remaining, chunk.byteLength);
    if (take > 0) {
      this.chunks.push(chunk.subarray(0, take));
      this.inlineBytes += take;
    }
    if (take < chunk.byteLength) {
      this.truncated = true;
    }
    if (this.persistenceActive) this.writePersisted(chunk, source);
  }

  // 关闭写流：等待底层 end 回调，保证退出前 artifact 内容已 flush；未落盘时立即返回。
  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => {
      this.stream!.end(resolve);
    });
  }

  // 生成最终结果：text 仅含内联前缀；artifact 字段只在真正创建过写流时出现。
  // 解码走 decodeExecutionOutputBuffer，Windows 下按 legacyOutputEncoding 回退。
  result(): ExecutionStreamResult {
    const hasArtifact = this.stream !== undefined;
    return {
      text: decodeExecutionOutputBuffer(
        Buffer.concat(this.chunks, this.inlineBytes),
        this.legacyOutputEncoding,
      ),
      bytes: this.totalBytes,
      truncated: this.truncated,
      artifactPath: hasArtifact ? this.outputPath : undefined,
      artifactBytes: hasArtifact ? this.artifactBytes : undefined,
      artifactTruncated: hasArtifact ? this.artifactTruncated : undefined,
    };
  }

  // 已接收的总字节数（含未落盘部分），用于超时/限额判断。
  get bytes(): number {
    return this.totalBytes;
  }

  // 返回尾部文本用于进度预览；尚未收到任何字节时返回 undefined（区别于空串）。
  tailText(): string | undefined {
    if (this.tail.length === 0) return undefined;
    return decodeExecutionOutputBuffer(this.tail, this.legacyOutputEncoding);
  }

  // 滚动尾部：始终只保留最后 maxTailBytes，复制成新 Buffer 避免持有一整块大 chunk。
  private appendTail(chunk: Buffer): void {
    if (this.maxTailBytes <= 0 || chunk.byteLength === 0) return;
    const next = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    this.tail =
      next.byteLength > this.maxTailBytes
        ? Buffer.from(next.subarray(next.byteLength - this.maxTailBytes))
        : Buffer.from(next);
  }

  // 懒创建写流：无路径或落盘预算为 0 时保持 undefined，后续写入全部跳过。
  private ensurePersistedStream(): void {
    if (this.stream || !this.outputPath || this.maxPersistedBytes <= 0) return;

    mkdirSync(dirname(this.outputPath), { recursive: true });
    this.stream = createWriteStream(this.outputPath, { flags: "w" });
    this.stream.on("error", () => {
      this.artifactTruncated = true;
    });
  }

  // 首次落盘时把此前只在内存的内联块补写进文件，保证 artifact 从第一个字节起完整。
  private activatePersistence(source?: NodeJS.ReadableStream): void {
    if (this.persistenceActive) return;
    this.ensurePersistedStream();
    if (!this.stream) return;
    this.persistenceActive = true;
    for (const chunk of this.chunks) {
      this.writePersisted(chunk, source);
    }
  }

  // 写盘并同步扣减单路/共享预算；写满即标截断并只通知一次。
  // 写流背压时暂停源流，drain 后恢复，避免大输出把内存顶满。
  private writePersisted(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    if (!this.stream || chunk.byteLength === 0 || this.artifactTruncated) {
      return;
    }

    // 通用 pipe 执行仍在写盘前限制单路和共享预算；Bash 文件软阈值不经过这里。
    const streamRemaining = this.maxPersistedBytes - this.artifactBytes;
    const aggregateRemaining = this.aggregatePersistedBudget
      ? this.aggregatePersistedBudget.maxBytes - this.aggregatePersistedBudget.bytes
      : streamRemaining;
    const remaining = Math.min(streamRemaining, aggregateRemaining);
    if (remaining <= 0) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
      return;
    }

    const take = Math.min(remaining, chunk.byteLength);
    const persistedChunk = chunk.subarray(0, take);
    this.artifactBytes += persistedChunk.byteLength;
    if (this.aggregatePersistedBudget) {
      this.aggregatePersistedBudget.bytes += persistedChunk.byteLength;
    }
    if (take < chunk.byteLength) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
    }

    const canContinue = this.stream.write(persistedChunk);
    if (!canContinue && source) {
      source.pause();
      this.stream.once("drain", () => source.resume());
    }
  }

  // 回调一次后清空引用，确保上层只收到一次“落盘已截断”通知。
  private notifyPersistedLimit(): void {
    if (!this.onPersistedLimit) return;
    const callback = this.onPersistedLimit;
    this.onPersistedLimit = undefined;
    callback();
  }
}
