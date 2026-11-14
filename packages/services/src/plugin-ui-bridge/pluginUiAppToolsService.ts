// Plugin UI app tools 的桥接服务：把 agent 侧的四条调用原样转交给注入的实现。
// 依赖全部可选，用于在 web 与远程等没有本地 UI 桥的运行时降级。
// 本文件不持有状态，创建出的对象在进程内可安全共享。
import type {
  IPluginUiAppToolsService,
  PluginUiAppToolAcceptedResult,
  PluginUiAppToolCallParams,
  PluginUiAppToolInstanceParams,
  PluginUiRegisterAppToolsParams,
  PluginUiRegisterAppToolsResult,
  PluginUiResolveAppToolCallParams,
} from "./appToolsContract.js";
import { PluginUiBridgeError } from "./pluginUiBridgeService.js";

/** 四条 agent 调用都是透传；缺省（web / 远程）时登记与认领抛 unavailable，注销静默。 */
// 四个可选回调分别对应登记、注销、认领与解析；缺省即代表该运行时不具备相应能力。
// 参数与返回值直接复用 appToolsContract，避免在这里再定义一层结构。
export interface PluginUiAppToolsServiceDependencies {
  registerAppToolsForUi?: (
    params: PluginUiRegisterAppToolsParams,
  ) => Promise<PluginUiRegisterAppToolsResult>;
  unregisterAppToolsForUi?: (params: PluginUiAppToolInstanceParams) => Promise<{ removed: number }>;
  claimAppToolCallForUi?: (
    params: PluginUiAppToolCallParams,
  ) => Promise<PluginUiAppToolAcceptedResult>;
  resolveAppToolCallForUi?: (
    params: PluginUiResolveAppToolCallParams,
  ) => Promise<PluginUiAppToolAcceptedResult>;
}

// 统一的能力缺失错误：与业务失败区分，调用方据此返回不可用而不是重试。
// 用惰性构造函数而不是常量，保证每次抛出的是独立 Error（栈信息不同）。
const unavailable = () =>
  new PluginUiBridgeError("unavailable", "Plugin UI app tools are unavailable in this runtime");

export function createPluginUiAppToolsService(
  dependencies: PluginUiAppToolsServiceDependencies = {},
): IPluginUiAppToolsService {
// 返回对象只做转发，不做参数校验或结果改写；校验责任在同层契约。
  return {
// 登记必须在 UI 侧存在实现，缺失时直接抛不可用，不能静默丢弃（否则工具不会出现在列表里）。
// 调用方传入的参数原样透传，包含实例标识与工具定义。
    async registerAppTools(params) {
      if (!dependencies.registerAppToolsForUi) throw unavailable();
      return dependencies.registerAppToolsForUi(params);
    },
// 注销是幂等清理路径：没有实现时返回 removed=0，而不是抛错中断退出流程。
    async unregisterAppTools(params) {
      if (!dependencies.unregisterAppToolsForUi) return { removed: 0 };
      return dependencies.unregisterAppToolsForUi(params);
    },
// 认领表示 UI 已接受该调用；缺失实现时同样视为不可用。
    async claimAppToolCall(params) {
      if (!dependencies.claimAppToolCallForUi) throw unavailable();
      return dependencies.claimAppToolCallForUi(params);
    },
// 解析回填结果；缺失实现时不可用，避免 agent 永久等待一个永远不会来的结果。
    async resolveAppToolCall(params) {
      if (!dependencies.resolveAppToolCallForUi) throw unavailable();
      return dependencies.resolveAppToolCallForUi(params);
    },
  };
}
