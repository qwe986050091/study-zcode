// 工具路径展示模块：把工具入参里的 filePath 归一化为 transcript 标题可读的路径。
// 边界：只做字符串/路径语义计算，不访问文件系统、不判断文件是否存在。
// 口径：位于工作区内输出相对路径（根为 "."），否则输出规范化绝对路径；Windows 形态整体按 win32 处理。
// 失败语义：空路径返回 undefined，由调用方回退通用标题；纯函数不抛错。
import { posix, win32 } from "node:path";

// 判断路径是否为 Windows 绝对路径（盘符或 UNC），用于选择 win32/posix 语义。
const WINDOWS_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

type PathApi = typeof posix;

// 把工具入参里的 filePath 归一化成 transcript 标题可读的路径。
// 输入 filePath 为 undefined/空白时返回 undefined（调用方回退到通用标题）；
// 无 workspaceDirectory 时只做规范化的绝对/相对清理，不尝试求相对路径。
// 位于工作区内则输出相对路径（工作区根返回 "."），否则输出规范化绝对路径。
// 纯函数，不访问文件系统；路径分隔符由 win32/posix 判定决定。
export function formatToolFilePath(
  filePath: string | undefined,
  workspaceDirectory: string | undefined,
): string | undefined {
  const rawPath = filePath?.trim();
  // 空串或全空白视为未提供路径，保持 undefined 语义而不输出 "."。
  if (!rawPath) return undefined;

  const pathApi = pathApiFor(rawPath, workspaceDirectory);
  if (!workspaceDirectory) return pathApi.normalize(rawPath);

  const workspaceRoot = pathApi.resolve(workspaceDirectory);
  const targetPath = pathApi.isAbsolute(rawPath)
    ? pathApi.normalize(rawPath)
    : pathApi.resolve(workspaceRoot, rawPath);
  const relativePath = pathApi.relative(workspaceRoot, targetPath);

  if (isWorkspaceRelativePath(relativePath, pathApi)) {
    return relativePath.length === 0 ? "." : relativePath;
  }

  return targetPath;
}

// 目标路径或工作区任一呈现 Windows 形态就整体按 win32 处理，避免混合分隔符误判。
function pathApiFor(filePath: string, workspaceDirectory: string | undefined): PathApi {
  if (WINDOWS_PATH_PATTERN.test(filePath)) return win32;
  if (workspaceDirectory && WINDOWS_PATH_PATTERN.test(workspaceDirectory)) return win32;
  return posix;
}

// 相对路径为空（同目录）或以 ".." 开头视为工作区外，后者不截断为相对路径以免误导。
function isWorkspaceRelativePath(relativePath: string, pathApi: PathApi): boolean {
  if (relativePath.length === 0) return true;
  if (pathApi.isAbsolute(relativePath)) return false;
  return relativePath !== ".." && !relativePath.startsWith(`..${pathApi.sep}`);
}
