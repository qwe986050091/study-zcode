// Services 侧的 ZCode 内置 Release 远端拉取入口：只做依赖注入，不实现 URL 与校验。
// INV-01：URL 构造、下载预算与 Release 校验由 provider-node 唯一实现，本文件不得复制这些规则。
// INV-02：request 必须绑定传入的 apiClient（含鉴权与代理配置），不能退化成全局 fetch。
import { downloadZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "@zcode/provider-node";
import type { ApiClient } from "@zcode/shared";

// signal 用于上层取消（退出或切包）；platform 与 appVersion 决定下载产物，缺一不可。
export interface FetchZCodeBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
}

/** Services 仅注入既有网络装配；URL、预算与 Release 校验由 provider-node 唯一实现。 */
export async function fetchZCodeBuiltinRemoteRelease(
  options: FetchZCodeBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinRelease | null> {
// [失败路径] 下载失败时返回 null（可降级为无内置包），只有真正的异常才向上抛。
  return downloadZCodeBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
// 透传 apiClient.request 而不是 readApiJson：内置包是二进制流，不能按 JSON 解析。
    request: (url, init) => options.apiClient.request(url, init),
  });
}
