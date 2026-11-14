// CLI 无头浏览器运行时装配：只有 `--browser-use=headless` 时才创建受管 CDP 浏览器运行时，
// 其它取值（含未指定）一律不创建，避免为不需要浏览器的会话无谓拉起浏览器进程。
import {
  createManagedCdpBrowserRuntime,
  type ManagedCdpBrowserRuntime,
} from "@zcode/adapters/browser";
import type { GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { loadCliPlaywrightChromium } from "./sea-playwright-runtime.js";

// 依据全局选项创建无头浏览器运行时。
// 输入：options.browserUse 决定是否启用（仅 "headless" 生效）；browserExecutable 为可选的自定义浏览器可执行文件路径。
// 输出：启用时返回 ManagedCdpBrowserRuntime；未启用返回 undefined，语义是"本次运行不提供浏览器能力"而非失败。
// 副作用：构造阶段不启动进程，真正拉起发生在首次导航；工厂内部可能读取 env 中的浏览器配置。
// 可测性/降级：deps.createManagedCdpBrowserRuntime 可覆盖默认工厂；loadPlaywright 固定为 CLI 自带加载器以支持 SEA 形态。
export function createCliHeadlessBrowserRuntime(
  options: Pick<GlobalOptions, "browserExecutable" | "browserUse">,
  deps: RunDependencies,
): ManagedCdpBrowserRuntime | undefined {
  // 非 headless（含 undefined）直接返回空值，调用方据此走纯文本工具路径，无需再做二次判断。
  if (options.browserUse !== "headless") return undefined;
  const factory = deps.createManagedCdpBrowserRuntime ?? createManagedCdpBrowserRuntime;
  return factory({
    env: deps.env,
    executablePath: options.browserExecutable,
    loadPlaywright: loadCliPlaywrightChromium,
  });
}
