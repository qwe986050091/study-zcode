// Git CLI 的跨进程结构契约：本文件只有类型与一个纯构造函数，不包含任何 git 调用。
// INV-01：解析结果、状态快照、分支比较、提交图都以 GitResolvedRepository 为唯一前置；
//         下游只读 resolution.repoRoot 与 workspaceInRepoPath，不自行拼路径（守住：各 Snapshot 定义）。
// INV-02：三个 stats 以相对仓库根的 path 为键，禁止混入绝对路径（守住：GitStatusSnapshot）。
//         破坏后果：分栏统计与实际 diff 对不上，用户看到「有改动但列表为空」。
// INV-03：createEmptySummary 只填默认值，不推断分支或脏状态；改成猜测会让未初始化仓库
//         短暂显示伪造的 branch/ahead 数据（守住：createEmptySummary）。
import type {
  GitBranchMutationResult,
  GitChangeKind,
  GitCommitGraphCommit,
  GitDiffQuery,
  GitDiffResult,
  GitIdentity,
  GitLocalBranchListResult,
  GitPushResult,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
} from "@zcode/shared";

// 单文件增删统计。kind 与 originalPath 只在重命名、二进制等特殊条目上出现，故为可选；
// 缺省一律按普通文本修改解释，消费方不能当成未知类型。
// added/removed 是行数而非字节数，二进制文件恒为 0，必须靠 kind 才能区分「无改动」和「不可计」。
export interface GitLineStat {
  added: number;
  removed: number;
  kind?: GitChangeKind;
  originalPath?: string | null;
}

// 一条工作区状态。x/y 保留 porcelain 的原始两列（可能是空格），供 UI 原样展示；
// 「没有这一列」必须是 null 而不是空串，否则 x 为空串与 x 为空格会被混为一谈。
export interface GitStatusEntry {
  path: string;
  originalPath: string | null;
  kind: GitChangeKind;
  x: string | null;
  y: string | null;
  isUntracked: boolean;
  isConflicted: boolean;
}

// 分支比较的逐文件行数。重命名时 path 是新名、originalPath 是旧名，
// 匹配历史改动要优先用 originalPath，否则一次重命名会被算成删除加新增两条。
export interface GitBranchComparisonChange {
  path: string;
  originalPath: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

// 工作区与仓库根分离：workspaceInRepoPath 是相对路径且可能为空串（工作区即根），
// 任何地方都不能把它当绝对路径拼接，否则会得到双斜杠或丢失路径段。
export interface GitResolvedRepository {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  autoRefreshWatchPaths: GitRepositorySummary["autoRefreshWatchPaths"];
  isGitAvailable: boolean;
  isRepository: boolean;
}

// 一次状态读取的完整结果。entries 与 summary 必须来自同一次 git 调用序列，
// 分开拉会出现 entries 已有新文件而 summary.isDirty 仍是旧值，UI 表现为「有改动却显示干净」。
// 三个 stats 与 entries 的 path 同形，才能按栏目直接查表而不必再归一化。
export interface GitStatusSnapshot {
  resolution: GitResolvedRepository;
  summary: GitRepositorySummary;
  entries: GitStatusEntry[];
  stagedStats: Map<string, GitLineStat>;
  unstagedStats: Map<string, GitLineStat>;
  untrackedStats: Map<string, GitLineStat>;
}

// baseRef/headRef 为 null 表示上游分支还不存在（新分支未 push），UI 应显示「未跟踪」；
// comparisonLabel 只用于展示，禁止参与任何 ref 匹配。
export interface GitBranchComparisonSnapshot {
  resolution: GitResolvedRepository;
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitBranchComparisonChange[];
}

// hasMore 由后端显式给出，表示本次按 maxCount 截断且可能还有更早提交；
// 不能用 commits.length 反推，最后一个提交可能恰好等于 maxCount。
export interface GitCommitGraphSnapshot {
  resolution: GitResolvedRepository;
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
}

// CLI 实现必须满足的接口：方法按 workspacePath（不是仓库根）寻址，由实现内部 resolve；
// 失败必须 reject，返回空快照会被上层当成仓库干净，比抛错更难排查。
export interface GitCliRepo {
// 缓存失效的唯一入口：解析结果与状态快照同寿命，只失效其中一个，
// 下一次读就会把旧 repoRoot 与新 entries 拼在一起。
  invalidate(workspacePath: string): void;
  resolveRepository(workspacePath: string): Promise<GitResolvedRepository>;
  getWorkspaceRepositoryInfo(workspacePath: string): Promise<GitWorkspaceRepositoryInfo>;
  getStatus(workspacePath: string): Promise<GitStatusSnapshot>;
  getCommitGraph(
    workspacePath: string,
    maxCount?: number,
    skip?: number,
  ): Promise<GitCommitGraphSnapshot>;
  getIgnoredPaths(workspacePath: string, paths: string[]): Promise<string[]>;
  listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult>;
// 切分支不在这里做 stash；工作区是否干净由调用方先确认，避免未提交改动被带进目标分支。
  switchBranch(workspacePath: string, targetBranchName: string): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(
    workspacePath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<GitBranchMutationResult>;
// 用对象传参而非散参：diff 的 staged、路径与范围组合会持续增加，聚成对象避免签名反复扩充。
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(workspacePath: string): Promise<GitBranchComparisonSnapshot>;
  stage(workspacePath: string, paths: string[]): Promise<void>;
  unstage(workspacePath: string, paths: string[]): Promise<void>;
  discard(workspacePath: string, paths: string[], staged: boolean): Promise<void>;
// paths 与 stagedOnly 是两种互斥的提交范围：给了 paths 就按路径提交，否则整树；
// stagedOnly 只提交索引内容，绝不隐式 add，防止把用户没看过的文件带进提交。
  commit(
    workspacePath: string,
    message: string,
    paths?: string[],
    options?: { stagedOnly?: boolean },
  ): Promise<{ commitHash: string }>;
// push 只推当前跟踪分支，不接受远端与 refspec，从接口层就断掉构造 force 推送的可能。
  push(workspacePath: string): Promise<GitPushResult>;
  getIdentity(workspacePath: string): Promise<GitIdentity>;
}

// 解析失败或首次加载时的占位摘要：只复制 resolution 已确认的字段，其余取未知默认值，
// 不推断分支或脏状态，否则 UI 会短暂显示伪造的 ahead/behind。
export function createEmptySummary(resolution: GitResolvedRepository): GitRepositorySummary {
  return {
    workspacePath: resolution.workspacePath,
    repoRoot: resolution.repoRoot,
    workspaceInRepoPath: resolution.workspaceInRepoPath,
    autoRefreshWatchPaths: resolution.autoRefreshWatchPaths,
// 未知分支用 null 而不是空串：空串在模板里渲染成空白，null 才能被 UI 识别为未初始化。
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: resolution.isGitAvailable,
    isRepository: resolution.isRepository,
  };
}
