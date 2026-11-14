import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/*
 * ============================================================
 * plugins / helpers.ts —— 路径/类型守卫与来源清理小工具
 *
 * 定位：插件装载、解压、组件枚举共用的小函数；核心是 resolveInside 的目录逃逸防护，
 * 所有 manifest/zip 提供的相对路径都必须经它归一。
 *
 * 输入输出：resolveInside 返回 root 内的绝对路径，越界/绝对路径返回 null；
 * 其余函数返回布尔/数组/错误对象。
 *
 * 副作用：statSync 探测文件系统（不写入）；cleanupPluginSourceBestEffort 会调用传入的
 * 清理回调（通常删临时目录）。
 *
 * 失败语义：所有存在性检查吞掉异常返回 false；清理按 0/25/100ms 重试 3 次后返回最后
 * 一次错误而不抛出。
 *
 * 不变量：插件根之外的路径永远不可被解析；清理失败绝不覆盖主错误。
 * ============================================================
 */

const PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS = [0, 25, 100] as const;

/** 把 rawPath 解析到 rootPath 下；绝对路径或 `..` 逃逸一律返回 null（信任边界）。 */
export function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) return null;
  const resolved = resolve(rootPath, rawPath);
  const rel = relative(rootPath, resolved);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) return resolved;
  return null;
}

/** 把 pluginId 中不安全字符替换为 `-`，用于目录名/文件名（保留字母数字与 _ . @ -）。 */
export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9_.@-]/g, "-");
}

/** 将字符串或字符串数组归一成数组；其他类型返回空数组。 */
export function parsePathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** 插件 option 只允许标量（string/number/boolean）；对象/数组/空值均非法。 */
export function isPluginOptionValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** 类型守卫：非数组普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** stat 判断是否为目录；任何异常（含权限错误）都返回 false。 */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 「路径缺失」只认 ENOENT/ENOTDIR（stat 的精确错误码）。EACCES 等权限错误
 * 不是缺失——调用方不得据此发「不存在」诊断，避免把权限问题误报成 manifest 配错。
 */
export function isMissingPath(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** stat 判断是否为普通文件；任何异常都返回 false。 */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 只认精确的 ENOENT（文件不存在）；权限等其他错误不算“未找到”。 */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 尽力清理临时插件源（默认延迟 0/25/100ms 重试），返回 null 表示成功或无需清理，
 * 否则返回最后一次错误。清理是旁路动作，永不影响主流程的结果。
 */
export async function cleanupPluginSourceBestEffort(
  cleanup: (() => Promise<void>) | undefined,
  retryDelaysMs: readonly number[] = PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS,
): Promise<unknown> {
  if (!cleanup) return undefined;
  let cleanupError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError;
}

/**
 * 把清理错误追加到主错误 message 上（仅当主错误是 Error 且确有清理失败）。
 * 追加而非替换，保证原始失败原因（下载/校验/解压）不被清理噪音掩盖。
 */
export function appendPluginSourceCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): unknown {
  if (cleanupError === undefined || !(primaryError instanceof Error)) return primaryError;
  const cleanupMessage =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  // 临时目录删除失败只能作为附加诊断，不能覆盖下载、校验或解压的原始错误。
  primaryError.message = `${primaryError.message}; plugin source cleanup also failed: ${cleanupMessage}`;
  return primaryError;
}

/** 插件操作统一取消检查：signal 已中止即抛固定消息，供上层映射为取消语义。 */
export function throwIfAborted(options: { signal?: AbortSignal } | undefined): void {
  if (options?.signal?.aborted) throw new Error("Plugin operation cancelled");
}
