import type { ProviderProvisioningEnvelope, ProviderProvisioningResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// INV-01：Provisioning target 只经由 ServiceChannels.ProviderProvisioningTarget 暴露，
// 不挂到 IServiceAccessor，保证除远端同步外没有本地调用点能直接改写目标端 Provider Store。
/** 仅供 Window Host 调用的远端 Environment target，不加入 IServiceAccessor。 */
export interface IProviderProvisioningTargetService {
  apply(envelope: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult>;
}

// [权衡] 描述符与接口同名是仓库约定：类型与运行时值共享一个标识符，
// 调用方 import 一次即可同时拿到类型与通道。
export const IProviderProvisioningTargetService =
  createServiceDescriptor<IProviderProvisioningTargetService>(
    ServiceChannels.ProviderProvisioningTarget,
  );
