// File Config Adapter - Load and patch JSON configuration files

/*
 * ============================================================
 * config / file-config.adapter.ts —— JSON 配置文件读写与局部 patch
 *
 * 定位：唯一直接读写 config.json 的适配器：装配阶段 loadFileConfig 只读；设置页/插件
 * 管理通过 update* 系列做“读-改-原子写”，只触碰目标字段。
 *
 * 输入输出：loadFileConfig 返回 config/diagnostics/path/loaded；patch 函数返回实际写入
 * 值与路径；所有相对路径经 resolvePath 展开 ~。
 *
 * 副作用：写文件（临时文件 + rename 原子替换，0600 权限）；装载旧 CUA 插件 id 时会
 * best-effort 迁移回写磁盘。
 *
 * 失败语义：装载失败→diagnostics(code=config_file_invalid)+loaded=false，不抛；写失败
 * 抛 Unable to write；读文件 ENOENT 在 patch 路径视为空对象（首次写入）。
 *
 * 不变量：任何 patch 都必须保留无关键；写回必须原子；plugin id 统一 canonical 化。
 * patch 路径写前清掉所有 alias 键；enablePluginsByDefaultInFileConfig 按 id 合并，不清 alias。
 * ============================================================
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeConfigPatch, UiLocale } from "@zcode/contracts";
import { z } from "zod";
import {
  CANONICAL_CUA_PLUGIN_ID,
  canonicalizePluginId,
  LEGACY_CUA_PLUGIN_ID,
  parseConfigFileToRuntimePatchWithDiagnostics,
  pluginIdAliases,
  type ConfigDiagnostic,
} from "./schema.js";

interface FileConfigOptions {
  /** 无显式 filePath 时的基准目录，默认 ~/.zcode/cli。 */
  baseDir?: string;
  /** 无显式 filePath 时的文件名，默认 config.json。 */
  configFileName?: string;
}

export interface LoadedConfig {
  /** 解析出的补丁；loaded=false 时为空对象。 */
  config: RuntimeConfigPatch;
  /** 结构/类型问题诊断，已回填 filePath。 */
  diagnostics: ConfigDiagnostic[];
  /** 解析后的绝对路径（即使文件不存在也会给出）。 */
  path: string;
  /** 是否成功读取并解析；false 不代表“无文件”，也可能是损坏。 */
  loaded: boolean;
}

export interface UiLocalePatchResult {
  /** 写入的语言值。 */
  locale: UiLocale;
  /** 实际写入的绝对路径。 */
  path: string;
}

export interface PluginEnabledPatchResult {
  /** 写入后的启用状态。 */
  enabled: boolean;
  /** 实际写入的绝对路径。 */
  path: string;
  /** 调用方传入的 pluginId（原样返回，非 canonical）。 */
  pluginId: string;
}

export interface PluginOptionsPatchResult {
  /** 本次被显式清除的 option key 列表。 */
  clearedOptionKeys: string[];
  /** 本次写入的 option 值（不含保留的旧值）。 */
  options: Record<string, string | number | boolean>;
  /** 实际写入的绝对路径。 */
  path: string;
  /** 调用方传入的 pluginId。 */
  pluginId: string;
}

export interface PluginRemovePatchResult {
  /** 实际写入的绝对路径（未变更时也返回）。 */
  path: string;
  /** 调用方传入的 pluginId。 */
  pluginId: string;
  /** 是否真的删除了 enabledPlugins 条目。 */
  removedEnabled: boolean;
  /** 是否真的删除了 options 条目。 */
  removedOptions: boolean;
}

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_BASE_DIR = "~/.zcode/cli";

/** 展开 `~/` 为 home 并 resolve 成绝对路径；不接受 `~user` 形式。 */
/**
 * Resolve path with ~ expansion
 */
export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * 从 JSON 文件装载配置（同步，供启动装配使用）。
 *
 * 文件不存在→loaded=false、无诊断；读取/解析/schema 校验失败→loaded=false 且带 error
 * 诊断，绝不抛出。成功时会先做 legacy CUA 插件 id 迁移并 best-effort 回写。
 */
/**
 * Load configuration from a JSON file
 */
export function loadFileConfig(filePath?: string, options: FileConfigOptions = {}): LoadedConfig {
  const resolvedPath = filePath
    ? resolvePath(filePath)
    : join(
        resolvePath(options.baseDir ?? DEFAULT_BASE_DIR),
        options.configFileName ?? DEFAULT_CONFIG_FILE,
      );

  if (!existsSync(resolvedPath)) {
    return {
      config: {},
      diagnostics: [],
      path: resolvedPath,
      loaded: false,
    };
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content);
    const migrated = migratePluginConfigInFile(parsed);
    if (migrated) {
      // 仅装载态归一化会让旧 key 永久留在磁盘，后续版本无法安全删除迁移逻辑。
      persistPluginConfigMigration(resolvedPath, migrated);
    }
    const result = parseConfigFileToRuntimePatchWithDiagnostics(parsed);

    return {
      config: result.config,
      diagnostics: attachDiagnosticFilePath(result.diagnostics, resolvedPath),
      path: resolvedPath,
      loaded: true,
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [createConfigFileInvalidDiagnostic(error, resolvedPath)],
      path: resolvedPath,
      loaded: false,
    };
  }
}

/**
 * 把旧 CUA 插件 id 迁移为 canonical id（enabledPlugins/suppressedBuiltins/options 三处）。
 *
 * 返回修改后的完整对象；无需迁移返回 undefined。仅在 canonical 键缺失时复制旧值，
 * 避免覆盖用户已写的新 id。
 */
function migratePluginConfigInFile(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.plugins)) return undefined;
  const plugins = value.plugins;
  const nextPlugins = { ...plugins };
  let changed = false;

  if (isRecord(plugins.enabledPlugins)) {
    const enabledPlugins = { ...plugins.enabledPlugins };
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (enabledPlugins[canonicalId] === undefined) enabledPlugins[canonicalId] = enabled;
        delete enabledPlugins[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.enabledPlugins = enabledPlugins;
  }

  if (Array.isArray(plugins.suppressedBuiltins)) {
    const suppressedBuiltins = plugins.suppressedBuiltins.map((id) =>
      id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id,
    );
    if (JSON.stringify(suppressedBuiltins) !== JSON.stringify(plugins.suppressedBuiltins)) {
      nextPlugins.suppressedBuiltins = suppressedBuiltins;
      changed = true;
    }
  }

  if (isRecord(plugins.options)) {
    const options = { ...plugins.options };
    for (const [id, pluginOptions] of Object.entries(plugins.options)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (options[canonicalId] === undefined) options[canonicalId] = pluginOptions;
        delete options[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.options = options;
  }

  return changed ? { ...value, plugins: nextPlugins } : undefined;
}

/**
 * best-effort 把迁移结果写回磁盘（临时文件 0600 + rename 原子替换）。
 *
 * 这是“装载合法配置”的附带副作用：写入失败只清理临时文件，绝不改变装载结果或抛错。
 */
function persistPluginConfigMigration(
  filePath: string,
  value: Record<string, unknown>,
): void {
  const tempPath = `${filePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch {
    // 迁移写回是 best-effort 副作用，失败不能改变合法配置的装载语义。
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不影响当前配置装载。
    }
  }
}

/** 构造统一的 config_file_invalid 诊断：Zod 错误格式化为 `path: message` 列表。 */
function createConfigFileInvalidDiagnostic(error: unknown, filePath: string): ConfigDiagnostic {
  return {
    code: "config_file_invalid",
    filePath,
    message:
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Unable to parse config file.",
    severity: "error",
  };
}

/** 给没有 filePath 的诊断补上来源文件；已有 filePath 的保持原值。 */
function attachDiagnosticFilePath(
  diagnostics: ConfigDiagnostic[],
  filePath: string,
): ConfigDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    filePath: diagnostic.filePath ?? filePath,
  }));
}

/** 把 ZodError 压成一行可读文本；空 path 用 <config> 占位。 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<config>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * 只修改 ui.locale 并原子写回；保留文件其余所有键。
 *
 * 文件不存在按空对象处理（首次写配置）；JSON 损坏/非对象同样按空对象处理后覆盖写入，
 * 这是设置页的“用户显式保存”语义。
 */
/**
 * Patch only the UI locale selection in a JSON config file.
 */
export async function updateUiLocaleInFileConfig(
  filePath: string,
  locale: UiLocale,
): Promise<UiLocalePatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchUiLocale(parsed, locale);

  await atomicWriteJson(resolvedPath, next);
  return {
    locale,
    path: resolvedPath,
  };
}

/**
 * 只修改 plugins.enabledPlugins[id]（canonical id），不触碰安装态与 options。
 *
 * 写入前删除该插件的所有 alias 键，保证新旧 id 不会同时存在（alias 集由 schema 定义）。
 */
/**
 * Patch the user plugin enabled map without touching plugin installation state.
 */
export async function updatePluginEnabledInFileConfig(
  filePath: string,
  pluginId: string,
  enabled: boolean,
): Promise<PluginEnabledPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchPluginEnabled(parsed, pluginId, enabled);

  await atomicWriteJson(resolvedPath, next);
  return {
    enabled,
    path: resolvedPath,
    pluginId,
  };
}

/**
 * Mark freshly installed plugins as enabled by default, in a single atomic write.
 *
 * 设计：安装即默认启用（仅对本次安装的插件 + 其依赖闭包生效）。这里只对**用户配置里尚未显式声明**
 * 的 id 写入 `true`——若用户先前显式停用过（例如停用后重装），尊重其选择不覆盖；已是 true 的也跳过。
 * 一次性读改写，避免逐个 id 反复读写配置文件。返回真正被新置为启用的 id 列表，便于上层据此决定是否回写。
 */
export async function enablePluginsByDefaultInFileConfig(
  filePath: string,
  pluginIds: readonly string[],
): Promise<{ enabledIds: string[]; path: string }> {
  const resolvedPath = resolvePath(filePath);
  if (pluginIds.length === 0) {
    return { enabledIds: [], path: resolvedPath };
  }
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const enabledIds = pluginIds.filter(
    (id) => !Object.prototype.hasOwnProperty.call(enabledPlugins, id),
  );
  if (enabledIds.length === 0) {
    return { enabledIds: [], path: resolvedPath };
  }
  const next = {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: {
        ...enabledPlugins,
        ...Object.fromEntries(enabledIds.map((id) => [id, true])),
      },
    },
  };
  await atomicWriteJson(resolvedPath, next);
  return { enabledIds, path: resolvedPath };
}

/**
 * 合并写入插件 options：先删 clearOptionKeys，再 merge 本次输入，保留未提及的旧键。
 *
 * 敏感 option 不会回传 UI，二次保存普通字段时请求里天然缺 secret；按 key 合并可避免
 * 整对象替换把已存密钥静默清空。只影响 options，不改 enabled 状态。
 */
/**
 * Patch plugin user options without touching plugin installation state.
 */
export async function updatePluginOptionsInFileConfig(
  filePath: string,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[] = [],
): Promise<PluginOptionsPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchPluginOptions(parsed, pluginId, options, clearOptionKeys);

  await atomicWriteJson(resolvedPath, next);
  return {
    clearedOptionKeys: clearOptionKeys,
    options,
    path: resolvedPath,
    pluginId,
  };
}

/**
 * Remove a plugin's user config footprint when it is uninstalled.
 *
 * Uninstall is a thorough teardown, so it
 * must drop both the `plugins.enabledPlugins[id]` flag and any saved
 * `plugins.options[id]`. updatePluginEnabledInFileConfig/...Options can only set
 * values; deleting the keys needs its own patch so a reinstall starts clean.
 */
export async function removePluginFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<PluginRemovePatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const { next, removedEnabled, removedOptions } = patchPluginRemoved(parsed, pluginId);

  if (removedEnabled || removedOptions) {
    await atomicWriteJson(resolvedPath, next);
  }
  return {
    path: resolvedPath,
    pluginId,
    removedEnabled,
    removedOptions,
  };
}

/**
 * 只删除 Plugin 的启用覆盖并保留 options。
 *
 * Workspace“恢复继承”是配置视图操作，只应删除 Workspace 的启用覆盖，不能误删
 * 单独保存的 Workspace options 或 secret。
 */
/**
 * 只删除 Plugin 的启用覆盖并保留 options（Workspace“恢复继承”语义）。
 *
 * 这是配置视图操作，不能误删单独保存的 Workspace options 或 secret。
 */
export async function removePluginEnabledFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<{ path: string; pluginId: string; removedEnabled: boolean }> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) =>
    Object.prototype.hasOwnProperty.call(enabledPlugins, id),
  );
  if (!removedEnabled) {
    return { path: resolvedPath, pluginId, removedEnabled: false };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  await atomicWriteJson(resolvedPath, {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: nextEnabled,
    },
  });
  return { path: resolvedPath, pluginId, removedEnabled: true };
}

/** suppressedBuiltins 写入/移除的结果：path 与实际条目状态。 */
export interface SuppressedBuiltinPatchResult {
  path: string;
  pluginId: string;
  suppressed: boolean;
}

/**
 * Persist that a built-in (official) plugin is uninstalled, so seeding skips it
 * across restarts and app upgrades. Idempotent. Stored in user config beside
 * enabledPlugins so it survives bundle re-seeds.
 */
export async function addSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const current = Array.isArray(plugins.suppressedBuiltins)
    ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const retained = current.filter((id) => !aliases.includes(id));
  if (retained.length === current.length && current.includes(canonicalPluginId)) {
    return { path: resolvedPath, pluginId, suppressed: true };
  }
  const next = {
    ...parsed,
    plugins: { ...plugins, suppressedBuiltins: [...retained, canonicalPluginId] },
  };
  await atomicWriteJson(resolvedPath, next);
  return { path: resolvedPath, pluginId, suppressed: true };
}

/**
 * Reverse of addSuppressedBuiltinInFileConfig: restore a built-in by dropping its
 * suppression marker. The seeder re-materializes it on the next resolve.
 */
export async function removeSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const aliases = pluginIdAliases(pluginId);
  const current = Array.isArray(plugins.suppressedBuiltins)
    ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const nextSuppressedBuiltins = current.filter((id) => !aliases.includes(id));
  if (nextSuppressedBuiltins.length === current.length) {
    return { path: resolvedPath, pluginId, suppressed: false };
  }
  const next = {
    ...parsed,
    plugins: { ...plugins, suppressedBuiltins: nextSuppressedBuiltins },
  };
  await atomicWriteJson(resolvedPath, next);
  return { path: resolvedPath, pluginId, suppressed: false };
}

/** 默认配置文件路径：~/.zcode/cli/config.json（已展开为绝对路径）。 */
/**
 * Get default config file path
 */
export function getDefaultConfigPath(): string {
  return join(resolvePath(DEFAULT_BASE_DIR), DEFAULT_CONFIG_FILE);
}

/** 判断默认位置是否存在配置文件（只做 existsSync，不校验内容）。 */
/**
 * Check if config file exists at default location
 */
export function hasDefaultConfigFile(): boolean {
  return existsSync(getDefaultConfigPath());
}

/**
 * 严格读取配置文件对象：读失败/JSON 非法/顶层非对象一律抛错（不静默降级）。
 * 用于用户显式写操作的“读取现状”阶段。
 */
async function readJsonConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Unable to parse config file as JSON: ${filePath}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }

  return parsed;
}

/** 仅把 ENOENT 视为“空配置”（首次写入），其他错误继续抛出，避免掩盖权限/损坏问题。 */
async function readJsonConfigFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readJsonConfigFile(filePath);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/** 只替换 ui.locale，保留 ui 下其他键。 */
function patchUiLocale(parsed: Record<string, unknown>, locale: UiLocale): Record<string, unknown> {
  const currentUi = isRecord(parsed.ui) ? parsed.ui : {};

  return {
    ...parsed,
    ui: {
      ...currentUi,
      locale,
    },
  };
}

/**
 * 写入 canonical id 的启用状态，并删除其全部 alias 键。
 * 旧 id 残留会让“后写者胜出”的解析产生歧义。
 */
function patchPluginEnabled(
  parsed: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const nextEnabledPlugins = { ...enabledPlugins };
  for (const id of pluginIdAliases(canonicalPluginId)) delete nextEnabledPlugins[id];

  return {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: {
        ...nextEnabledPlugins,
        [canonicalPluginId]: enabled,
      },
    },
  };
}

/**
 * 计算 options 的下一版：以 canonical/legacy 中现有值为基线，先删 clearOptionKeys，
 * 再 merge 新值，并清掉所有 alias 键。仅替换该插件的 options 子树，其他插件不动。
 */
function patchPluginOptions(
  parsed: Record<string, unknown>,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[],
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const currentOptions = isRecord(plugins.options) ? plugins.options : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const legacyPluginId = aliases.length > 1 ? aliases[1] : undefined;
  const currentPluginOptions = isRecord(currentOptions[canonicalPluginId])
    ? currentOptions[canonicalPluginId]
    : legacyPluginId && isRecord(currentOptions[legacyPluginId])
      ? currentOptions[legacyPluginId]
      : {};
  const nextOptions = { ...currentOptions };
  for (const id of aliases) delete nextOptions[id];
  const clearedOptionKeySet = new Set(clearOptionKeys);
  const retainedPluginOptions = Object.fromEntries(
    Object.entries(currentPluginOptions).filter(([key]) => !clearedOptionKeySet.has(key)),
  );

  return {
    ...parsed,
    plugins: {
      ...plugins,
      options: {
        ...nextOptions,
        // 敏感字段按脱敏合同不会回传 UI，二次保存普通字段时请求中自然缺少
        // 已存 secret。这里按 option key 合并，避免整对象替换把同 scope 的密钥静默清空。
        // 显式清除走 clearOptionKeys，先删除指定键，再合并本次输入；不会连带删除启用状态
        // 或同插件的其他配置。
        [canonicalPluginId]: {
          ...retainedPluginOptions,
          ...options,
        },
      },
    },
  };
}

/**
 * 卸载语义的彻底删除：同时清 enabledPlugins 与 options（含所有 alias）。
 * 与“停用”不同——重装后不会继承旧配置。
 */
function patchPluginRemoved(
  parsed: Record<string, unknown>,
  pluginId: string,
): { next: Record<string, unknown>; removedEnabled: boolean; removedOptions: boolean } {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) => id in enabledPlugins);
  const removedOptions = aliases.some((id) => id in options);
  if (!removedEnabled && !removedOptions) {
    return { next: parsed, removedEnabled, removedOptions };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  const nextOptions = { ...options };
  for (const id of aliases) delete nextOptions[id];

  return {
    next: {
      ...parsed,
      plugins: {
        ...plugins,
        enabledPlugins: nextEnabled,
        options: nextOptions,
      },
    },
    removedEnabled,
    removedOptions,
  };
}

/**
 * 原子写 JSON：mkdir -p → 写同目录唯一临时文件（0600）→ rename 覆盖目标。
 *
 * 失败时尽力删除临时文件并抛出带 cause 的错误；rename 同目录保证跨进程读者看不到半写
 * 文件（Windows 下 rename 覆盖语义也成立）。
 */
async function atomicWriteJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Unable to write config file: ${filePath}`, { cause: error });
  }
}

/** 类型守卫：非数组普通对象，用于安全展开 config 的嵌套字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断是否带 code 的 Node 错误（ENOENT 等）；用于 patch 读文件的空配置降级判断。 */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
