// 媒体预览服务：把「路径 + 期望媒体类型」解析成前端可直接消费的预览载荷。
// 三条返回路径按运行环境降级：宿主可授权时给本地 URL（支持 range 拖动），无法授权时退回内联 base64。
// 本文件只做格式校验、大小校验与形态选择，不负责实际读出字节；读文件统一委托 IFileService。
// 安全边界：期望类型由调用方给出，必须与扩展名推断结果一致，避免把任意文件当媒体回传。
import { getMediaPreviewFormat, ServiceChannels, type MediaPreviewKind } from "@zcode/shared";
import type { IFileService } from "../file/file.js";
import { createServiceDescriptor } from "../descriptors.js";

// 预览载荷的三种形态，调用方按 kind 判别字段，避免可空字段组合。
// local-url 由宿主直接提供服务；host-range-url 带过期时间，需要调用方在到期前刷新；inline 则是完整的 base64 数据。
export type MediaPreviewPreparation =
  | {
      kind: "local-url";
      mediaType: string;
      path: string;
      size: number;
      url: string;
    }
  | {
      kind: "host-range-url";
      mediaType: string;
      path: string;
      previewId: string;
      size: number;
      url: string;
      urlExpiresAt: number;
    }
  | {
      kind: "inline";
      dataBase64: string;
      mediaType: string;
      path: string;
      size: number;
    };

// 服务契约：prepare 是必需能力，刷新与释放为可选（仅宿主 URL 形态需要）。
// 实现方不得在 prepare 内持有跨请求状态，预览生命周期由调用方根据 previewId 管理。
export interface IMediaPreviewService {
  prepare(params: {
    path: string;
    expectedKind: MediaPreviewKind;
  }): Promise<MediaPreviewPreparation>;
  refreshPlaybackUrl?(params: { previewId: string }): Promise<{
    url: string;
    expiresAt: number;
  }>;
  // 释放宿主侧占用的播放句柄或临时租约；重复释放应当幂等，未知 previewId 视为已释放。
  // 未实现该能力时调用方无需处理，属于可选契约。
  release?(params: { previewId: string }): Promise<void>;
}

// 服务描述符用于 RPC 注册与客户端解析，类型参数保证实现与契约保持同步。
export const IMediaPreviewService = createServiceDescriptor<IMediaPreviewService>(
  ServiceChannels.MediaPreview,
);

// 工厂采用依赖注入：文件读取能力必传，宿主 URL 授权与 URL 构造成对出现才启用 URL 分支。
// 只传其中一个回调时静默忽略 URL 分支而不是报错，保持桌面/Web 两种宿主可以复用同一实现。
// inlineMaxBytes 允许宿主收紧内联上限，避免大视频被整段塞进消息体。
export function createMediaPreviewService(options: {
  fileService: IFileService;
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  createLocalMediaPreviewUrl?: (path: string) => string;
  inlineMaxBytes?: number;
}): IMediaPreviewService {
  // 默认 8MB：base64 会再膨胀约 1/3，超过该量级走内联会显著拖慢 RPC 与渲染进程内存。
  // 该值只约束内联分支，宿主 URL 分支按需读取不受影响。
  const inlineMaxBytes = options.inlineMaxBytes ?? 8 * 1024 * 1024;

  return {
    async prepare({ path, expectedKind }) {
      // 先按扩展名判定媒体类型，未识别或与期望类型不符直接拒绝，避免对任意路径做 stat 甚至读取。
      // 错误文案带上原始路径，便于前端定位是哪个附件不被支持。
      const format = getMediaPreviewFormat(path);
      if (!format || format.kind !== expectedKind) {
        throw new Error(`Unsupported media preview format: ${path}`);
      }

      // 格式校验通过后才做 stat，把无效请求的开销压到最低。
      // stat 失败（不存在、无权限）不做吞掉处理，直接冒泡给调用方以便区分「不支持」与「读不到」。
      const fileStat = await options.fileService.stat({ path });
      // 只接受普通文件：目录、符号链接目标异常或 size 缺失都无法保证可预览，统一拒绝而不是尝试读取。
      // 这里不复用 stat 之外的探测，避免为一次预览引入额外 IO。
      if (fileStat.type !== "file" || typeof fileStat.size !== "number") {
        throw new Error(`Path is not a media file: ${path}`);
      }

      // 宿主可授权时优先走 URL：授权回调可能返回规范化后的真实路径（如解析符号链接），后续 URL 与大小都以它为准。
      // 该分支不受 inlineMaxBytes 限制，因为播放端按 range 流式读取，不占用 RPC 载荷。
      // 两个回调必须成对存在，缺一个就整体跳过，避免生成指向不存在路由的 URL。
      if (options.authorizeLocalMediaPreviewPath && options.createLocalMediaPreviewUrl) {
        const canonicalPath = await options.authorizeLocalMediaPreviewPath(path);
        return {
          kind: "local-url",
          mediaType: format.mediaType,
          path: canonicalPath,
          size: fileStat.size,
          url: options.createLocalMediaPreviewUrl(canonicalPath),
        };
      }

      // 无宿主 URL 能力时才走内联，这里必须显式拒绝超限文件，否则超大 base64 会塞进单次响应。
      if (fileStat.size > inlineMaxBytes) {
        throw new Error(`Media file is too large for inline preview: ${path}`);
      }

      // 读取上限与内联上限保持一致；size 用实际读到的 totalBytes，避免 stat 与读取之间文件被改导致不一致。
      const preview = await options.fileService.readMediaPreview({
        path,
        maxBytes: inlineMaxBytes,
      });
      return {
        kind: "inline",
        dataBase64: preview.dataBase64,
        mediaType: preview.mediaType,
        path,
        size: preview.totalBytes,
      };
    },
  };
}
