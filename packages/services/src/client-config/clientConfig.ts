// 窗口级配置服务的类型与 channel 声明，只定义读取契约，不实现缓存与请求。
// INV：配置快照的唯一来源是 ClientConfig channel 的响应，本模块不持有第二份状态。
// 在此缓存或补默认值会让多窗口读到不一致配置，并使刷新时机脱离服务端事实。
import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 窗口级公开配置读取。业务模块只消费自己的字段，不拥有第二份请求缓存。 */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
);
