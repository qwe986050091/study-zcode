// ============================================================
// 插件能力 → AgentRuntimeConfig.runtimeFeatures
// ============================================================
// 插件发现完成后、构造 AgentRuntime 之前调用：只按官方插件的 enabled 状态决定注入哪些
// runtime 能力。Browser Use 贡献 BrowserControlPort 与文档根；CUA 只标记 computerUse。
// 两者都关闭时返回空对象，runtime 不额外注入任何东西。

import { join } from "node:path";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
} from "./official-plugin-definitions.js";

/** AgentRuntimeConfig 里 runtimeFeatures 的精确切片类型，避免调用方重复写 NonNullable。 */
export type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

/**
 * 把官方插件的启用状态折算成 runtimeFeatures；只返回开启的键，关闭的保持缺席。
 *
 * 依赖边界：本函数只读插件发现的 `plugins` 数组，不读 manifest 的 MCP 声明——node_repl 的
 * 注册由 built-in-node-repl.ts 单独判定。失败语义：没有匹配插件即 `{}`，不抛错。
 */
export function resolvePluginRuntimeFeatures(
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  const browserUsePlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePlugin && !cuaPlugin) {
    return {};
  }
  return {
    // Node REPL 已迁到真实 MCP server；这里仅启用 BrowserControlPort 注入，不再注册 core 裸 js*。
    ...(browserUsePlugin ? { browserUse: true } : {}),
    ...(browserUsePlugin
      ? { browserDocumentationRoot: join(browserUsePlugin.rootPath, "docs") }
      : {}),
    // CUA 与 Browser Use 共用同一个无状态 node_repl MCP server；这里只记录 CUA
    // SDK 是否需要由 bootstrap 注入 broker。不要设置 nodeRepl：那个字段会重新注册
    // 已迁移前的 core 裸 js 工具，导致 MCP 与 core 重复投影。
    ...(cuaPlugin ? { computerUse: true } : {}),
  };
}
