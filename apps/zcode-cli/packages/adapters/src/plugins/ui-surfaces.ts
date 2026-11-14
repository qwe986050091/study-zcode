import type { PluginDiagnostic, PluginUiSurfaceDefinition } from "@zcode/contracts";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_UI_RESOURCE_SCHEME,
  readSurfaceId,
} from "@zcode/shared/mcp-apps";
import type { LoadedPlugin } from "./types.js";

/*
 * ============================================================
 * plugins / ui-surfaces.ts —— 清单 ui.surfaces 解析
 *
 * 定位：把 manifest.ui.surfaces[] 逐项校验为 PluginUiSurfaceDefinition；非法项只记
 * warning 诊断并丢弃，不影响其他面板和组件。
 *
 * 输入输出：输入 loaded 插件与已声明的 mcp server 名；输出合法面板数组，server 运行时
 * 名为 plugin:<manifestName>:<declaredServer>。
 *
 * 副作用：无文件/网络IO；仅向传入的 diagnostics 追加 plugin_manifest_invalid 警告。
 *
 * 失败语义：不抛错；ui 非对象/surfaces 非数组/重复 id/字段非法都降级为诊断+跳过。
 *
 * 不变量：server 必须存在于 declaredMcpServerNames；resourceUri 必须以 ui:// 开头且
 * 不超过 2048 字符；id 全局唯一。
 * ============================================================
 */

/**
 * 清单 `ui.surfaces[]` 解析。
 * 逐项校验：非法项丢弃并记 `plugin_manifest_invalid` 诊断，不影响其余面板与插件其它组件。
 * server 必须是清单 `mcpServers` 里声明的键，运行时名用 `plugin:${name}:${server}`（与 mcp.ts 同规则）。
 */
const SURFACE_TITLE_MAX_CHARS = 200;
const SURFACE_ICON_MAX_CHARS = 2048;
const SUPPORTED_AVAILABILITY = "session";

// 附加语义：ui 缺失/surfaces 非数组→空数组；重复 id 记 warning；icon 超长截断。
/**
 * 清单 `ui.surfaces[]` 解析。
 * 逐项校验：非法项丢弃并记 `plugin_manifest_invalid` 诊断，不影响其余面板与插件其它组件。
 * server 必须是清单 `mcpServers` 里声明的键，运行时名用 `plugin:${name}:${server}`（与 mcp.ts 同规则）。
 */
export function parsePluginUiSurfaces(input: {
  loaded: LoadedPlugin;
  declaredMcpServerNames: readonly string[];
  diagnostics: PluginDiagnostic[];
}): PluginUiSurfaceDefinition[] {
  const ui = input.loaded.manifest.ui;
  if (ui === undefined) return [];
  const invalid = (message: string): void => {
    input.diagnostics.push({
      code: "plugin_manifest_invalid",
      message: `Plugin ui.surfaces: ${message}`,
      path: input.loaded.manifestPath,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  };
  if (!isRecord(ui)) {
    invalid("`ui` must be an object");
    return [];
  }
  if (ui.surfaces === undefined) return [];
  if (!Array.isArray(ui.surfaces)) {
    invalid("`ui.surfaces` must be an array");
    return [];
  }
  const surfaces: PluginUiSurfaceDefinition[] = [];
  const seen = new Set<string>();
  ui.surfaces.forEach((raw, index) => {
    const surface = parseSurface(raw, input.declaredMcpServerNames, (message) =>
      invalid(`[${index}] ${message}`),
    );
    if (!surface) return;
    if (seen.has(surface.id)) {
      invalid(`[${index}] duplicate surface id "${surface.id}"`);
      return;
    }
    seen.add(surface.id);
    surfaces.push({
      ...surface,
      server: `plugin:${input.loaded.manifest.name}:${surface.declaredServer}`,
    });
  });
  return surfaces;
}

/**
 * 解析并校验单个 surface：id/title/server/resourceUri/availability 全部合格才返回，
 * 否则调用 invalid 记录原因并返回 null。icon 超长会被截断而非判失败。
 */
function parseSurface(
  raw: unknown,
  declaredMcpServerNames: readonly string[],
  invalid: (message: string) => void,
): PluginUiSurfaceDefinition | null {
  if (!isRecord(raw)) {
    invalid("entry must be an object");
    return null;
  }
  const id = readSurfaceId(raw.id);
  if (!id) {
    invalid("`id` must match [A-Za-z0-9][A-Za-z0-9_.-]* and be at most 128 chars");
    return null;
  }
  const title = readTitle(raw.title);
  if (!title) {
    invalid(`"${id}": \`title\` must be a non-empty string or a locale → string map`);
    return null;
  }
  const declaredServer = typeof raw.server === "string" ? raw.server.trim() : "";
  if (!declaredServer || !declaredMcpServerNames.includes(declaredServer)) {
    invalid(`"${id}": \`server\` must name a server declared in mcpServers`);
    return null;
  }
  const resourceUri = typeof raw.resourceUri === "string" ? raw.resourceUri.trim() : "";
  if (
    !resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME) ||
    resourceUri.length > MCP_APPS_RESOURCE_URI_MAX_CHARS
  ) {
    invalid(`"${id}": \`resourceUri\` must start with ui:// and be at most 2048 chars`);
    return null;
  }
  if (raw.availability !== SUPPORTED_AVAILABILITY) {
    invalid(`"${id}": \`availability\` must be "session"`);
    return null;
  }
  const icon =
    typeof raw.icon === "string" && raw.icon.trim().length > 0
      ? raw.icon.trim().slice(0, SURFACE_ICON_MAX_CHARS)
      : undefined;
  // 清单里的 widgetStateVisibility 已废弃，出现时按未知字段静默忽略。
  return {
    id,
    title,
    ...(icon ? { icon } : {}),
    server: "",
    declaredServer,
    resourceUri,
    availability: SUPPORTED_AVAILABILITY,
  };
}

/** 解析标题：字符串或 locale→string 映射（过滤空值、逐条截断）；空/非法返回 null。 */
function readTitle(value: unknown): PluginUiSurfaceDefinition["title"] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, SURFACE_TITLE_MAX_CHARS) : null;
  }
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(
    entries.map(([locale, text]) => [locale, text.trim().slice(0, SURFACE_TITLE_MAX_CHARS)]),
  );
}

/** 类型守卫：非数组普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
