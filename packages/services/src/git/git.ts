// Git 能力面契约：只声明按仓库路径寻址的查询与工作区变更方法，不持有任何本地状态。
// 实现方负责把请求转成 git 命令或宿主能力，参数与结果类型统一来自 @zcode/shared。
// 路径、远端与认证信息均由调用方传入，服务不推断 cwd，也不缓存仓库快照。
import type {
  GitBranchMutationResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitFileChange,
  GitSwitchBranchRequest,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 读方法（summary、branches、graph、changes、diff）应无副作用，可被 UI 反复调用刷新。
// 写方法（switch、create、stage、unstage、discard、commit、push）只作用于目标工作区，失败以 reject 表达。
// 服务不保存 UI 状态；缓存、并发去重与刷新节流由调用方的 hook 或 store 负责。
export interface IGitService {
  // 仓库摘要供列表与状态栏使用：分支、脏状态与 ahead/behind 一次取回，减少往返。
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  // 工作区变更列表：同时包含已暂存与未暂存条目，调用本身不修改 index 或工作区内容。
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  // diff 的返回形态由查询参数决定（整文件、片段或暂存区），调用方需按 query 解释结果。
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  // 路径级变更组：只改 index 或指定路径内容，不产生 commit，也不触发推送。
  // discard 会丢失未提交内容，调用方必须先自行确认，服务不做二次校验。
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  // 只生成候选提交信息文本，不改 index 也不提交；生成失败应由实现方抛错而非返回空串。
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  // 提交当前 index 并返回新 commit 元数据；不会隐式 stage 未跟踪文件。
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  // 推送指定远端与分支；认证与凭据由宿主处理，服务不读取也不记录任何 token。
  push(params: GitPushRequest): Promise<GitPushResult>;
  // 读取仓库级 user.name 与 user.email（含本地覆盖），仅用于展示，不修改配置。
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

// 同名类型与常量合并：接口供编译期约束，descriptor 供 DI 与 RPC 按 ServiceChannels.Git 注册解析。
// 改频道名会同时破坏 host 与 desktop 的装配，属破坏性变更。
export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git);
