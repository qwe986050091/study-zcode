// ============================================================
// Tool Path Normalization Helpers
// ============================================================

import path, { normalize } from "node:path";
import { platform as currentPlatform } from "node:process";

export type ToolPathPlatform = NodeJS.Platform;
export type ToolPathApi = typeof path.posix | typeof path.win32;

/**
 * 按目标平台选择 path 实现：win32 用反斜杠/盘符语义，其余平台用 posix。
 * 显式传 platform 而不是依赖运行环境，便于在同一台机器上测试跨平台分支。
 * 纯函数；不读取 process.platform。
 */
export function getToolPathApi(platform: ToolPathPlatform): ToolPathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * 生成工具路径的比较键（仅用于判等/查表，不是可回写的真实路径）。
 * 处理顺序：Windows 盘符别名/扩展前缀归一 → path.normalize → Unicode NFC。
 * 不变量：同一文件的不同写法（c:/、C:\、\\?\c:\、/c/）在 win32 下得到同一个键；
 * 但故意不做 realpath/符号链接解析，也不折叠路径段大小写——没有文件系统身份时
 * case-fold 会把 C:\Repo 与 C:\repo 误并为同一文件（read-state 测试明确要求不等）。
 * 纯函数、无 I/O；调用方需接受“形似但不可达”的路径不会被识别。
 */
export function normalizeToolPathForComparison(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  const normalized =
    platform === "win32" ? normalizeWindowsToolPath(filePath) : normalize(filePath);
  return normalized.normalize("NFC");
}

/**
 * Windows 路径归一化流水线：盘符别名 → win32 normalize → 剥扩展前缀 → 统一盘符大写。
 * 顺序重要：先转换 /c/ 形态才能被 win32 规范化，最后再统一盘符大小写。
 * 输出仍保留原路径的大小写与分隔符风格；不做存在性检查、不解析符号链接。
 */
function normalizeWindowsToolPath(filePath: string): string {
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(path.win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // Read/Edit/Write 和 Bash cwd 都会收到 Git Bash 风格的 /c/... 路径；
  // 统一转换到 drive-letter 形式，避免各工具重复实现 Windows path 兼容逻辑。
  // 注意：只识别 `/c/`（单字母+斜杠）形态；MSYS 的 `/cygdrive/c/...` 不在范围内，
  // 会被原样保留并因此与 drive-letter 写法判为不同键（read-state 测试明确锁定该行为）。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

/** 把开头的盘符字母统一成大写（c: → C:），其余路径字符保持不变。 */
function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  // 为什么保留设备命名空间：\\?\Volume{...}、\\?\GLOBALROOT\... 没有盘符身份，
  // 强行去掉前缀会丢失卷/设备信息；它们只做 normalize，不参与盘符判等。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
