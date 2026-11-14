import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

/*
 * ============================================================
 * plugins / official-marketplace.ts —— 官方市场分片持久化与合并
 *
 * 定位：内置（bundled）与 CDN 两个目录分片各自落盘，再合并成 marketplace.json，
 * 避免启动 seed 与 CDN 刷新互相覆盖。
 *
 * 输入输出：write* 输入 manifest+storageRoot，返回合并后的 marketplace 对象；
 * loadBundledOfficialPluginRootsSync 返回内置插件的缓存路径列表（越界项被丢弃）。
 *
 * 副作用：mkdir/writeFileSync 写 <storageRoot>/marketplaces/<official>/；同内容写入被跳过。
 *
 * 失败语义：manifest.name 非官方名→抛错（不写盘）；读取分片 JSON 失败→视为缺失；
 * 路径不是官方缓存根的安全后代→该插件被静默排除。
 *
 * 不变量：合并结果 name 恒为官方市场名；同名插件 CDN 优先，但只影响合并视图，
 * 不删除内置缓存。
 * ============================================================
 */

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  /** 内置市场 manifest 原文。 */
  manifest: Record<string, unknown>;
  /** 分片格式版本；目前只接受 1。 */
  version: 1;
}

/**
 * 写入内置目录分片并重建合并目录，返回合并后的 marketplace。
 *
 * manifest 必须声明官方市场名，否则在写盘前抛错；副作用是覆盖分片与合并文件。
 */
export function writeBundledOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

/**
 * 写入 CDN 目录分片（直接存 manifest）并重建合并目录。
 * 与内置分片独立持久化，因此刷新 CDN 不会覆盖 bundled 条目。
 */
export function writeCdnOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

/**
 * 读取内置分片并返回可用插件缓存根目录（未发现分片时 undefined）。
 *
 * 每个 cachePath 必须是 officialCacheRoot/<name> 的严格后代，否则丢弃——防止恶意
 * manifest 借 cachePath 指向插件缓存之外的任意路径。
 */
export function loadBundledOfficialPluginRootsSync(
  storageRoot: string,
): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(
    storageRoot,
    "cache",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  );
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

/**
 * 重建合并目录：CDN 条目在前、bundled 同名条目被过滤，写回 marketplace.json。
 *
 * 只合并展示目录，不删除任何缓存；分片缺失时按空处理，返回仍有合法 name 的对象。
 */
function rebuildOfficialMarketplaceSync(storageRoot: string): Record<string, unknown> {
  const bundledPartition = readBundledPartition(storageRoot);
  const cdnManifest = readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const cdnPlugins = readPluginEntries(cdnManifest);
  const cdnPluginNames = new Set(cdnPlugins.map(readPluginName).filter(isDefined));
  const bundledPlugins = readPluginEntries(bundledManifest).filter((plugin) => {
    const name = readPluginName(plugin);
    return name !== undefined && !cdnPluginNames.has(name);
  });

  // 内置插件与 CDN 插件曾使用两个 marketplace id，UI 会把内置市场当成
  // 无 source 的独立市场并在刷新时报 not found。两个分片必须独立持久化后再合并，
  // 否则应用启动时的 seed 会覆盖 CDN 目录，或 CDN 刷新会覆盖内置目录。同名时以
  // 可刷新的 CDN 市场条目为准，但只过滤合并目录，不删除应用内置缓存。
  const merged = {
    ...(bundledManifest ?? {}),
    ...(cdnManifest ?? {}),
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...cdnPlugins, ...bundledPlugins],
  };
  writeJsonFileSync(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

/** 读取内置分片并做形状校验：version 必须为 1 且 manifest 是对象，否则视为不存在。 */
function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

/** 只保留 plugins 数组中的对象条目；数组缺失/类型不符返回空数组。 */
function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

/** 读取非空字符串 name；空串/非字符串返回 undefined。 */
function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** 判断 child 是否为 parent 的严格后代（排除自身、`..` 与绝对路径）。 */
function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

/** 写入官方目录前校验 name，防止把任意 marketplace 内容写进官方市场目录。 */
function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

/** 分片文件路径固定为 marketplaces/<official>/<fileName>。 */
function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

/** 读取 JSON 对象：文件不存在/解析失败/非对象一律返回 undefined（分片缺失是可恢复态）。 */
function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 缩进 2 空格并补尾换行；同内容跳过写盘（减少 Windows 上被杀毒/索引器占用）。 */
function writeJsonFileSync(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 官方目录在每次启动都会重建；同内容反复写盘会增加 Windows 上
    // marketplace 文件被杀毒/索引器占用的概率。只跳过字节完全相同的单文件写入，
    // 读取失败或内容变化仍执行写入并保留原有失败语义。
    if (readFileSync(path, "utf8") === contents) return;
  } catch {
    // 文件不存在或暂时不可读时继续写，让真实更新失败继续向调用方暴露。
  }
  writeFileSync(path, contents, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
