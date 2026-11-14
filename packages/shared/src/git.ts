// INV-01 GitFileChange 的 x 与 y 是 porcelain 两列状态字符的原样承载，本层不得归一化或交换；守住位置：GitFileChange 的 x、y 字段与全部消费方；改错故障：暂存区与工作区被读反，用户勾选暂存时提交了另一份内容。
// INV-02 section 必须与 isStaged、isUntracked、isConflicted 同源推导，冲突文件只归入 conflicted 分区；守住位置：GitFileChange 的 section 与三个布尔字段；改错故障：同一文件在两个分区各出现一次，丢弃操作作用到错误版本。
// INV-03 path、repoRelativePath、workspaceRelativePath 三者不可互相替代，workspace 位于仓库子目录时必须三者同时携带；守住位置：GitFileChange 与 GitCheckpointFileDiff；改错故障：拼不出真实路径，点击文件打开空白或提示不存在。
// INV-04 headRefType 只有 branch 与 detached 两值，空仓库与游离头一律落在 detached；守住位置：GitHeadRefType 及在 summary 与本地分支列表中的赋值；改错故障：空仓库被当成有分支，界面显示不存在的分支名并允许切换。
// INV-05 无 upstream 时 trackingBranchName 必须为 null 且 ahead、behind 双 0，不得用 0 冒充已同步；守住位置：GitRepositorySummary 的 trackingBranchName 与 ahead、behind；改错故障：界面显示已与远端同步，用户误以为推送已完成。
// INV-06 isGitAvailable 与 isRepository 相互独立，缺 git 时 isGitAvailable 为假而 isRepository 不为假；守住位置：GitRepositorySummary 与 GitWorkspaceRepositoryInfo 的这两个字段；改错故障：未安装 git 的机器被当成空目录，界面引导用户初始化仓库。
// INV-07 GitRepositoryChangeSourceId 必须是 GitChangeSourceId 去掉 last-turn 的收窄结果，普通刷新不得携带 last-turn；守住位置：GitRepositoryChangeSourceId 的 Extract 与 GitChangesRequest；改错故障：会话轮次来源混入仓库刷新，服务端收到越界 sourceId 后整次刷新失败。
// INV-08 GitDiffAvailability 的 unavailable 表示取不到 diff，绝不等于空 patch，两者不可互换；守住位置：GitDiffResult 的 availability 与 patch；改错故障：二进制文件被显示成无改动，用户把未审阅的改动直接提交。
// INV-09 truncated 表示 patch 已被截断但仍然非空，前端不得把截断内容当作完整差异让用户确认；守住位置：GitDiffResult 的 availability 判定；改错故障：用户依据缺失的尾部代码判断改动安全。
// INV-10 patch 与 beforeContent、afterContent 是互斥的两种供给方式，三者同时为空才算真正不可用；守住位置：GitDiffResult 的这三个字段；改错故障：编辑器把空内容当作新版本回写，文件被清空。
// INV-11 GitBranchMutationIssueCode 的 unknown 是版本兼容兜底，新增细分码时不得删除或改名；守住位置：GitBranchMutationIssueCode 联合类型与 issue 消费方；改错故障：旧版界面遇到新码直接抛错，切换分支失败且没有任何提示。
// INV-12 GitBranchMutationResult 的 ok 为假时 didChange 仍可能为真，界面是否刷新必须依据 didChange；守住位置：GitBranchMutationResult 的 ok、didChange、created；改错故障：切换已完成但界面不刷新，仍显示旧分支与旧改动列表。
// INV-13 didChange 与 created 语义分离，创建并切换时两者同时为真，只切分支时 created 为假；守住位置：GitBranchMutationResult 的两个布尔字段；改错故障：界面把切换误报成新建分支，或同名分支已存在时误报成功。
// INV-14 GitCommitGraphCommit 的 parents 顺序即父提交顺序，图形连线依赖该顺序，任何环节不得排序；守住位置：GitCommitGraphCommit 的 parents 与图形渲染方；改错故障：合并提交的第二父被画成第一父，连线错位到错误列。
// INV-15 hasMore 必须与 maxCount、skip 的截断结果一致，为真时下一页从 skip 加已取条数继续；守住位置：GitCommitGraphRequest 的 maxCount、skip 与 GitCommitGraphResult 的 hasMore；改错故障：滚动加载重复拉同一页或提前停止，提交图缺段。
// INV-16 GitCheckpointMeta 的 refName 与 commitOid 是不可变快照锚点，创建后不得改写；守住位置：GitCheckpointMeta 与检查点恢复、diff 查询；改错故障：恢复检查点指到错误提交，把用户当前工作覆盖成旧快照。
// INV-17 GitCheckpointConflictReason 四值必须分别覆盖内容不符、工作区缺失、意外多余、类型不符，不得合并成单一 error；守住位置：GitCheckpointConflict 的 reason 与恢复冲突收集；改错故障：冲突被静默跳过，恢复后文件缺失或类型错乱且无提示。
// INV-18 GitFileChange 的 added 与 removed 是行数统计，二进制、纯重命名或未知时必须为 0；守住位置：GitFileChange 与 GitCheckpointFileDiff 的计数字段；改错故障：界面显示负行数或 NaN，改动统计汇总失真。
// INV-19 所有请求类型都继承 GitRepositoryRequest，workspacePath 必填且必须是解析后的绝对路径；守住位置：各 Request 接口与 GitDiffQuery；改错故障：缺省路径使服务端在进程 cwd 上执行 git，读到并改写别的仓库。
import type { Locale } from "./protocol.js";

// [权衡] 头状态只保留 branch 与 detached 两值，不再区分空仓库、rebase 中或
// bisect 中：那些是操作状态，由 issue 码单独表达，混进这里会让每个消费方
// 都多写一条分支，漏一处就把 detached 游离头当成正常分支。
// 空仓库与游离头在 git 侧同样没有可用的分支引用，因此统一归入 detached；
// 若给空仓库单列一种值，界面就会在首个提交之前显示分支并允许推送，
// 实际推上去的是一个不存在的 ref，push 会被远端拒绝。
// [失败路径] 消费方必须先判 headRefType 再读 branchName，branchName 为 null 是常态；
// 反过来先取名字会把 null 拼进标题或命令参数，界面呈现为空分支。
export type GitHeadRefType = "branch" | "detached";

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed";

export type GitChangeSourceId = "unstaged" | "staged" | "branch" | "last-turn";

export type GitRepositoryChangeSourceId = Extract<
  GitChangeSourceId,
  "unstaged" | "staged" | "branch"
>;

export type GitChangeSectionId =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-turn";

// [失败路径] 四种可用性按信息量递减排列，消费方必须显式处理每一种，缺省分支
// 不能落回 patch：把 binary 当空 patch 会让用户以为文件没有改动。
// truncated 与 unavailable 的区别是前者有内容但被截断，后者完全没取到；
// 混用会把太大提示成取不到，用户不知道重试是否有意义。
// [权衡] 不用空字符串表示不可用：空 patch 在 git 语义里是合法的无差异，
// 两者共用一种表示就分不清 patch 为空是文件没变还是这次没读到。
// binary 由 git 的二进制判定给出，不在这里按扩展名猜，否则文本日志会被
// 误判成 binary 而跳过展示。
export type GitDiffAvailability = "patch" | "binary" | "truncated" | "unavailable";

export type GitBranchMutationAction = "switch" | "create-and-switch";

// 这些码由服务端从 git 失败文本翻译而来，界面按码决定提示与补救动作，
// 因此新增码必须同时给出可读的 message，不能只靠 detail 传原文。
// [失败路径] tracked-changes-would-be-overwritten 与 untracked-changes-would-be-overwritten
// 分成两码，因为前者可提示提交或暂存，后者只能提示删除或移动，补救动作不同。
// operation-in-progress 覆盖 merge、rebase、cherry-pick 未结束的情形，此时任何
// 切换都会失败，提前拦下比让 git 抛一堆英文冲突更可控。
// [权衡] unknown 必须始终保留：git 升级会带来新文案，识别不了时宁可退成通用
// 失败，也不要把原始 stderr 直接抛给用户。
export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "unknown";

// [并发] summary 是刷新瞬间的快照，字段之间不保证时间一致：ahead、behind 与
// 改动列表分两次读取 git，用户在此期间提交就会让两者错位，因此不能拿它做
// 提交前置校验，只能用于展示。
// isDirty 只表达已跟踪文件在索引或工作区的改动而不含未跟踪文件，避免构建产物
// 让界面永久显示脏状态（dist/build 之类产物不该点亮徽标）。
// [资源] autoRefreshWatchPaths 只覆盖 git 元数据目录，工作区内容监听由界面按
// 宿主平台另建；这里若把整个仓库根塞进来，大仓库会触发海量文件事件并压满 watcher。
// workspaceInRepoPath 为空串表示 workspace 就是仓库根，不能据此推断不在仓库内。
export interface GitRepositorySummary {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  /** Git 元数据 watcher 边界；workspace 内容 watcher 由 UI 按 workspace Host 平台决定。 */
  autoRefreshWatchPaths: GitRepositoryAutoRefreshWatchPath[];
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  isDirty: boolean;
  isGitAvailable: boolean;
  isRepository: boolean;
}

export interface GitRepositoryAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

// [失败路径] x 与 y 直接对应 porcelain 的两个状态位，而顺序是索引在前、工作区在后，
// 交换后暂存与未暂存会整体颠倒，用户点暂存实际提交的是另一份内容。
// 未跟踪文件只有 y 位，新加入索引的文件 x 为 A 且 y 为空，消费方必须容忍
// 其中一位缺失时消费方必须按空位处理，不要补成空格字符。
// [权衡] 这里保留原始字符而不是把状态枚举化：porcelain 会新增冲突组合，
// 枚举化会把未知字符吞成 modified，界面就再也看不到真实冲突。
// kind 是展示用的粗分类，与 x、y 不构成双射，而重命名可以同时带内容修改。
// 冲突文件不进 staged 与 unstaged，否则同一路径会出现三条可操作项，丢弃时互相覆盖。
export interface GitFileChange {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  x?: string;
  y?: string;
  kind: GitChangeKind;
  section: GitChangeSectionId;
  added: number;
  removed: number;
  isStaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
  sourceId?: GitChangeSourceId;
}

export interface GitDiffResult {
  path: string;
  availability: GitDiffAvailability;
  patch: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  summary?: string | null;
}

export interface GitIdentity {
  userName: string | null;
  userEmail: string | null;
  nameSource: string | null;
  emailSource: string | null;
  scopeLabel?: string | null;
}

export interface GitRepositoryRequest {
  workspacePath: string;
}

export type GitCommitGraphRefKind = "branch" | "remote" | "tag" | "head";

export interface GitCommitGraphRef {
  name: string;
  kind: GitCommitGraphRefKind;
}

// [权衡] 提交图按页取回，hash 与 parents 用完整对象名而非短哈希：短哈希跨页
// 拼接需要前缀补全，一旦出现歧义就会把两个提交连成同一条线。
// refs 覆盖分支、远端、标签与 HEAD 四类，同一提交上可同时存在多个，
// 界面必须全部展示，只取第一个会漏掉标签或远端分支。
// [失败路径] authorName 与 authoredAtMs 允许为 null：编码损坏或时区缺失的提交
// 仍要能画出来，缺字段只影响气泡文案，不能让整页取图失败。
// subject 只取首行主题，正文不在本结构里；需要正文时必须另发请求，
// 不能在这里按长度截断，否则主题与正文的边界会被误当成省略。
export interface GitCommitGraphCommit {
  hash: string;
  parents: string[];
  refs: GitCommitGraphRef[];
  subject: string;
  authorName: string | null;
  authoredAtMs: number | null;
}

export interface GitCommitGraphRequest extends GitRepositoryRequest {
  maxCount?: number;
  skip?: number;
}

export interface GitCommitGraphResult {
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
}

export interface GitRefreshRequest extends GitRepositoryRequest {
  includeIdentity?: boolean;
  includeBranchComparison?: boolean;
}

export type GitWorkspaceRepositoryKind = "not-repository" | "main-tree" | "linked-worktree";

export interface GitWorkspaceRepositoryInfo {
  workspacePath: string;
  kind: GitWorkspaceRepositoryKind;
  isGitAvailable: boolean;
}

export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}

export interface GitChangesRequest extends GitRepositoryRequest {
  sourceId: Extract<GitRepositoryChangeSourceId, "unstaged" | "staged">;
}

export interface GitIgnoredPathsRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiffQuery extends GitRepositoryRequest, GitDiffRequest {}

// [失败路径] baseRef 与 headRef 都可以为 null：仓库还没有远端分支，或本地分支
// 尚未建立 upstream 时，比较结果不存在，而不是零改动。
// comparisonLabel 是给界面直接显示的比较说明，已由服务端带好方向与远端名，
// 界面不要再自行拼接 base 与 head，否则会出现重复的远端前缀。
// [权衡] 比较结果带完整 changes 而不是只给计数：分支视图要能直接丢弃与查看
// 单文件 diff，二次请求会按路径重算，期间分支变化会得到两份不一致的结果。
// GitBranchComparison 只在显式请求时计算，默认刷新不带，否则大分支差异会拖慢首屏。
export interface GitBranchComparison {
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitFileChange[];
}

export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
}

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}

export interface GitPathMutationRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiscardPathsRequest extends GitPathMutationRequest {
  staged?: boolean;
}

export interface GitCommitRequest extends GitRepositoryRequest {
  message: string;
  paths?: string[];
  stagedOnly?: boolean;
}

export interface GitCommitResult {
  commitHash: string;
  summary: GitRepositorySummary;
}

export interface GitGenerateCommitMessageRequest extends GitRepositoryRequest {
  workspaceIdentity?: string;
  locale?: Locale;
  includeUnstaged?: boolean;
  currentSessionFilePaths?: string[];
  conversationContext?: GitCommitMessageConversationContext;
}

export interface GitCommitMessageConversationContext {
  sessionId?: string;
  omittedMessageCount?: number;
  messages: GitCommitMessageConversationMessage[];
}

export interface GitCommitMessageConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GitGenerateCommitMessageResult {
  message: string;
  providerId: string;
  model: string;
}

export interface GitPushRequest extends GitRepositoryRequest {}

export interface GitPushResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  setUpstream: boolean;
  summary: GitRepositorySummary;
}

export interface GitRefreshResult {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison | null;
}

export type GitCheckpointScope = "workspace";

export type GitCheckpointConflictReason =
  | "content-mismatch"
  | "missing-in-worktree"
  | "unexpected-file-in-worktree"
  | "type-mismatch";

export interface GitCheckpointMeta {
  checkpointId: string;
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  createdAt: number;
  refName: string;
  commitOid: string;
  scope: GitCheckpointScope;
}

export interface GitCheckpointRequest extends GitRepositoryRequest {
  checkpointId: string;
}

export interface GitCheckpointDiffQuery extends GitRepositoryRequest {
  fromCheckpointId: string;
  toCheckpointId: string;
}

export interface GitCheckpointFileDiff {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  originalPath?: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

export interface GitCheckpointDiff {
  fromCheckpointId: string;
  toCheckpointId: string;
  files: GitCheckpointFileDiff[];
}

export interface GitCheckpointRestoreQuery extends GitCheckpointDiffQuery {
  force?: boolean;
}

// [失败路径] reason 决定自动恢复能否继续：content-mismatch 可覆盖，
// missing-in-worktree 与 unexpected-file-in-worktree 只能跳过，type-mismatch 必须中止。
// 三种都退化成通用冲突，会让恢复流程对目录与文件互换的位置直接覆盖，
// 会导致不可逆的数据丢失。
// [资源] 冲突列表只为用户确认而存在，不持有工作区句柄；确认后按路径逐个写回，
// 中途失败已写回的路径不回滚，界面必须按 restoredPaths 展示部分成功。
// force 为真只跳过冲突检查，不改变写入顺序与失败语义。
export interface GitCheckpointConflict {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  reason: GitCheckpointConflictReason;
}

export interface GitCheckpointRestoreResult {
  success: boolean;
  conflicts?: GitCheckpointConflict[];
  restoredPaths?: string[];
}
