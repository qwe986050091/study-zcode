// ============================================================
// 宿主内建 node_repl MCP server 的注册判定
// ============================================================
// 位置：create-app 在插件发现之后、内建 MCP server 最后合并之前调用。产物来自独立的
// `node-repl-host` seed 单元，Browser Use / Computer Use 只决定是否注入各自的领域 root。
// 不变量：没有启用任一官方能力、或宿主包缺席时返回空对象（不注册），绝不回退到插件包里的旧产物。

import type { McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "./official-plugin-definitions.js";

/** 内建 server 在 MCP 配置里的键名；宿主内建合并阶段按这个名字保留 identity，防同名劫持。 */
export const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";

/**
 * node_repl 是官方能力共用的宿主工具，不是任何插件 manifest 声明的 plugin MCP。产物由独立的
 * `node-repl-host` seed 单元携带（无 listing、不对用户露出）；Browser Use 与 Computer Use
 * 各自只贡献自己的 skill、docs 与 native 依赖 root。
 *
 * 输入是插件发现结果与工作目录；输出是可直接并入 MCP 配置的 server 映射（零个或一个键）。
 * 失败语义：任何前置不满足都返回 `{}`，调用方因此只是少一个 server，不会启动失败；不抛错。
 */
export function resolveBuiltInNodeReplMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const browserUsePackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  // 两个领域能力都没启用时无需宿主：node_repl 本身没有用户可见的入口。
  if (!browserUsePackage && !cuaPackage) return {};
  // 宿主自己不参与启用判断：它没有 skill、不对用户露出，缺失就意味着没有宿主可跑，
  // 必须安全地不注册，而不是回退到某个插件包里的旧产物。
  const hostPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  );
  if (!hostPackage) return {};

  // 宿主产物按固定 cwd 与 10 分钟超时装配；isolation=workspace 让 MCP 子进程与工作区同域，
  // protocolVersion 固定，避免随宿主版本漂移。
  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: {
      // 领域 root 各自注入，且只在对应能力启用时注入：宿主据此决定哪一半文档可用。
      ...(browserUsePackage ? { ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath } : {}),
      ...(cuaPackage ? { ZCODE_CUA_PLUGIN_ROOT: cuaPackage.rootPath } : {}),
    },
    rootPath: hostPackage.rootPath,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return {};
  return {
    [BUILT_IN_NODE_REPL_SERVER_NAME]: {
      ...nodeRepl,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
  };
}
