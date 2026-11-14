// 提交信息文件范围：把「当前会话改动过的文件」换算为候选路径集合，
// 用于判断某个 Git 改动是否属于本次会话，从而决定是否出现在提交信息上下文里。
// currentSessionFilePaths 来源不统一，可能由绝对路径、相对工作区或 ./ 前缀等基准给出，
// 因此统一归一化为相对仓库根的 POSIX 形式后再比较；归一化只影响匹配，不改原始数据。
import { isAbsolute, relative } from "node:path";
import type { GitFileChange } from "@zcode/shared";
import { normalizeGitPath, normalizeWorkspaceInRepoPath } from "./config.js";

// 归一化候选路径：去空白、走 git 路径规整，再去掉开头的 ./ 或 / 以及结尾多余的 /，
// 使 "a/b"、"./a/b" 与 "a/b/" 都必须归一为同一路径。
// normalizeCommitMessageScopePath 只做字符串规整，不解析 .. 也不触碰文件系统。
function normalizeCommitMessageScopePath(path: string): string {
  return normalizeGitPath(path.trim())
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

// relative() 的结果为空串、".." 或以 "../" 开头时只能算越界：
// 以及绝对路径都算越界——Windows 下跨盘时 relative 会返回绝对路径。
// isRelativePathInsideScope 用于拦掉仓库根/工作区之外的路径，避免污染候选集合。
function isRelativePathInsideScope(path: string): boolean {
  const normalizedPath = normalizeGitPath(path);
  return (
    normalizedPath.length > 0 &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith("../") &&
    !isAbsolute(normalizedPath)
  );
}

function addCommitMessageScopeCandidate(scope: Set<string>, path: string): void {
  const normalizedPath = normalizeCommitMessageScopePath(path);
  if (!normalizedPath) {
    return;
  }
  scope.add(normalizedPath);
}

// 返回 null 表示「范围不可知」（无会话文件信息或集合为空），
// filterCommitMessageFilesByCurrentSession 的调用方应按不过滤处理，而不是清空所有文件。
// 同一条输入会同时收集多种解释（原样、相对仓库根、相对工作区），
// 因为不同工具记录路径的基准不同；宁可放宽匹配，也不能漏掉真实改动。
function buildCommitMessageFileScope(params: {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  currentSessionFilePaths?: readonly string[];
}): Set<string> | null {
  // currentSessionFilePaths 来自会话文件变更记录，可能含重复与空串；缺失时返回 null 表示不可知。
  const sourcePaths = params.currentSessionFilePaths
    ?.map((path) => path.trim())
    .filter((path) => path.length > 0);
  // 空集合与缺失同义：调用方依赖 null 走「不过滤」，而不是把所有文件都过滤掉。
  if (!sourcePaths || sourcePaths.length === 0) {
    return null;
  }

  // Set 去重但不排序：范围只用于成员判断，顺序对调用方没有意义。
  const scope = new Set<string>();
  // normalizedWorkspaceInRepoPath 用于把相对工作区的路径还原成仓库相对路径；
  // 它可能是 "."（工作区即仓库根），此时必须跳过拼接，也不能重复加前缀。
  // 前缀比较在归一化后进行，"//"、"./" 等写法不会破坏判断。
  const normalizedWorkspaceInRepoPath = normalizeWorkspaceInRepoPath(params.workspaceInRepoPath);

  for (const path of sourcePaths) {
    addCommitMessageScopeCandidate(scope, path);

    // isAbsolute 为真时要同时尝试两种基准：先相对仓库根，再相对工作区。
    // monorepo 下工作区通常是仓库子目录，同一条绝对路径往往只有一种换算能得到
    // 合法相对路径，另一种会得到 ../ 或跨盘绝对路径而被 isRelativePathInsideScope 拒绝。
    // isRelativePathInsideScope 两种都拒绝说明文件在范围之外，不再加入候选。
    // 此处 continue 是有意的：绝对路径无需再做工作区前缀拼接。
    if (isAbsolute(path)) {
      // repoRoot 与 workspacePath 都由调用方传入，本函数不读 cwd，避免后台线程里 cwd 漂移。
      const repoRelativePath = relative(params.repoRoot, path);
      if (isRelativePathInsideScope(repoRelativePath)) {
        addCommitMessageScopeCandidate(scope, repoRelativePath);
      }

      // 同一绝对路径在 monorepo 下可能只有一种换算合法，另一种会被 isRelativePathInsideScope 拒绝。
      const workspaceRelativePath = relative(params.workspacePath, path);
      if (isRelativePathInsideScope(workspaceRelativePath)) {
        addCommitMessageScopeCandidate(scope, workspaceRelativePath);
      }
      continue;
    }

    const normalizedPath = normalizeCommitMessageScopePath(path);
    if (
      normalizedWorkspaceInRepoPath !== "." &&
      !normalizedPath.startsWith(`${normalizedWorkspaceInRepoPath}/`)
    ) {
      addCommitMessageScopeCandidate(scope, `${normalizedWorkspaceInRepoPath}/${normalizedPath}`);
    }
  }

  return scope.size > 0 ? scope : null;
}

// scope 为 null 表示范围不可知，视为全部命中；否则三类路径字段任一命中即算属于范围，
// isCommitMessageFileInScope 比较前再次归一化，抵消上游的分隔符与 ./ 差异。
function isCommitMessageFileInScope(file: GitFileChange, scope: Set<string> | null): boolean {
  if (!scope) {
    return true;
  }

  return [file.path, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitMessageScopePath(path)),
  );
}

// 对外入口：先由会话路径推导范围，再按范围过滤，保持输入顺序且不去重。
// filterCommitMessageFilesByCurrentSession 是纯函数，可重复调用且不触碰文件系统；
// scope 为 null 时等价于不做过滤。
export function filterCommitMessageFilesByCurrentSession(params: {
  files: readonly GitFileChange[];
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  currentSessionFilePaths?: readonly string[];
}): GitFileChange[] {
  const scope = buildCommitMessageFileScope({
    workspacePath: params.workspacePath,
    repoRoot: params.repoRoot,
    workspaceInRepoPath: params.workspaceInRepoPath,
    currentSessionFilePaths: params.currentSessionFilePaths,
  });
  // 返回新数组且保持原顺序：调用方直接用于生成提交信息，不期望原地修改。
  return params.files.filter((file) => isCommitMessageFileInScope(file, scope));
}
