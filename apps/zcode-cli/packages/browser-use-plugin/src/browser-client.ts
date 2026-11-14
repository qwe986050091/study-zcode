/**
 * browser-use 官方插件的 Browser runtime 装配入口。
 *
 * 职责：从 node_repl 宿主注入的 globals 中取出浏览器控制桥，把 core 的 Browser runtime
 * 绑定到该桥的 transport 上，使插件内的 Browser 工具调用最终经由宿主的 broker 转发。
 * 输入：`input.globals`，由宿主在脚本/worker 启动时注入的符号键对象。
 * 输出：无返回值，只修改传入的 globals（写入 bridge 符号）。
 * 副作用：会向 globals 写入浏览器桥条目；不直接发起浏览器操作。
 * 失败语义：桥缺失时通过 `assertAvailable()` 抛出，调用方应视为「当前环境不支持 Browser」，
 * 不要退化成静默无操作，否则工具会表现为执行成功但没有任何实际效果。
 * 边界：本文件不实现 broker 协议、不加载 core 根 barrel，避免把 Agent/tool 模块打进插件产物。
 */

// 从 @zcode/core 根 barrel 导入会让 esbuild 追踪具有顶层副作用的 Agent/tool 模块，
// 把 Bash registry、subagent 和 runtime 一起打进官方插件。Browser 发布物只能依赖窄 subpath。
import { setupBrowserRuntime as setupCoreBrowserRuntime } from "@zcode/core/browser-client";
import { readNodeReplBrowserRuntimeBridge } from "@zcode/node-repl-host/runtime-bridge";

/**
 * 把 core 的 Browser runtime 装配到当前 node_repl 会话的浏览器桥上。
 *
 * 宿主必须保证 globals 里已经注入有效的桥；本函数会先校验可用性再装配，
 * 因此「未注入」和「已失效（kernel reset 后）」两种情况都会在装配前失败，
 * 而不是等到第一次真实浏览器调用时才暴露。
 */
export async function setupBrowserRuntime(input: {
  globals: Record<PropertyKey, unknown>;
}): Promise<void> {
  const bridge = readNodeReplBrowserRuntimeBridge(input.globals);
  // 提前失败：装配期就检查桥是否过期，避免把错误延后到用户第一次点击浏览器工具时。
  bridge.assertAvailable();
  setupCoreBrowserRuntime({
    globals: input.globals as Record<string, unknown>,
    transport: bridge,
    documentationRoot: bridge.documentationRoot,
    assertAvailable: bridge.assertAvailable,
  });
}
