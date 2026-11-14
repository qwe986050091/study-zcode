// ============================================================
// memory/file-path —— 记忆文件路径的边界解析与敏感目录过滤
// ============================================================
//
// 【定位】Memory 后台 agent 的工具执行、以及“本轮是否已直接写过记忆”的判定，
//   都先经过这里：按 workspace 路径策略解析绝对路径，再判断是否在 memoryRoot 内。
//
// 【两级口径】
//   contained：只要求落在 memoryRoot 内（允许子目录），用于事实检测。
//   safe：contained 且不含敏感目录段，用于实际放行 Edit/Write/rm。
//
// 【读写边界】纯路径计算，不访问文件系统；不创建、不读取文件。
// 【失败语义】越界返回 undefined；路径策略本身抛错则向上冒泡，由调用方兜底。
// 【跨平台】需归一化大小写、分隔符、NTFS ADS、尾部点/空格与双向控制符。
// ============================================================
import { isAbsolute, relative } from "node:path";

import { resolveWorkspacePath } from "../tool/path-policy.js";

// 拒绝写入的路径段：可执行/可被运行时加载的内容（hooks、skills、commands、agents）
// 与工具链状态目录（.git、node_modules、各类缓存）。Memory 只应改写普通 .md 记忆。
const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  ".git",
  "hooks",
  ".husky",
  ".githooks",
  "node_modules",
  ".vscode",
  ".idea",
  "head",
  "config",
  "objects",
  "refs",
  ".claude",
  ".zcode",
  "skills",
  "commands",
  "agents",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);

/**
 * 把工具给的相对/绝对路径解析为 memoryRoot 内的绝对路径（只做边界判断）。
 * 输入：filePath、memoryRoot(rootDir)、workingDirectory、workspaceRoot。
 * 输出：落在 rootDir 内时返回规范化绝对路径，否则 undefined。
 * 副作用：无（纯计算）。
 * 失败语义：越界（含 rootDir 自身）返回 undefined；底层路径策略抛错则上抛。
 * 不变量：解析使用 operation=write 的 workspace 路径规则，
 *   保证与 Write/Edit 工具实际写入时的路径口径一致。
 */
export function resolveContainedMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveWorkspacePath({
    inputPath: input.filePath,
    operation: "write",
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
  const relativePath = relative(input.rootDir, resolvedPath);
  return isContainedRelativePath(relativePath) ? resolvedPath : undefined;
}

/**
 * 解析允许后台 agent 实际写/删的记忆文件路径（contained + 非敏感目录）。
 * 输入：同 resolveContainedMemoryFilePath。
 * 输出：可安全操作的绝对路径；不在 memoryRoot 内或命中敏感段时为 undefined。
 * 副作用：无。
 * 失败语义：不抛错——越界、相对路径异常与敏感段都统一降级为 undefined。
 * 不变量：比 contained 更严格；命中敏感段即使仍在 memoryRoot 内也必须拒绝。
 */
export function resolveSafeMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveContainedMemoryFilePath(input);
  if (!resolvedPath) return undefined;
  const relativePath = memoryFileRelativePath(input.rootDir, resolvedPath);
  return relativePath && !containsSensitiveMemoryPathSegment(relativePath)
    ? resolvedPath
    : undefined;
}

/**
 * 计算文件相对 memoryRoot 的路径，并校验仍在根目录内。
 * 输出：相对路径（不以分隔符开头）；越界时为 undefined。
 */
export function memoryFileRelativePath(rootDir: string, filePath: string): string | undefined {
  const relativePath = relative(rootDir, filePath);
  return isContainedRelativePath(relativePath) ? relativePath : undefined;
}

/**
 * 判断相对路径是否包含任一敏感目录段（大小写与 Windows 归一化后比较）。
 * 输入：memoryRoot 内相对路径；输出：boolean。
 * 失败语义：无；空段不匹配任何集合项。
 */
export function containsSensitiveMemoryPathSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .some((segment) => SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalizeSensitiveSegment(segment)));
}

/**
 * 判断相对路径是否“确实位于根目录之内”。
 * 拒绝：空串（等于根目录本身）、`..`、以 `../`/`..\` 开头的逃逸路径、以及绝对路径
 * （Windows 下不同盘符时 relative 会直接返回绝对路径）。
 */
function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("..\\") &&
    !isAbsolute(relativePath)
  );
}

/**
 * 归一化单个路径段用于敏感目录比对。
 * 口径：转小写、剥离双向控制符（防视觉伪装）、丢弃 NTFS 备用数据流后缀（冒号之后）、
 *   去掉尾部点与空格（Windows 会静默忽略这些字符，否则可用 `.git.` 绕过）。
 */
function normalizeSensitiveSegment(segment: string): string {
  const withoutControls = segment
    .toLowerCase()
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "");
  return (withoutControls.split(":", 1)[0] ?? "").replace(/[. ]+$/u, "");
}
