/**
 * office-runtime 对外契约：内置文档插件（documents / pdf / presentations / spreadsheets）如何声明
 * 查看面板，以及在插件根目录运行 `node ../office-runtime/scripts/build.mjs` 后保证产出什么。
 * 面板与 MCP 工具的运行时契约见 src/contract.ts 与 src/CONTRACT.md。
 */
import type { DocKind } from "#office/contract.ts";

export type { DocKind };

/** 插件包 package.json 的 "office" 字段：面板标题与该插件打开的格式。 */
export interface OfficePluginConfig {
  title: { en: string; "zh-CN": string };
  kinds: readonly DocKind[];
}

/**
 * 构建后在插件根目录下必定存在的产物。官方 seed、SEA、桌面打包与远端资产都把它们当作必需资产，
 * 缺任一项即视为残缺插件。
 */
export const OFFICE_RUNTIME_OUTPUTS = [
  "dist/server.mjs",
  "dist/ui/assets.json",
  "dist/ui/panel.html",
] as const;

// 插件构建契约：把 package.json 的面板声明与构建产物清单合成一个可校验对象，
// 供 seed、SEA、桌面打包与远端资产在加载插件前确认完整性；缺失产物即视为不可用插件。
export interface OfficeRuntimeContract {
  /** 插件声明的面板配置；插件名取自其 .zcode-plugin/plugin.json，决定 MCP 服务与 ui:// 资源地址。 */
  config: OfficePluginConfig;
  /** 构建保证产出的文件，相对插件根目录。 */
  outputs: typeof OFFICE_RUNTIME_OUTPUTS;
}
