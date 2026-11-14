import type {
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";

/**
 * 附件物化后的定位信息：决定"冷恢复能否重建正文"。
 *
 * - metadata.artifactUri：已写入 artifact store 的 URI；undefined 表示这次没有落盘。
 * - metadata.recoverability：恒为 provider_ready —— 本函数只在两种"可直接发送"的形态
 *   （已落盘 artifact 或原始 inline data URL）下返回，不会产出 preview/metadata_only。
 * - metadata.storageKind：artifact = 内容在 store 里可重建；inline = 只存在于当前请求体。
 * - url：发给 provider 的引用（artifact URI 或原 data URL），也是日志里 classifyAttachmentUrl 的输入。
 *
 * 用来描述"已落盘/仅内存"的附件资源，供 image/pdf/video 三条分支统一复用。 */
type PersistedAttachmentResource = {
  metadata: {
    artifactUri?: string;
    recoverability: "provider_ready";
    storageKind: "artifact" | "inline";
  };
  url: string;
};

/**
 * 从历史 attachment 里读回的可用内容。
 *
 * - artifactUri：内容来自 zcode-artifact:// 且读取成功；存在时说明冷恢复仍可重建。
 * - dataUrl：可直接进入请求体的 data URL；只有它是 data: 前缀时才值得重发。
 *
 * 两个字段互斥地说明"来源"：只有 dataUrl 表示内容就是原始 inline 载荷。 */
type InlineAttachmentContent = {
  artifactUri?: string;
  dataUrl: string;
};

/**
 * 把 data URL 形式的内联媒体物化为"可直接发送且尽量可恢复"的资源。
 *
 * 三条路径（按优先级）：
 * 1. existingArtifactUri 已存在：直接复用，避免同一内容被重复写盘；
 * 2. 没有 artifactStore 或 sessionId：降级为 inline，当前请求可用，但冷恢复无法重建；
 * 3. 其余：写入 artifact store（content 是 data URL 文本本身，所以 contentType 固定 text/plain）。
 *
 * 输入输出：入参 index 同时决定 toolCallId/toolName 的稳定锚点（attachment-N / attachment:mediaType），
 * 返回 PersistedAttachmentResource；url 与 metadata.artifactUri 在成功落盘时是同一个 artifact URI。
 * 副作用：一次 artifact store 写盘（可能在磁盘上生成新 artifact）；不修改任何历史。
 * 失败语义：写盘错误直接向上抛，绝不在内存媒体可用时吞掉——否则会落下"当前能发、冷恢复读不回"
 * 的成功历史，导致 live 与 resume 形态不一致。
 * 不变量：无论走哪条路径，recoverability 都是 provider_ready；调用方据此信任 url 可直接发送。
 */
export async function persistAttachmentDataUrl(
  dataUrl: string,
  index: number,
  mediaType: string,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<PersistedAttachmentResource> {
  // 复用上游已经落盘的 artifact：同一附件重发/重试时不该产生第二份 artifact。
  if (options.existingArtifactUri) {
    return {
      metadata: {
        artifactUri: options.existingArtifactUri,
        recoverability: "provider_ready",
        storageKind: "artifact",
      },
      url: options.existingArtifactUri,
    };
  }

  // 缺少落盘端口时不阻断当前请求：宁可"只能发一次"，也不要让用户附件直接失败。
  if (!options.artifactStore || !options.sessionId) {
    return {
      metadata: { recoverability: "provider_ready", storageKind: "inline" },
      url: dataUrl,
    };
  }

  // 内存媒体仍可供当前请求使用时吞掉写入失败，会落下冷恢复无法重建的成功历史。
  // image/video 共用这一持久化边界；写入失败必须在 provider 调用前终止当前轮。
  const artifact = await options.artifactStore.writeToolResultArtifact(
    {
      content: dataUrl,
      contentType: "text/plain",
      retention: "session",
      sessionId: options.sessionId,
      toolCallId: `attachment-${index + 1}`,
      toolName: `attachment:${mediaType}`,
      trace: options.traceContext,
      turnId: options.turnId,
    },
    { signal: options.abortSignal },
  );
  return {
    metadata: {
      artifactUri: artifact.uri,
      recoverability: "provider_ready",
      storageKind: "artifact",
    },
    url: artifact.uri,
  };
}

/**
 * 读回历史 attachment 的可用内容（data URL 或 artifact）。
 *
 * 职责：把 TurnAttachment.content 归一成"可直接重发的内容"，供 resolve 阶段复用。
 * 输入：attachment.content 可能是 data:、zcode-artifact://（已落盘）或已失效的引用。
 * 输出：命中 data: 直接返回；命中 artifact URI 且能读出 data URL 时返回 artifactUri + dataUrl；
 *      content 缺失、前缀不认识、无 artifactStore 或读盘异常均返回 undefined。
 * 副作用：命中 artifact 时有一次 artifact store 读；无写操作。
 * 失败与降级：读盘异常被吞掉并返回 undefined，调用方会降级为 placeholder（attachment_read_failed）；
 * 这是"读不出内容不等于请求必须失败"的刻意取舍，但绝不返回半截内容。
 * 不变量：返回的 dataUrl 必须是 data: 前缀——artifact 里存的若是二进制原文，说明形态不匹配，视为失败。
 */
export async function readInlineAttachmentContent(
  attachment: TurnAttachment,
  options: {
    artifactStore?: ToolArtifactStorePort;
    traceContext: TraceContext;
  },
): Promise<InlineAttachmentContent | undefined> {
  if (!attachment.content) return undefined;
  if (attachment.content.startsWith("data:")) {
    return { dataUrl: attachment.content };
  }
  // 只有 artifact URI 才需要读盘；普通文本/未知前缀交给调用方的其它分支处理。
  if (!attachment.content.startsWith("zcode-artifact://") || !options.artifactStore) {
    return undefined;
  }
  try {
    const artifact = await options.artifactStore.readToolResultArtifact({
      trace: options.traceContext,
      uri: attachment.content,
    });
    return artifact.content.startsWith("data:")
      ? { artifactUri: attachment.content, dataUrl: artifact.content }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 生成可安全写入 metadata 的"原始引用"。
 *
 * 口径：优先用本地 path；没有 path 时对 data URL 只记一个占位标记 `inline:data-url`，
 * 避免把整段 base64 正文复制进 metadata（落盘后体积膨胀，且等于把附件内容写第二遍）。
 * 其它 content（例如 artifact URI）原样返回，便于诊断与按授权路径重试。
 * 无副作用；无失败分支。
 */
export function safeAttachmentOriginalRef(attachment: TurnAttachment): string | undefined {
  if (attachment.path) return attachment.path;
  if (!attachment.content) return undefined;
  return attachment.content.startsWith("data:") ? "inline:data-url" : attachment.content;
}
