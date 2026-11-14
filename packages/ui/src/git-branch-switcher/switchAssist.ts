// INV-01 只有可提交类 issue 才弹协助：守住位置 isGitBranchCommitAssistIssue；改错故障 无关错误也弹出提交面板。
// INV-02 issue 或目标分支缺失直接返回 null：守住位置 三元早退；改错故障 面板展示空分支名。
// INV-03 三项查询并发且互不拖累：守住位置 allSettled；改错故障 一项失败导致面板整体不可用。
// INV-04 失败只告警不抛出：守住位置 三个 rejected 分支；改错故障 网络抖动打断切分支流程。
// INV-05 失败时按空列表继续：守住位置 fulfilled 判断；改错故障 面板拿到 undefined 后崩溃。
// INV-06 staged 与 unstaged 合并后再去重：守住位置 buildGitBranchCommitPreviewFiles；改错故障 同一文件出现两行。
// INV-07 受影响文件以 issue.paths 为准：守住位置 selectGitBranchAffectedFiles；改错故障 展示与阻断原因不一致。
// INV-08 stage 路径包含 issue.paths 全集：守住位置 Set 合并；改错故障 提交后 issue 仍未消除。
// INV-09 统计口径来自 commitFiles：守住位置 getGitBranchCommitTotals；改错故障 面板行数与实际提交数不符。
// INV-10 身份缺失用 null 而不是 undefined：守住位置 返回结构；改错故障 校验函数走到未定义分支。
// INV-11 无身份视为可提交：守住位置 hasGitCommitIdentity 的首个判断；改错故障 首次配置前无法提交。
// INV-12 身份必须同时有用户名与邮箱：守住位置 布尔与；改错故障 半配置身份提交失败后才报错。
// INV-13 空路径列表格式化为空串：守住位置 长度判断；改错故障 Intl 输出一对空括号。
// INV-14 路径列表按当前语言格式化：守住位置 Intl.ListFormat；改错故障 中文界面出现英文 and。
//
// 模块职责：把切分支失败结果整理成「阻断原因加待提交文件」的面板状态。
// 阅读顺序：先看早退条件与并发查询，再看文件合并与统计口径。
import type { IGitService } from "@zcode/services";
import type { GitBranchMutationIssue, GitBranchMutationResult, GitIdentity } from "@zcode/shared";
import {
  buildGitBranchCommitPreviewFiles,
  getPrimaryGitBranchIssue,
  getGitBranchCommitTotals,
  isGitBranchCommitAssistIssue,
  selectGitBranchAffectedFiles,
  type GitBranchCommitPreviewFile,
} from "@/git-branch-switcher/display.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export type GitBranchSwitchAssistDialogStep = "blocked" | "commit";

export interface GitBranchSwitchAssistState {
  targetBranchName: string;
  currentBranchName: string | null;
  issue: GitBranchMutationIssue;
  affectedFiles: GitBranchCommitPreviewFile[];
  commitFiles: GitBranchCommitPreviewFile[];
  stagePaths: string[];
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  identity: GitIdentity | null;
}

export function formatGitBranchIssuePathList(locale: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }

  // 用短格式与 conjunction，输出「a、b 和 c」这类自然语言。
  // 列表为空时不调用 Intl，避免产生空括号。
  return new Intl.ListFormat(locale, {
    style: "short",
    type: "conjunction",
  }).format(paths);
}

export function hasGitCommitIdentity(identity: GitIdentity | null): boolean {
  // 没有身份信息时不阻断：首次提交可由 git 全局配置兜底。
  // 有身份则必须两项齐全，半配置会让提交在远端失败。
  return identity === null || (Boolean(identity.userName) && Boolean(identity.userEmail));
}

export async function buildGitBranchSwitchAssistState(options: {
  gitService: IGitService;
  workspacePath: string;
  result: GitBranchMutationResult;
}): Promise<GitBranchSwitchAssistState | null> {
  // 只取首要 issue：面板一次只解决一个阻断原因。
  // 不可提交类 issue 不走这个面板，交给原错误提示。
  // 目标分支名缺失时不构造状态，避免出现空标题。
  const issue = getPrimaryGitBranchIssue(options.result.issues);
  if (!issue || !isGitBranchCommitAssistIssue(issue.code) || !options.result.branchName) {
    return null;
  }

  // 三项并发读取，任何一项失败都不影响其余两项。
  // 用 allSettled 而不是 all：这是可降级的辅助信息。
  // 身份读取失败时按 null 处理，由校验函数决定是否阻断。
  const [unstagedChangesResult, stagedChangesResult, identityResult] = await Promise.allSettled([
    options.gitService.getChanges({
      workspacePath: options.workspacePath,
      sourceId: "unstaged",
    }),
    options.gitService.getChanges({
      workspacePath: options.workspacePath,
      sourceId: "staged",
    }),
    options.gitService.getIdentity({ workspacePath: options.workspacePath }),
  ]);

  if (unstagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 unstaged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(unstagedChangesResult.reason),
    });
  }
  if (stagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 staged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(stagedChangesResult.reason),
    });
  }
  if (identityResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取提交身份失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(identityResult.reason),
    });
  }

  const unstagedChanges =
    unstagedChangesResult.status === "fulfilled" ? unstagedChangesResult.value : [];
  const stagedChanges = stagedChangesResult.status === "fulfilled" ? stagedChangesResult.value : [];
  const commitFiles = buildGitBranchCommitPreviewFiles([...unstagedChanges, ...stagedChanges]);
  const affectedFiles = selectGitBranchAffectedFiles({
    files: commitFiles,
    issuePaths: issue.paths,
  });
  // 提交文件与 issue 路径取并集，保证阻断原因一定被覆盖。
  // 用 Set 去重，顺序保持首次出现顺序。
  const stagePaths = Array.from(
    new Set([...commitFiles.map((file) => file.stagePath), ...(issue.paths ?? [])]),
  );
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(commitFiles);

  // 目标分支来自切换结果，当前分支来自摘要，两者不可混用。
  // 统计与文件列表同源，避免面板数字与实际不符。
  return {
    targetBranchName: options.result.branchName,
    currentBranchName: options.result.summary.branchName,
    issue,
    affectedFiles,
    commitFiles,
    stagePaths,
    fileCount,
    totalAdded,
    totalRemoved,
    identity: identityResult.status === "fulfilled" ? identityResult.value : null,
  };
}
