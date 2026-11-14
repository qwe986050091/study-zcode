// 插件 UI 采样服务工厂：把宿主可选注入的采样能力包装成稳定的契约实现。
// 边界：本层只做缺失检测与转发，不校验参数、不缓存结果、不做重试。
// INV：sample 在宿主未实现时必须抛 unavailable，返回空样本会让插件误读为“无数据”。
// INV：cancelSampling 反向处理——未实现时回 cancelled:false，取消是幂等且允许失败的。
import type { IPluginUiSamplingService } from "./samplingContract.js";
import { PluginUiBridgeError } from "./pluginUiBridgeService.js";

export function createPluginUiSamplingService(
  dependencies: Partial<IPluginUiSamplingService> = {},
): IPluginUiSamplingService {
  return {
// 未注入时立即失败：静默降级会让插件误以为采样请求已被接受。
// 用 PluginUiBridgeError 而非普通 Error，保证上层能按错误码区分运行时能力缺失。
    async sample(params) {
      if (!dependencies.sample)
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI sampling is unavailable in this runtime",
        );
      return dependencies.sample(params);
    },
// 取消语义为尽力而为：未实现时返回 false，调用方据此决定是否回滚本地态。
    async cancelSampling(params) {
      if (!dependencies.cancelSampling) return { cancelled: false };
      return dependencies.cancelSampling(params);
    },
  };
}
