// INV-01 路径统一转正斜杠：守住位置 归一函数；改错故障 反斜杠路径无法匹配。
// INV-02 去掉前导点斜杠：守住位置 替换表达式；改错故障 同文件出现两种写法。
// INV-03 去掉尾部斜杠：守住位置 替换表达式；改错故障 目录与文件比较不等。
// INV-04 空路径归一为当前目录：守住位置 长度判断；改错故障 工作区根路径变成空串。
// INV-05 基础路径为空时不裁剪：守住位置 双空判断；改错故障 全部路径被误判在范围内。
// INV-06 相等路径裁剪后为空串：守住位置 相等分支；改错故障 根文件被当成目录前缀。
// INV-07 前缀裁剪要求带分隔符：守住位置 前缀拼接；改错故障 同名前缀被误裁。
// INV-08 大小写不敏感再试一次：守住位置 二次比较；改错故障 平台差异导致漏配。
// INV-09 空结果不写入集合：守住位置 追加函数；改错故障 空串成为匹配项。
// INV-10 无变更摘要时返回未定义：守住位置 空值判断；改错故障 空摘要被当成空范围。
// INV-11 文件路径去空白并去重：守住位置 集合构造；改错故障 重复文件重复渲染。
// INV-12 同时收原始与两种裁剪形式：守住位置 三次追加；改错故障 预览只匹配其中一种。
// INV-13 工作区子目录补全为相对仓库路径：守住位置 条件追加；改错故障 子目录文件漏配。
// INV-14 空范围回退为未定义：守住位置 长度判断；改错故障 过滤结果恒为空。
// INV-15 无范围时全部放行：守住位置 空值早退；改错故障 首次提交看不到任何文件。
// INV-16 预览文件三种路径任一命中即可：守住位置 或运算；改错故障 暂存路径被忽略。
// INV-17 范围判定逐文件归一后比较：守住位置 归一调用；改错故障 大小写与分隔符错配。
// INV-18 导出函数保持无副作用：守住位置 纯函数边界；改错故障 过滤时改写调用方数组。
//
// 模块职责：按当前会话任务变更裁剪 Git 提交预览文件范围。
// 状态所有权：无状态；每次调用各自构造并返回集合。
// 阅读顺序：先看路径归一，再看范围构造，最后看预览过滤入口。
import type { GitRepositorySummary, ZCodeTaskChangeSummary } from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

// normalizeCommitScopePath 先 trim 首尾空白。
// 反斜杠经 replace 统一为正斜杠。
// replace 用 /^\.?\// 去掉前导的点斜杠。
// 第四步 replace 去掉尾部连续斜杠。
function normalizeCommitScopePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function normalizeBasePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeCommitScopePath(path);
  return normalized.length > 0 ? normalized : ".";
}

// normalizedPath 或 normalizedBasePath 为空时返回 null。
// 两者相等时返回空串而不是 null。
// 原始前缀不匹配时改用 toLowerCase 再比一次。
function stripBasePath(path: string, basePath: string): string | null {
  const normalizedPath = normalizeBasePath(path);
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedPath || !normalizedBasePath) {
    return null;
  }

  if (normalizedPath === normalizedBasePath) {
    return "";
  }

  const prefix = `${normalizedBasePath}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lowerPath = normalizedPath.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerPath.startsWith(lowerPrefix)) {
    return normalizedPath.slice(prefix.length);
  }

  return null;
}

function addScopePath(scope: Set<string>, path: string | null): void {
  if (path === null) {
    return;
  }

  const normalizedPath = normalizeCommitScopePath(path);
  if (normalizedPath) {
    scope.add(normalizedPath);
  }
}

function buildCurrentSessionFileScope(options: {
  summary: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): Set<string> | null {
  const filePaths = getCurrentSessionFilePaths(options.summary);
  if (!filePaths) {
    return null;
  }

  const scope = new Set<string>();
  const workspaceInRepoPath = normalizeWorkspaceInRepoPath(options.gitSummary.workspaceInRepoPath);

  for (const filePath of filePaths) {
    addScopePath(scope, filePath);
    addScopePath(scope, stripBasePath(filePath, options.gitSummary.repoRoot));
    addScopePath(scope, stripBasePath(filePath, options.workspacePath));

    const normalizedPath = normalizeCommitScopePath(filePath);
    if (workspaceInRepoPath !== "." && !normalizedPath.startsWith(`${workspaceInRepoPath}/`)) {
      addScopePath(scope, `${workspaceInRepoPath}/${normalizedPath}`);
    }
  }

  return scope.size > 0 ? scope : null;
}

function isPreviewFileInScope(
  file: GitBranchCommitPreviewFile,
  scope: Set<string> | null,
): boolean {
  if (!scope) {
    return true;
  }

  return [file.stagePath, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitScopePath(path)),
  );
}

export function getCurrentSessionFilePaths(
  summary: ZCodeTaskChangeSummary | null,
): string[] | undefined {
  const paths = Array.from(
    new Set(
      (summary?.files ?? []).map((file) => file.path.trim()).filter((path) => path.length > 0),
    ),
  );
  return paths.length > 0 ? paths : undefined;
}

// 先由 buildCurrentSessionFileScope 构造当前会话范围。
// scope 为空时把全部文件放行。
// 逐文件交给 isPreviewFileInScope 按三种路径判定命中。
export function filterCommitPreviewFilesByCurrentSession(options: {
  files: readonly GitBranchCommitPreviewFile[];
  summary: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary;
  workspacePath: string;
}): GitBranchCommitPreviewFile[] {
  const scope = buildCurrentSessionFileScope({
    summary: options.summary,
    gitSummary: options.gitSummary,
    workspacePath: options.workspacePath,
  });
  return options.files.filter((file) => isPreviewFileInScope(file, scope));
}
