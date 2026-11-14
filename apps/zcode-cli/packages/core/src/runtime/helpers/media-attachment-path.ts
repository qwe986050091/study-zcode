import type {
  ModelInputMessage,
  ModelMessageContentBlock,
  ToolArtifactStorePort,
} from "../deps.js";

/**
 * 媒体附件路径化：给 provider 可读取的媒体补上"可定位的源路径"。
 *
 * 目的：某些 provider 需要一个可重新读取的本地/派生路径（而不是只有 base64），
 * 以便模型后续用文件工具查看原图/原视频/原 PDF。这是"可选增强"：
 * - inline 媒体只有在 source.uri 是 zcode-artifact:// 时才尝试派生路径；
 * - local_file 已有真实 path 时直接复用；
 * - 派生失败会抛错（fail closed），因为此时请求已经声明"支持路径引用"，
 *   静默降级会让模型拿到一个它以为能读、实际读不到的路径。
 *
 * 输出：新的消息数组；changed=false 时返回原数组引用。
 * 副作用：可能调用 artifactStore.ensureMediaAttachmentPath（读/建派生文件），无持久化写入。
 * 不变量：每条被路径化的消息末尾都会追加一行 `[Image/Video/PDF: source: <path>]` 文本，
 * 保证模型在 contentBlock 之外也能看到路径（部分 provider 不转发 source 元数据）。
 */

type PathProjectableMediaBlock =
  | Extract<ModelMessageContentBlock, { type: "image" | "video" }>
  | (Extract<ModelMessageContentBlock, { type: "file" }> & { mediaType: "application/pdf" });

/**
 * 给 user 消息里的媒体块补源路径，并在消息尾部追加可读的路径说明。
 *
 * 只处理 role=user：assistant 历史里不会出现需要重新读取的附件媒体。
 * 处理粒度是整条消息：先筛出可路径化的块，并发解析它们各自的 path（不同 artifact 互不依赖），
 * 再用 Map 记录"块对象 → path"；解析失败的块会让 Promise.all 直接 reject，从而让整次请求失败。
 *
 * 输出：新的消息数组（content 为新数组、末尾追加路径说明）；没有任何可路径化块时返回原数组引用。
 * 副作用：每块一次 ensureMediaAttachmentPath（可能读/建派生文件）。
 * 失败语义：抛错上抛到 runModelTextRequest，本轮请求在 provider 调用前终止；不降级。
 * 不变量：追加的说明文本顺序与 pathByBlock 的插入顺序一致（即 mediaBlocks 顺序）。
 */
export async function projectMessagesWithMediaAttachmentPaths(
  messages: ModelInputMessage[],
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<ModelInputMessage[]> {
  let changed = false;
  const projected = await Promise.all(
    messages.map(async (message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) return message;

      const mediaBlocks = message.content.filter(isPathProjectableUserMedia);
      if (mediaBlocks.length === 0) return message;
      const paths = await Promise.all(
        mediaBlocks.map((block) => resolveMediaAttachmentPath(block, artifactStore)),
      );
      const pathByBlock = new Map<PathProjectableMediaBlock, string>();
      mediaBlocks.forEach((block, index) => {
        const path = paths[index];
        if (path) pathByBlock.set(block, path);
      });
      if (pathByBlock.size === 0) return message;

      changed = true;
      // 未命中的块也要克隆一遍再返回:调用方拿到的是新数组,不能出现"部分块与入参共享引用"
      // 的混合形态,否则后续投影改动会互相污染。
      const content = message.content.map((block) => {
        if (!isPathProjectableUserMedia(block) || !pathByBlock.has(block)) {
          return cloneContentBlock(block);
        }
        return {
          ...block,
          source: { ...block.source!, path: pathByBlock.get(block)! },
        };
      });
      content.push(
        // 路径同时写进 source 与文本:前者供 provider 结构化消费,后者保证纯文本渲染
        // (或 source 被 provider 丢弃)时模型仍能看到可读取的位置。
        ...[...pathByBlock.entries()].map(([block, path]) => ({
          type: "text" as const,
          text: mediaSourceText(block.type, path),
        })),
      );
      return {
        ...message,
        cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
        content,
        toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
      };
    }),
  );
  return changed ? projected : messages;
}

/**
 * 判定一个 user 消息块是否"有资格补路径"。
 *
 * 只接受 image/video/PDF（file 的 PDF 判定见 isPdfBlock）；同类型内还要求：
 * - inline：source.uri 必须是 zcode-artifact://，否则没有 durable 内容可派生；
 * - local_file：source.path 必须非空，否则本来就没有可复用路径。
 * 该函数的输出直接决定"要不要调用 store"，因此必须保守：宁可跳过，也不触发无意义的派生/报错。
 */
function isPathProjectableUserMedia(
  block: ModelMessageContentBlock,
): block is PathProjectableMediaBlock {
  // inline 只表示 provider-ready 媒体，不保证存在可重建的 durable artifact。
  // path 是可选增强；只有 artifact URI 或已有本地 path 才参与物化，避免阻断既有媒体发送。
  return (
    (block.type === "image" || block.type === "video" || isPdfBlock(block)) &&
    ((block.source?.kind === "inline" &&
      block.source.uri?.startsWith("zcode-artifact://") === true) ||
      (block.source?.kind === "local_file" && Boolean(block.source.path)))
  );
}

/**
 * 单个块解析可用的源路径。
 *
 * 优先级：
 * 1. local_file 且已有 path → 直接复用（本地文件本来就可读，无需派生）；
 * 2. inline 且 source.uri 是 zcode-artifact:// 且 store 支持 ensureMediaAttachmentPath →
 *    由 store 派生/复用路径；
 * 3. 其余一律抛 materialization 错误（包括 store 返回空路径或读盘异常）。
 *
 * 返回 undefined 的唯一情况是 store 明确报告 unsupported（该 artifact 类型不需要路径），
 * 此时调用方会跳过该块而不追加说明文本。
 * 副作用：一次 ensureMediaAttachmentPath（可能生成派生文件）。
 * 不变量：派生路径即使输入里残留旧 path 也以 store 返回为准（inline 的 path 不是会话事实）。
 */
async function resolveMediaAttachmentPath(
  block: PathProjectableMediaBlock,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<string | undefined> {
  const source = block.source!;
  const mediaType = isPdfBlock(block) ? "pdf" : block.type;
  if (source.kind === "local_file" && source.path) return source.path;

  const uri = source.uri;
  if (!uri?.startsWith("zcode-artifact://") || !artifactStore?.ensureMediaAttachmentPath) {
    throw mediaAttachmentMaterializationError(mediaType, source.placeholder ?? uri ?? source.id);
  }
  try {
    // inline 的派生 path 不是会话事实，即使输入中意外残留旧 path，
    // 也必须通过 durable artifact URI 重新检查，缺失时由 store 重建。
    const result = await artifactStore.ensureMediaAttachmentPath({
      mediaType: source.mimeType ?? block.mediaType,
      uri,
    });
    if (result.status === "unsupported") return undefined;
    if (!result.path.trim()) throw new Error("empty derived path");
    return result.path;
  } catch (error) {
    throw mediaAttachmentMaterializationError(mediaType, source.placeholder ?? uri, error);
  }
}

/**
 * 构造 materialization 失败错误（保留 cause，便于上游区分"读盘失败"与"形态不支持"）。
 * 错误文本只包含媒体类型与 placeholder/URI，不包含 base64 正文。
 */
function mediaAttachmentMaterializationError(
  type: "image" | "video" | "pdf",
  label: string,
  cause?: unknown,
): Error {
  return new Error(`Unable to materialize ${type} attachment path: ${label}`, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

/**
 * 生成追加到消息尾部的路径说明文本（Image/Video/PDF 三种标签）。
 * 纯文本形态避免依赖 provider 对 source 元数据的支持。
 */
function mediaSourceText(type: PathProjectableMediaBlock["type"], path: string): string {
  const label = type === "image" ? "Image" : type === "video" ? "Video" : "PDF";
  return `[${label}: source: ${path}]`;
}

/**
 * 判定 file 块是否 PDF：mediaType 允许带参数（如 application/pdf; charset=...），
 * 因此先按分号截断、trim、小写再比较。不做扩展名或魔数校验（那属于附件解析阶段）。
 */
function isPdfBlock(block: ModelMessageContentBlock): block is Extract<
  ModelMessageContentBlock,
  { type: "file" }
> & {
  mediaType: "application/pdf";
} {
  return (
    block.type === "file" &&
    block.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
  );
}

function cloneContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "image" || block.type === "video" || block.type === "file") {
    return { ...block, source: block.source ? { ...block.source } : undefined };
  }
  return { ...block };
}
