// 插件 UI 桥接模块的公开出口：仅做 re-export，不在此处引入实现细节或副作用。
// INV：出口顺序与命名保持稳定，内部文件路径不作为对外契约的一部分。
// 改错后果：在此加入运行时代码会让所有引用该出口的调用方被动执行初始化。
export * from "./contract.js";
export * from "./samplingContract.js";
export { createPluginUiSamplingService } from "./pluginUiSamplingService.js";
// appTools 出口独立于 bridge 实现，调用方按需引入以避免拉入完整桥接服务。
export * from "./appToolsContract.js";
export {
  createPluginUiAppToolsService,
  type PluginUiAppToolsServiceDependencies,
} from "./pluginUiAppToolsService.js";
export {
  PluginUiBridgeError,
  createPluginUiBridgeService,
  type PluginUiBridgeServiceDependencies,
} from "./pluginUiBridgeService.js";
