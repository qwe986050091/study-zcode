// ============================================================
// Tool Artifact Store Port - large tool result storage boundary
// ============================================================
// 定位：大体积工具结果的落盘边界。工具把超出 inline 预算的内容写进 artifact store，
// 只把摘要、预览与 uri 引用回给模型；完整内容只能通过 uri 回读（V4 分块查询、查看器），
// 不得再次整段回灌模型上下文。
// 归属：sessionId/turnId/toolCallId 决定可追踪性，retention 决定生命周期；
// uri 是跨进程稳定标识，path 是本地实现细节，调用方只应持久化 uri。

import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

// 保留范围。session 随会话结束清理，project 跟随工作区，temporary 由调用方自行清理。
// 该值只是写入时的声明，读取方不能假设文件必然还在；缺席时由 store 决定默认。
export type ToolArtifactRetention = "session" | "project" | "temporary";

// 文本 artifact 写入。toolCallId 允许 string：非模型发起的写入（hook、导入）也要能归属；
// contentType 缺省由 adapter 按扩展名推断；retention 缺省由 store 决定；trace 仅日志关联。
export interface ToolArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: string;
  contentType?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

// 二进制写入。contentType 必填（无法可靠推断）；extension 只影响落盘命名，不改变 contentType，
// 也不参与鉴权。该方法的逆运算是 readToolResultBinaryArtifact，绝不能拿文本读来还原。
export interface ToolBinaryArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: Uint8Array;
  contentType: string;
  extension?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

// 写入结果。id 是 store 内部标识，uri 是可供跨进程引用的稳定地址（应被持久化），
// path 是本地路径（可能缺席），createdAt 用于生命周期与展示；bytes 是实际写入量。
export interface ToolArtifactWriteResult {
  id: string;
  uri: string;
  path?: string;
  bytes: number;
  contentType: string;
  createdAt: Date;
}

// 文本读回请求。uri 必须来自 write 返回值——不要由调用方用本地路径拼装，
// 否则跨 session/跨进程不成立；trace 仅用于日志关联，不参与寻址。
export interface ToolArtifactReadRequest {
  uri: string;
  trace?: TraceContext;
}

// 文本读回结果。content 是写入时的文本原样（可能被 adapter 做行尾归一化），
// bytes 是落盘字节数而非字符数；path 可能缺席，调用方不得据此判断存在性。
export interface ToolArtifactReadResult {
  uri: string;
  content: string;
  contentType: string;
  bytes: number;
  path?: string;
}

/**
 * 二进制读回：**原始字节**，不经任何文本 / base64 编码。
 *
 * {@link ToolArtifactStorePort.readToolResultArtifact}
 * 把「按文件名再推一次 contentType → 文本走 utf8、其余走 base64」当作写入编码的逆运算，而
 * 推断表只认 txt/md/png/jpg/gif/webp/pdf/bin，`.xlsx` / `.docx` / `.pptx` 落到默认的
 * `application/json` 被当作 utf8 解码——办公文件读回即损坏且不可恢复。字节的消费者
 * （v4 分块查询、查看器）需要的是字节本身，编码是给模型面文本用的；两件事分开两个方法。
 * `contentType` 仍按文件名推断，仅供缺少更好来源的调用方兜底（dwf 用 journal 记录的那份）。
 */
export interface ToolBinaryArtifactReadResult {
  uri: string;
  bytes: Uint8Array;
  contentType: string;
  path?: string;
}

// 元数据探测请求。用于在不读回内容的前提下判断 artifact 是否仍然存在、多大；
// uri 语义与读回一致，trace 同样只做日志关联。
export interface ToolArtifactStatRequest {
  uri: string;
  trace?: TraceContext;
}

// 元数据结果。bytes/mtimeMs 反映**当前**落盘状态，不保证与写入结果相同
// （外部清理、retention 到期都会让数据消失）；调用方必须先 stat 再决定是否读。
export interface ToolArtifactStatResult {
  uri: string;
  bytes: number;
  contentType: string;
  path?: string;
  mtimeMs?: number;
}

// 图片附件路径预置。把已知字节按 uri 落地，返回可供宿主读取的本地 path。
// 幂等：同 uri 重复调用应复用同一结果，不得产生多份副本；mediaType 决定落盘扩展名。
export interface ImageAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

// 通用媒体附件预置，语义与图片版一致，覆盖非图片类型（音视频等）。
export interface MediaAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

// 仅按 uri 确保附件已落地（不提供字节），适用于 store 内部已持有内容的场景；
// mediaType 用于校验/命名，不构成新的写入来源。
export interface MediaAttachmentPathEnsureRequest {
  uri: string;
  mediaType: string;
}

// 附件路径结果。ready 表示宿主可直接读 path；unsupported 表示该媒体类型不走本地路径，
// 调用方必须改走 base64/内联传输，不能把 unsupported 当失败重试。
export type MediaAttachmentPathResult =
  | { status: "ready"; path: string }
  | { status: "unsupported" };

// artifact store 边界。文本写入与文本读回是必需契约；二进制写入/读回、stat、
// 附件路径预置均为可选能力，消费方必须用 typeof 探测而不是假定存在。
// 所有方法只接受 uri 寻址，端口内部不做权限判定——调用方应在进入前完成权限检查。
export interface ToolArtifactStorePort {
  writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  writeToolResultBinaryArtifact?(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult>;
  /**
   * 原始字节读回（见 {@link ToolBinaryArtifactReadResult}）。可选：与
   * {@link writeToolResultBinaryArtifact} 同规，不带二进制能力的 store 实现不必陪跑；
   * 消费方 `typeof` 探测，缺席即「本 store 不能提供字节」——不得退回文本读再解码。
   */
  readToolResultBinaryArtifact?(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult>;
  statToolResultArtifact?(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult>;
  primeImageAttachmentPath?(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  primeMediaAttachmentPath?(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  ensureMediaAttachmentPath?(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult>;
}
