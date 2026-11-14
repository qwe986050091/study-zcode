// `plugins/listUiSurfaces`：工作区级只读投影，
// 返回已启用插件清单 `ui.surfaces[]` 的合法条目。与 plugin-reference-catalog.ts 同因分文件：plugins.ts 已近门禁。
import {
  zcodePluginsListUiSurfacesParamsSchema,
  type ZCodePluginUiSurface,
  type ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type { PluginMetadata } from "@zcode/contracts";
import { resolveZCodePlugins } from "../plugins.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 把插件 metadata 的 `ui.surfaces[]` 摊平成协议条目。输入为只读插件快照，输出不含脚本/资源正文。
 * 禁用插件整段跳过（无运行时 MCP，入口不可用），但其 metadata 仍留给管理页展示；顺序保持发现顺序。
 */
export function listPluginUiSurfacesFromPlugins(
  plugins: readonly PluginMetadata[],
): ZCodePluginUiSurface[] {
  const surfaces: ZCodePluginUiSurface[] = [];
  for (const plugin of plugins) {
    // 禁用插件没有运行时 MCP，入口不可用；解析仍保留在 metadata 里供管理页展示。
    if (!plugin.enabled) continue;
    for (const surface of plugin.uiSurfaces ?? []) {
      surfaces.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        id: surface.id,
        title: surface.title,
        ...(surface.icon ? { icon: surface.icon } : {}),
        server: surface.server,
        resourceUri: surface.resourceUri,
        availability: surface.availability,
      });
    }
  }
  return surfaces;
}

/**
 * plugins/listUiSurfaces 协议入口：按 workspacePath 重新解析插件清单，返回工作区级只读投影。
 * 不读 session、不创建 runtime；解析失败由 resolveZCodePlugins 冒泡（不返回半份列表）。
 */
export async function listPluginUiSurfaces(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsListUiSurfacesResult> {
  const params = parseParams(zcodePluginsListUiSurfacesParamsSchema, rawParams);
  const outcome = resolveZCodePlugins({
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return { surfaces: listPluginUiSurfacesFromPlugins(outcome.plugins) };
}
