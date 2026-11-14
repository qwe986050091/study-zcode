// INV-01 纯格式化：守住位置 全部导出函数；改错故障：格式化过程改动入参或触发写操作。
// INV-02 诊断分流：守住位置 writeWarnings 过滤；改错故障：error 级诊断被当警告重复输出。
// INV-03 单行一诊断：守住位置 formatDiagnosticLines；改错故障：多条诊断挤在一行，解析器漏读。
// INV-04 可选段省略：守住位置 formatDiagnosticLine；改错故障：空路径或空插件留下多余括号空格。
// INV-05 空集早退：守住位置 列表格式化入口；改错故障：空列表仍输出表头，误导脚本计数。
// INV-06 计数一致：守住位置 各列表标题；改错故障：标题数字与条目数不符。
// INV-07 冗长开关：守住位置 verbose 分支；改错故障：默认输出被诊断段落淹没。
// INV-08 行尾换行：守住位置 返回值拼接；改错故障：末行缺换行，终端提示符与内容黏连。
// INV-09 来源回退：守住位置 formatMarketplaceSource；改错故障：未知来源被渲染成 undefined。
// INV-10 首个定位符：守住位置 locator 查找；改错故障：多定位字段拼出重复路径。
// INV-11 官方标记：守住位置 isOfficial 判断；改错故障：官方市场与第三方无法区分。
// INV-12 刷新失败可见：守住位置 refreshFailure 分支；改错故障：刷新错误被静默吞掉。
// INV-13 字段顺序：守住位置 formatPluginJson；改错故障：JSON 快照对比产生噪声差异。
// INV-14 诊断归属：守住位置 diagnostics 过滤；改错故障：所有诊断挂到每个插件上。
// INV-15 缺省不占位：守住位置 可选字段展开；改错故障：空字段以 undefined 写入 JSON。
// INV-16 断言边界：守住位置 marketplace source；改错故障：非 JSON 值进入序列化时抛错。
// INV-17 结果直译：守住位置 formatHumanPluginSet；改错故障：启用与停用文案与结果相反。
// INV-18 未知目标：守住位置 removed 为空分支；改错故障：未安装插件被报告成卸载成功。
//
// 模块职责：把插件命令结果渲染成人读文本与稳定 JSON 两种形态。
// 状态所有权：无状态；只读入参，不缓存、不写文件。
// 阅读顺序：诊断 → 人读列表 → 人读设置与卸载 → JSON 投影。
import { formatJson } from "@zcode/core";
import type { GlobalOptions, JsonValue, RunContext } from "@zcode/shared-types";
import type {
  SetZCodePluginEnabledResult,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodeMarketplaceSummaryData,
} from "@zcode/bootstrap";
import type { PluginDiagnostic, PluginListItem, PluginListOutcome } from "./plugins-command-shared.js";

// 只输出非 error 级诊断，error 交给调用方的失败路径。
// 目标固定 stderr，保证 stdout 的机器可读结果不被污染。
//
export function writeWarnings(ctx: RunContext, diagnostics: readonly PluginDiagnostic[]): void {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
  if (warnings.length > 0) ctx.stderr.write(formatDiagnosticLines(warnings));
}

// 每条诊断独占一行并以换行结尾。
// 调用方决定写 stdout 还是 stderr，formatDiagnosticLines 只负责拼接。
//
export function formatDiagnosticLines(diagnostics: readonly PluginDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${formatDiagnosticLine(diagnostic)}\n`).join("");
}

// pluginId 与 path 都可缺失，缺失时不留下空括号。
// 格式固定为 - [severity] pluginId code: message (path)。
// severity 原样输出不做本地化，保持脚本可匹配。
function formatDiagnosticLine(diagnostic: PluginDiagnostic): string {
  const location = diagnostic.path ? ` (${diagnostic.path})` : "";
  const plugin = diagnostic.pluginId ? ` ${diagnostic.pluginId}` : "";
  return `- [${diagnostic.severity}]${plugin} ${diagnostic.code}: ${diagnostic.message}${location}`;
}

// 空列表直接返回单行提示，不输出表头。
// 表头数字取插件总数，与下方条目一一对应。
// 每个插件固定三行：标识与开关、来源路径、能力计数。
// 诊断只在 verbose 下附带，默认不混入主列表。
export function formatHumanPluginList(outcome: PluginListOutcome, options: GlobalOptions): string {
  if (outcome.plugins.length === 0) return "No plugins found.\n";

  const lines = [`Plugins (${outcome.plugins.length})`];
  for (const plugin of outcome.plugins) {
    const hookDetails = plugin.hookDetails ?? [];
    const mcp = plugin.mcpServerNames.length > 0 ? plugin.mcpServerNames.join(", ") : "none";
    lines.push(`- ${plugin.id} [${plugin.enabled ? "enabled" : "disabled"}]`);
    lines.push(`  ${plugin.source}/${plugin.marketplace}: ${plugin.rootPath}`);
    lines.push(
      `  skills: ${plugin.skillCount}, commands: ${plugin.commandRootCount}, hooks: ${hookDetails.length}, mcp: ${mcp}`,
    );
  }

  if (options.verbose && outcome.diagnostics.length > 0) {
    lines.push("", `Diagnostics (${outcome.diagnostics.length})`);
    for (const diagnostic of outcome.diagnostics) lines.push(formatDiagnosticLine(diagnostic));
  }
  return `${lines.join("\n")}\n`;
}

// version 缺失时不留空格占位。
// 安装状态用 installed 与 not installed 固定词。
// description 缩进一行，缺省则整行省略。
export function formatHumanAvailableList(plugins: readonly ZCodeAvailablePluginData[]): string {
  if (plugins.length === 0) return "No plugins available from configured marketplaces.\n";
  const lines = [`Available plugins (${plugins.length})`];
  for (const plugin of plugins) {
    const version = plugin.version ? ` ${plugin.version}` : "";
    lines.push(`- ${plugin.id}${version} [${plugin.installed ? "installed" : "not installed"}]`);
    if (plugin.description) lines.push(`  ${plugin.description}`);
  }
  return `${lines.join("\n")}\n`;
}

// marketplaces 为空列表时同样早退。
// 官方市场追加 [official] 标记。
// 刷新失败单独一行，保留原始错误消息。
export function formatHumanMarketplaceList(
  marketplaces: readonly ZCodeMarketplaceSummaryData[],
): string {
  if (marketplaces.length === 0) return "No marketplaces configured.\n";
  const lines = [`Marketplaces (${marketplaces.length})`];
  for (const marketplace of marketplaces) {
    const official = marketplace.isOfficial ? " [official]" : "";
    lines.push(`- ${marketplace.id}${official}: ${marketplace.pluginCount} plugins`);
    lines.push(`  source: ${formatMarketplaceSource(marketplace.source)}`);
    if (marketplace.refreshFailure) {
      lines.push(`  last refresh failed: ${marketplace.refreshFailure.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// 类型字段非字符串时按 unknown 处理。
// 按 url、repo、path、package 的固定优先级取第一个字符串定位符。
// 没有 locator 时只输出 kind 类型名。
function formatMarketplaceSource(source: Record<string, unknown>): string {
  const kind = typeof source.source === "string" ? source.source : "unknown";
  const locator = ["url", "repo", "path", "package"]
    .map((key) => source[key])
    .find((value): value is string => typeof value === "string");
  return locator ? `${kind} ${locator}` : kind;
}

// 动词由 enabled 直接决定，不接受外部覆盖。
// 路径原样回显，不做相对化。
//
export function formatHumanPluginSet(result: SetZCodePluginEnabledResult): string {
  const verb = result.enabled ? "Enabled" : "Disabled";
  return `${verb} plugin ${result.plugin.id} in ${result.path}\n`;
}

// removed 为空表示目标未安装，据此输出失败提示。
// 成功时只报插件标识，不回显路径。
//
export function formatHumanPluginUninstall(
  removed: ZCodeInstalledPluginData | null,
  target: string,
): string {
  if (!removed) return `Plugin not installed: ${target}\n`;
  return `Uninstalled plugin ${removed.id}\n`;
}

export const formatPluginSetJson = (result: SetZCodePluginEnabledResult): string =>
  formatJson({
    enabled: result.enabled,
    path: result.path,
    plugin: formatPluginJson(result.plugin, []),
  });

/** 已加载插件的 JSON 形态；诊断按 pluginId 归到各自条目上，顶层不再有 cwd/diagnostics 包装。 */
// 字段顺序固定，便于快照对比。
// 诊断按 pluginId 过滤，只挂到所属插件。
// hook 明细统一走 formatHookDetailJson。
export function formatPluginJson(
  plugin: PluginListItem,
  diagnostics: readonly PluginDiagnostic[],
) {
  return {
    commandRootCount: plugin.commandRootCount,
    dataPath: plugin.dataPath,
    enabled: plugin.enabled,
    id: plugin.id,
    manifestPath: plugin.manifestPath,
    marketplace: plugin.marketplace,
    declaredMcpServerNames: plugin.declaredMcpServerNames,
    mcpServerNames: plugin.mcpServerNames,
    hookDetails: (plugin.hookDetails ?? []).map(formatHookDetailJson),
    name: plugin.name,
    rootPath: plugin.rootPath,
    skillCount: plugin.skillCount,
    skillRootCount: plugin.skillRootCount,
    source: plugin.source,
    diagnostics: diagnostics
      .filter((diagnostic) => diagnostic.pluginId === plugin.id)
      .map(formatDiagnosticJson),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatAvailablePluginJson(plugin: ZCodeAvailablePluginData) {
  return {
    id: plugin.id,
    installed: plugin.installed,
    marketplace: plugin.marketplace,
    name: plugin.name,
    ...(plugin.componentTypes ? { componentTypes: plugin.componentTypes } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatInstalledPluginJson(plugin: ZCodeInstalledPluginData) {
  return {
    enabled: plugin.enabled,
    id: plugin.id,
    marketplace: plugin.marketplace,
    name: plugin.name,
    scope: plugin.scope,
    ...(plugin.componentTypes ? { componentTypes: plugin.componentTypes } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.installPath ? { installPath: plugin.installPath } : {}),
    ...(plugin.installedAt ? { installedAt: plugin.installedAt } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatMarketplaceJson(marketplace: ZCodeMarketplaceSummaryData) {
  return {
    id: marketplace.id,
    isOfficial: marketplace.isOfficial,
    name: marketplace.name,
    pluginCount: marketplace.pluginCount,
    // marketplace source 在 bootstrap 契约里是 Record<string, unknown>，实际总是 JSON 可序列化对象。
    source: marketplace.source as JsonValue,
    ...(marketplace.description ? { description: marketplace.description } : {}),
    ...(marketplace.lastUpdated ? { lastUpdated: marketplace.lastUpdated } : {}),
    ...(marketplace.refreshFailure ? { refreshFailure: marketplace.refreshFailure } : {}),
  };
}

function formatHookDetailJson(hook: PluginListItem["hookDetails"][number]) {
  return {
    command: hook.command,
    event: hook.event,
    runnable: hook.runnable,
    sourcePath: hook.sourcePath,
    type: hook.type,
    ...(hook.args ? { args: hook.args } : {}),
    ...(hook.async !== undefined ? { async: hook.async } : {}),
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
    ...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
    ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
  };
}

export function formatDiagnosticJson(diagnostic: PluginDiagnostic) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
  };
}
