import {
  projectModelSelectionProviderView,
  type ModelSelectionView,
  type ProviderRegistryView,
} from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

/** Off-Peak 只投影固定隐藏 Provider，不向普通用户选择面开放隐藏候选。 */
// 闲时（Off-Peak）模型选择视图投影：只暴露白名单内的隐藏 Provider。
// INV-01：候选必须同时满足「在 OFF_PEAK_PROVIDER_IDS 内」且 visibility === "hidden"。
// INV-02：返回值被 Object.freeze 冻结，调用方不能就地改写共享的 registry 视图。
export function buildOffPeakModelSelectionView(registry: ProviderRegistryView): ModelSelectionView {
// 白名单转 Set 做 O(1) 判定；输出顺序沿用 registry 顺序，不重排。
  const providerIds = new Set<string>(Object.values(OFF_PEAK_PROVIDER_IDS));
  const providers = registry.providers.filter(
    (candidate) =>
      providerIds.has(candidate.providerId) && candidate.config.visibility === "hidden",
  );
// revision 原样透传：UI 依赖它判断视图是否过期，不能自增或改写。
  return Object.freeze({
    revision: registry.revision,
    providers: Object.freeze(providers.map(projectModelSelectionProviderView)),
  });
}
