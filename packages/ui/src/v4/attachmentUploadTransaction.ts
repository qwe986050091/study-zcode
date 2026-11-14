// INV-01 分片大小固定且能被三整除：守住位置 分片常量；改错故障：末片之外出现 base64 填充，服务端按长度校验会拒绝。
// INV-02 上传前先按长度预检：超限直接失败，守住位置 解码长度检查；改错故障：先解码再判断会让超大载荷占用内存后才被拒。
// INV-03 长度校验与解码结果必须一致：守住位置 两者比对；改错故障：不一致说明输入被篡改或实现漂移，继续上传会写入损坏数据。
// INV-04 每帧请求都要计量物理大小：守住位置 三处断言；改错故障：漏计量会让超限请求在传输层被静默截断。
// INV-05 校验和覆盖完整字节：守住位置 校验和计算；改错故障：只算首片会让服务端无法验证整体完整性。
// INV-06 中断检查覆盖每个提交点：解码后、开始前、每片前与提交前，守住位置 四处检查；改错故障：漏一处会让取消后仍继续发送。
// INV-07 开始响应已提交时直接返回引用：守住位置 已提交分支；改错故障：继续发送分片会与服务端状态冲突。
// INV-08 服务端进度必须单调且不越界：守住位置 两处进度校验；改错故障：进度回退或越界说明协议被破坏，继续写入会错位。
// INV-09 分片索引从服务端返回处续传：守住位置 循环起点；改错故障：总是从零开始会重复上传已收分片。
// INV-10 上传标识每次事务重新生成：守住位置 标识构造；改错故障：复用标识会让两次上传在服务端合并。
// INV-11 中止只在中段失败时执行：守住位置 异常分支的已开始判断；改错故障：未开始时也中止会向服务端发无意义请求。
// INV-12 中止失败不掩盖原始错误：守住位置 中止的异常捕获；改错故障：吞掉原始错误后，用户只看到中止失败。
// INV-13 进度回调只报告单调推进的字节数：守住位置 三处进度上报；改错故障：跳变会让进度条倒退。
// INV-14 提交参数与公共参数同源：守住位置 提交参数取值；改错故障：另起一套会让会话或上传标识不一致。
// INV-15 解码前先做字符集与填充校验：守住位置 长度计算函数；改错故障：非法字符进入解码会静默产生错误字节。
// INV-16 编码分块避免超出调用栈：守住位置 编码分块大小；改错故障：一次性展开大数组会触发参数数量上限。
// INV-17 校验和不可用时立即失败：守住位置 加密能力判断；改错故障：降级为无校验会让服务端接受内容不一致的附件。
// INV-18 缺少随机标识接口时回退随机字：守住位置 标识生成分支；改错故障：直接抛错会让旧运行时无法上传。
//
// 模块职责：把一份 base64 附件按分片协议上传，含预检、校验和、进度、续传与失败中止。
// 状态所有权：无持久状态；上传标识、公共参数与已开始标记都是单次事务的局部值。
// 阅读顺序：先看常量与编解码工具，再看请求计量，最后看事务主流程与中止分支。
import { BufferWriter, serialize } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentPutParams,
  type V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import { logger } from "@/logger.js";

/** 384KiB 可被 3 整除，除末片外 base64 不含 padding；同时为两层 envelope 留足空间。 */
// 分片大小决定单帧物理大小，必须给两层封装留足余量
// [失败路径] 取值过大时单帧超限，服务端按帧上限拒绝整次上传
// 384KiB 能被三整除，除末片外 base64 编码结果不含 padding。
// ATTACHMENT_UPLOAD_CHUNK_BYTES 同时影响进度换算与分片索引。
// [权衡] 不按内容自适应，固定值由两端协议对齐。
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 384 * 1024;

export interface AttachmentUploadAgent {
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentPutResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
}

export interface AttachmentUploadWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AttachmentUploadProgress {
  phase: "uploading" | "committing";
  uploadedBytes: number;
  totalBytes: number;
}

export interface AttachmentUploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AttachmentUploadProgress) => void;
}

// 中断检查是纯函数：只读信号并抛标准中止错误
// [失败路径] 抛普通错误会让上层无法区分取消与真实失败
// error.name 设为 AbortError，与取消语义一致而便于统一捕获。
// 未中断时立即 return，不产生额外分配。
// throwIfAborted 在多个提交点复用，保证检查口径一致。
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Attachment upload canceled");
  error.name = "AbortError";
  throw error;
}

function decodeBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// 长度计算先校验字符集与填充，再换算字节数
// [失败路径] 跳过字符集校验会让非法输入静默解码出错误字节
// padding 只允许出现在末尾且最多两个。
// dataBase64.length 必须是四的倍数，否则直接判非法。
// decodedBase64ByteLength 只计算不分配，避免为预检复制整份载荷。
function decodedBase64ByteLength(dataBase64: string): number {
  if (dataBase64.length === 0) return 0;
  if (dataBase64.length % 4 !== 0) throw new Error("proto.invalidBase64");
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const contentLength = dataBase64.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = dataBase64.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) throw new Error("proto.invalidBase64");
  }
  for (let index = contentLength; index < dataBase64.length; index += 1) {
    if (dataBase64.charCodeAt(index) !== 61) throw new Error("proto.invalidBase64");
  }
  return (dataBase64.length / 4) * 3 - padding;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const callStackSafeChunk = 0x8000;
  for (let index = 0; index < bytes.length; index += callStackSafeChunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + callStackSafeChunk));
  }
  return btoa(binary);
}

// 校验和是整份字节的摘要，用于服务端验证完整性
// [失败路径] 不检查加密能力就调用，会在旧运行时抛类型错误
// Uint8Array.from(bytes) 复制一份缓冲区，避免摘要期间底层视图被复用。
// 输出 sha256: 前缀的十六进制串，便于将来换算法。
// checksum 是事务中唯一需要异步前置的步骤。
async function checksum(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("fault.attachment.checksumUnavailable");
  // WebCrypto 的 BufferSource 要求 ArrayBuffer；复制也避免调用期间底层 view 被复用。
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function createUploadId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return `upload-${globalThis.crypto.randomUUID()}`;
  }
  const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return `upload-${[...words].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}

/** 用 production ChannelClient 相同的 serializer 计量完整 method+args physical request。 */
// 计量用与生产客户端相同的序列化器，反映真实物理请求
// [失败路径] 用近似大小会让边界请求在 PROTOCOL_V4_LIMITS 上限处被传输层拒绝。
// RequestType 100 与最大整数标识都取保守值。
// 方法与参数分两次 serialize，与真实帧结构一致。
// 返回值只用于比较 PROTOCOL_V4_LIMITS.maxFrameBytes，不参与协议字段。
export function measureAttachmentChannelRequestBytes(method: string, params: unknown): number {
  const writer = new BufferWriter();
  // RequestType.Promise=100；max int id 比正常短生命周期 request id 更保守。
  serialize(writer, [100, 2_147_483_647, ServiceChannels.ZCodeAgent, method]);
  serialize(writer, [params]);
  return writer.buffer.byteLength;
}

function assertAttachmentChannelRequest(method: string, params: unknown): void {
  if (measureAttachmentChannelRequestBytes(method, params) > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

// 事务顺序：预检、解码、生成标识、开始、分片、提交
// [失败路径] 先解码再判断长度会让超大载荷先占满内存
// begin 响应已提交时直接返回，不再发送任何分片。
// 分片索引从 result.nextChunkIndex 续传，支持断点重试。
// 每片发送前都计量大小并调用 throwIfAborted。
export async function uploadAttachmentTransaction(
  agent: AttachmentUploadAgent,
  workspace: AttachmentUploadWorkspace,
  input: V4AttachmentPutParams,
  options: AttachmentUploadOptions = {},
): Promise<V4AttachmentPutResult> {
  throwIfAborted(options.signal);
  const decodedBytes = decodedBase64ByteLength(input.dataBase64);
  if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    throw new Error("proto.payloadTooLarge");
  }
  const bytes = decodeBase64(input.dataBase64);
  if (bytes.byteLength !== decodedBytes) throw new Error("proto.invalidBase64");
  const uploadId = createUploadId();
  const common = { ...workspace, sessionId: input.sessionId, uploadId };
  const totalChunks = Math.ceil(bytes.byteLength / ATTACHMENT_UPLOAD_CHUNK_BYTES);
  const beginParams: ZCodeAgentAttachmentBeginParams = {
    ...common,
    fileName: input.fileName,
    mime: input.mime,
    totalBytes: bytes.byteLength,
    totalChunks,
    checksum: await checksum(bytes),
  };
  assertAttachmentChannelRequest("attachmentBeginV4", beginParams);

  let began = false;
  try {
    throwIfAborted(options.signal);
    const begin = await agent.attachmentBeginV4(beginParams);
    began = true;
    if (begin.state === "committed") {
      options.onProgress?.({
        phase: "committing",
        uploadedBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
      });
      return { ref: begin.ref };
    }
    if (begin.nextChunkIndex > totalChunks) {
      throw new Error("fault.attachment.invalidServerProgress");
    }
    options.onProgress?.({
      phase: "uploading",
      uploadedBytes: Math.min(
        begin.nextChunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES,
        bytes.byteLength,
      ),
      totalBytes: bytes.byteLength,
    });
    for (let chunkIndex = begin.nextChunkIndex; chunkIndex < totalChunks; chunkIndex += 1) {
      throwIfAborted(options.signal);
      const start = chunkIndex * ATTACHMENT_UPLOAD_CHUNK_BYTES;
      const chunkParams: ZCodeAgentAttachmentChunkParams = {
        ...common,
        chunkIndex,
        dataBase64: encodeBase64(
          bytes.subarray(start, Math.min(start + ATTACHMENT_UPLOAD_CHUNK_BYTES, bytes.length)),
        ),
      };
      assertAttachmentChannelRequest("attachmentChunkV4", chunkParams);
      const result = await agent.attachmentChunkV4(chunkParams);
      if (result.nextChunkIndex !== chunkIndex + 1) {
        throw new Error("fault.attachment.invalidServerProgress");
      }
      options.onProgress?.({
        phase: "uploading",
        uploadedBytes: Math.min((chunkIndex + 1) * ATTACHMENT_UPLOAD_CHUNK_BYTES, bytes.byteLength),
        totalBytes: bytes.byteLength,
      });
    }
    throwIfAborted(options.signal);
    options.onProgress?.({
      phase: "committing",
      uploadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    const terminal = common satisfies ZCodeAgentAttachmentTerminalParams;
    assertAttachmentChannelRequest("attachmentCommitV4", terminal);
    return await agent.attachmentCommitV4(terminal);
  // 异常分支只在中段失败时尝试中止，避免无意义请求
  // [失败路径] 未开始时也中止会让服务端收到不存在的上传标识
  // 中止自身失败只 logger.warn 记录告警，不掩盖原始错误。
  // [权衡] 中止不重试，留给下一轮 uploadAttachmentTransaction 重新开始。
  // 无论中止结果如何，原始 error 都会原样抛出。
  } catch (error) {
    if (began) {
      try {
        await agent.attachmentAbortV4(common);
      } catch (abortError) {
        logger.warn("[v4-attachment] failed to abort upload transaction", abortError);
      }
    }
    throw error;
  }
}
