// TUI 启动期的语言解析：在 ZCodeApp 尚未创建时就要决定界面语言（如登录引导面板）。
// 因此这里直接读配置文件的 ui.locale，并叠加 CLI 覆盖与探测结果，而不用依赖 App 内部状态。
import { createConfig } from "@zcode/adapters/config";
import type { RuntimeConfigPatch } from "@zcode/contracts";
import { resolveLocale, type SupportedLocale } from "@zcode/i18n";
import type { GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

// 解析启动语言所需的输入。
type ResolveTuiStartupLocaleInput = {
  // 依赖注入点：env 与配置文件路径、skipUserConfig 都由此覆盖。
  deps: RunDependencies;
  // 全局选项；取 locale（显式覆盖）与 detectedLocale（系统探测结果）。
  options: GlobalOptions;
  // 项目级配置文件所在目录；决定 projectConfigPath 的解析基准。
  workingDirectory: string;
};

// 把 `--locale` 折成配置补丁；未指定时返回 undefined，表示不覆盖已持久化的值。
const localeCliOverrides = (locale: GlobalOptions["locale"]): RuntimeConfigPatch | undefined =>
  locale
    ? {
        ui: {
          locale,
        },
      }
    : undefined;

// 解析 TUI 启动时的界面语言。
// 输入：deps/options/workingDirectory，见 ResolveTuiStartupLocaleInput。
// 输出：必定返回受支持的 SupportedLocale —— 优先级为 CLI 覆盖 > 持久化配置 > detectedLocale > 默认语言。
// 副作用：只读配置文件（可能创建配置对象但不写盘）；无日志。
// 失败语义：配置文件损坏时由 createConfig 内部降级到默认值，本函数不额外抛错。
export function resolveTuiStartupLocale({
  deps,
  options,
  workingDirectory,
}: ResolveTuiStartupLocaleInput): SupportedLocale {
  const configResult = createConfig({
    cliOverrides: localeCliOverrides(options.locale),
    env: deps.env ?? process.env,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory,
  });

  // login-required startup renders local TUI panels before ZCodeApp
  // exists, so the CLI boundary must resolve persisted ui.locale itself.
  return resolveLocale(configResult.config.ui.locale, options.detectedLocale);
}
