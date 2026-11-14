import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HookEventName, PluginDiagnostic } from "@zcode/contracts";
import { HookEventName as HookEventNameValue } from "@zcode/contracts";
import { fileExists, isRecord, resolveInside } from "./helpers.js";
import type { LoadedPlugin } from "./types.js";

/*
 * ============================================================
 * plugins / hook-sources.ts —— 插件 hooks 来源发现
 *
 * 定位：统一从 `hooks/hooks.json` 与 manifest.hooks（字符串路径/内联对象/数组）收集
 * hook 源，供 describe 枚举和真实 loader 共用，避免两处读取口径漂移。
 *
 * 输入输出：listPluginHookSources 返回 {rawHooks, sourcePath, wrapper}；wrapper=true
 * 表示来自 hooks.json（需要再取 .hooks 子对象）。listPluginHookEventNames 只返回事件名。
 *
 * 副作用：只读文件；不创建可执行 hook，不写盘。
 *
 * 失败语义：路径逃逸/文件缺失/JSON 解析失败→error 诊断并跳过；重复文件→warning 跳过；
 * 不支持的事件名→warning。函数本身不抛错。
 *
 * 不变量：所有路径都必须经 resolveInside；每个真实文件最多处理一次（realpath 去重）。
 * ============================================================
 */

export const STANDARD_HOOKS_PATH = join("hooks", "hooks.json");

const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

export interface PluginHookSource {
  /** 原始 hooks 内容；wrapper=true 时为整个 JSON 文档，否则为 manifest 内联对象。 */
  rawHooks: unknown;
  /** 来源文件路径（内联对象为 manifestPath）。 */
  sourcePath: string;
  /** true=来自 hooks.json（形如 {hooks:{...}}）；false=manifest 内联。 */
  wrapper: boolean;
}

/** 先列 hooks/hooks.json，再按 manifest.hooks 顺序补充；同名/同 realpath 去重。 */
/**
 * 统一发现插件 hook 来源文件，避免详情枚举和真实 loader 对 `hooks/hooks.json`
 * 与 `manifest.hooks` 的读取口径漂移。
 */
export function listPluginHookSources(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): PluginHookSource[] {
  const sources: PluginHookSource[] = [];
  const loadedHookPaths = new Set<string>();
  const standardHooksPath = join(input.loaded.rootPath, STANDARD_HOOKS_PATH);

  if (fileExists(standardHooksPath)) {
    const source = loadPluginHookSource({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      path: standardHooksPath,
    });
    if (source) {
      sources.push(source);
      loadedHookPaths.add(realpathOrSelf(standardHooksPath));
    }
  }

  const manifestHooks = input.loaded.manifest.hooks;
  // undefined 表示根本没声明 hooks；空数组也要走下面的分支（结果相同）。
  if (manifestHooks === undefined) return sources;
  const hookSpecs = Array.isArray(manifestHooks) ? manifestHooks : [manifestHooks];

  for (const hookSpec of hookSpecs) {
    if (typeof hookSpec === "string") {
      const hookFilePath = resolveInside(input.loaded.rootPath, hookSpec);
      // 路径逃逸属于安全边界问题：必须报 error，不能降级为“文件不存在”。
      if (!hookFilePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin hooks path escapes plugin root: ${hookSpec}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (!fileExists(hookFilePath)) {
        input.diagnostics.push({
          code: "plugin_hook_read_failed",
          message: `Plugin hooks file not found: ${hookSpec}`,
          path: hookFilePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }

      const realPath = realpathOrSelf(hookFilePath);
      if (loadedHookPaths.has(realPath)) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Duplicate plugin hooks file ignored: ${hookSpec}`,
          path: hookFilePath,
          pluginId: input.loaded.id,
          severity: "warning",
        });
        continue;
      }

      const source = loadPluginHookSource({
        diagnostics: input.diagnostics,
        loaded: input.loaded,
        path: hookFilePath,
      });
      if (source) {
        sources.push(source);
        loadedHookPaths.add(realPath);
      }
      continue;
    }

    sources.push({
      rawHooks: hookSpec,
      sourcePath: input.loaded.manifestPath,
      wrapper: false,
    });
  }

  return sources;
}

/** 只抽取 hook 事件名，供 `plugins/describe` 展示；不会构造可执行 hook。 */
export function listPluginHookEventNames(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): HookEventName[] {
  const eventNames: HookEventName[] = [];
  const seen = new Set<string>();
  for (const source of listPluginHookSources(input)) {
    const hooksRoot = source.wrapper
      ? isRecord(source.rawHooks)
        ? source.rawHooks.hooks
        : undefined
      : source.rawHooks;
    // 两种来源形状不同：wrapper 要求 {hooks:{...}}，内联必须直接是对象。
    if (!isRecord(hooksRoot)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: source.wrapper
          ? "Plugin hooks file must contain a hooks object"
          : "Plugin manifest hooks entry must be an object, a path, or an array",
        path: source.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    for (const eventName of Object.keys(hooksRoot)) {
      if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
        input.diagnostics.push({
          code: "plugin_hook_unsupported_event",
          message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
          path: source.sourcePath,
          pluginId: input.loaded.id,
          severity: "warning",
        });
        continue;
      }
      if (seen.has(eventName)) continue;
      seen.add(eventName);
      eventNames.push(eventName as HookEventName);
    }
  }
  return eventNames;
}

/** 读取并解析单个 hooks.json；解析失败生成 error 诊断并返回 null，不抛错。 */
function loadPluginHookSource(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  path: string;
}): PluginHookSource | null {
  try {
    return {
      rawHooks: JSON.parse(readFileSync(input.path, "utf8")) as unknown,
      sourcePath: input.path,
      wrapper: true,
    };
  } catch (error) {
    input.diagnostics.push({
      code: "plugin_hook_read_failed",
      message: error instanceof Error ? error.message : `Failed to read plugin hooks: ${input.path}`,
      path: input.path,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return null;
  }
}

/** realpath 失败（如文件消失）时退回原路径，仅用于去重键，不影响后续读取。 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
