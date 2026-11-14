import type {
  CustomCommandRoot,
  HookEventName,
  HookMatcherConfig,
  McpServerConfig,
  PluginHookDetail,
  PluginManifest,
  PluginSource,
  SkillRoot,
} from "@zcode/contracts";

/*
 * ============================================================
 * plugins / types.ts —— 插件装载的内部类型定义
 *
 * 定位：候选（未装载）与已装载插件的形状，以及插件对外暴露组件的聚合结果。
 * 输入输出：纯类型，无运行逻辑。
 * 副作用：无。
 * 失败语义：无。
 * 不变量：LoadedPlugin.rootPath 是插件根绝对路径；id 已 canonical 化；components 中的
 * hooks 仅来自已通过校验的来源。
 * ============================================================
 */

export interface PluginCandidate {
  /** 未显式配置时是否默认启用（来自 marketplace 元数据）。 */
  defaultEnabled: boolean;
  /** 来源 marketplace 名。 */
  marketplace: string;
  /** 插件根目录绝对路径。 */
  rootPath: string;
  /** 来源类型（内置/本地/远程等）。 */
  source: PluginSource;
}

export interface LoadedPlugin {
  /** canonical 插件 id。 */
  id: string;
  /** 已校验的 manifest 内容。 */
  manifest: PluginManifest;
  /** manifest 文件绝对路径（诊断定位用）。 */
  manifestPath: string;
  /** 来源 marketplace 名。 */
  marketplace: string;
  /** 插件根绝对路径，所有组件路径都必须落在其中。 */
  rootPath: string;
  /** 来源类型。 */
  source: PluginSource;
}

export interface PluginComponents {
  /** 命令根目录列表（供 command loader 扫描）。 */
  commandRoots: CustomCommandRoot[];
  /** 事件名 → matcher 数组；仅来自合法 hook 源。 */
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  /** 逐条 hook 详情（含来源路径），供 describe 展示。 */
  hookDetails: PluginHookDetail[];
  /** server 名 → 已解析的 MCP 配置（可能含模板变量）。 */
  mcpServers: Record<string, McpServerConfig>;
  /** 技能文件数量（不是技能目录数）。 */
  skillCount: number;
  /** 技能根目录列表。 */
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  /** 取消信号；中止后抛 "Plugin operation cancelled"。 */
  signal?: AbortSignal;
}
