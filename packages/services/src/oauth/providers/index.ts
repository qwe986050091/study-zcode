// OAuth provider 适配器的装配点：把运行时配置里的 provider 列表翻译成可调用的 adapter 实例。
// 边界：只做构造与分派，不发起登录、不缓存 token，也不校验 provider 配置的合法性细节。
// INV：apiClient 必须由外部注入；缺省即抛错，禁止在内部新建隐式实例造成多份连接池。
// 改错后果：未知 provider 误报错会让整个登录能力不可用，因此 default 分支必须静默跳过。
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type ApiClient } from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { BigModelProviderAdapter } from "./bigmodelProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ZaiProviderAdapter } from "./zaiProviderAdapter.js";

/** 根据运行时配置创建可用 provider adapter */
// 返回顺序与配置顺序一致：调用方常按数组首位选取默认登录入口，乱序会改变默认行为。
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
// 每次调用新建数组并逐个 push，保持纯函数语义：同一份 config 多次调用互不共享实例。
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
// 快速失败：配置声明了 provider 却没有 apiClient 属于装配错误，不应降级成空列表掩盖问题。
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

// 逐个构造而非一次性 map，便于将来按 provider 追加初始化步骤（如 scope 校验）。
  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case BIGMODEL_PROVIDER_ID:
        adapters.push(new BigModelProviderAdapter(providerConfig, apiClient));
        break;
      case ZAI_PROVIDER_ID:
        adapters.push(new ZaiProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // 未知 provider 直接忽略，避免单个配置错误拖垮全部登录能力。
        break;
    }
  }

  return adapters;
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
