// 云内容服务契约：只声明发布媒体的读取与租约式准备/释放，不承载缓存实现。
// INV：prepare 返回的 leaseId 必须由同一服务实例 release，租约不跨进程存活。
// 改错后果：漏释放或错配租约会让缓存条目长期占用，后续请求持续 miss 并放大回源压力。
import { ServiceChannels, type CloudContentBundle, type MarketingAsset } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface ICloudContentService {
  readPublishedMedia(input: { asset: MarketingAsset; kind: "image" | "video" }): Promise<string>;
  prepare(input: {
    bundle: CloudContentBundle;
  }): Promise<{ leaseId: string; url: string; cacheHit: boolean }>;
  release(input: { leaseId: string }): Promise<void>;
}
// 描述符把契约绑定到 CloudContent 频道，频道名改动会直接切断现有调用方。
export const ICloudContentService = createServiceDescriptor<ICloudContentService>(
  ServiceChannels.CloudContent,
);
