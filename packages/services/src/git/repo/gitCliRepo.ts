// 模块职责：Git CLI 仓库门面（GitCliRepo 的实现）。对外提供状态快照、分支操作、diff、
// 暂存/提交/推送等能力，对内把每个能力翻译成一组 git 子进程调用并聚合成领域类型。
// 本文件只做编排：命令拼装、并发复用、缓存失效、失败降级；解析与文案归一放在 gitCliHelpers。
//
// INV 不变量表（每条都跨函数生效，破坏后通常不抛错，而是给出一个看起来合理的错误结论）：
// INV-01：命令的 cwd 只能是 repoRoot 或 workspacePath，绝不依赖进程 cwd（executeGitStatus 等全部 run 调用）；
//         破坏后果：多窗口/多工作区下命令落到别的仓库，读写错误的树。
// INV-02：路径参数必须经 normalizeInputPath 归一，且 argv 中以 `--` 与选项分隔（stage/unstage/discard/commit）；
//         破坏后果：以 `-` 开头的路径被 Git 当成选项，执行非预期操作。
// INV-03：外部输入（branch/startPoint/commit message）同样要保证位置语义（createBranchAndSwitch 的 `--`）；
//         破坏后果：伪装成选项的分支名篡改命令语义，例如把 switch 变成强制切换。
// INV-04：写操作成功后必须 invalidate(workspacePath)（switchBranch/createBranchAndSwitch/stage/unstage/discard/commit/push）；
//         破坏后果：后续 getStatus 命中旧快照，UI 长时间显示切换前的分支与改动。
// INV-05：同一 workspacePath 的并发只读请求复用同一个 Promise（reuseInFlightRequest）；
//         破坏后果：一轮刷新触发多次 status+numstat，IO 放大且结果互相不一致。
// INV-06：status 与两条 numstat 必须来自同一轮 Promise.all（getStatus）；
//         破坏后果：条目与行数取自不同时间点，UI 出现「有文件无统计」的错配。
// INV-07：patch 成功时不得因全文读取失败而丢弃结果（withDiffContents）；
//         破坏后果：预览不可用连带整块 diff 消失。
// INV-08：stagedOnly 提交使用临时 GIT_INDEX_FILE，真实索引只做定向 reset（commit 的临时索引分支）；
//         破坏后果：用户其它已暂存文件被一并提交，或从真实索引中丢失。
// INV-09：临时索引目录必须在 finally 中递归删除（commit 的 tempIndexDir）；
//         破坏后果：每次定向提交在系统临时目录残留一份 index 副本。
// INV-10：未跟踪目录折叠状态按 repoRoot 记忆且不随 invalidate 清除（collapsedUntrackedRepoRoots）；
//         破坏后果：每个刷新周期重复执行一次必然超限的详细 status。
/* eslint-disable max-lines */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  GitBranchMutationAction,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitCommitGraphCommit,
  GitCommitGraphRef,
  GitDiffQuery,
  GitDiffResult,
  GitIdentity,
  GitLocalBranch,
  GitLocalBranchListResult,
  GitWorkspaceRepositoryInfo,
  GitPushResult,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_DIFF_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_TIMEOUT_MS,
  getGitNullDevicePath,
  normalizeGitPath,
  normalizeWorkspaceInRepoPath,
} from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import {
  buildUntrackedTextDiffResult,
  buildUntrackedStats,
  ensureGitCommandSucceeded,
  ensureRepositoryAvailable,
  fileExists,
  inferKindFromNumstat,
  isMissingWorkingDirectoryResult,
  isNotRepositoryResult,
  normalizeInputPath,
  parseGitBranchMutationIssues,
  parseGitConfigValue,
  parseNumstat,
  parseStatusPorcelain,
  toInvalidBranchNameIssue,
  toDiffResult,
} from "./gitCliHelpers.js";
import {
  createEmptySummary,
  type GitBranchComparisonChange,
  type GitBranchComparisonSnapshot,
  type GitCliRepo,
  type GitCommitGraphSnapshot,
  type GitResolvedRepository,
  type GitStatusSnapshot,
} from "./gitCliTypes.js";

// 类型再导出：消费方只依赖 gitCliRepo 这一个入口，
// 内部实现文件（gitCliTypes）可以继续拆分而不破坏导入路径。
// 只导出类型不导出值，避免把类型层的实现细节带进运行时依赖图。
export type {
  GitBranchComparisonChange,
  GitBranchComparisonSnapshot,
  GitCliRepo,
  GitLineStat,
  GitResolvedRepository,
  GitStatusEntry,
  GitStatusSnapshot,
} from "./gitCliTypes.js";

// diff 面板的降级形态统一构造在这里，而不是抛错：Git 缺失、非仓库、路径越界
// 都属于「这个文件暂时没有 diff」，抛错会让整个改动列表一起失败。
// path 用绝对路径回填，前端据此定位行；summary 说明降级原因。
function toUnavailableDiff(path: string, summary: string): GitDiffResult {
  // 做什么：把“取不到 diff”的几种原因收敛成同一种结构化结果，而不是抛异常。
  // 前置条件：path 已由调用方还原成绝对路径；前端用它回填文件树行号，
  // 若这里传仓库相对路径，前端会再按工作区拼一次，定位落到另一个文件上。
  // 降级选择：Git 缺失、非仓库、路径越界都返回 unavailable，
  // 因为这些只是“这个文件暂时没有 diff”，抛错会让整份改动列表一起渲染失败。
  return {
    path,
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    summary,
  };
}

// 全文预览内容总是成对出现：只有 before/after 都拿到，才能合成一份完整的
// MultiFileDiff；单侧内容会被 toCompleteDiffContents 直接丢弃，避免误渲染。
interface GitDiffContents {
  beforeContent: string;
  afterContent: string;
}

function toCompleteDiffContents(
  beforeContent: string | null,
  afterContent: string | null,
): GitDiffContents | null {
  // 完整 diff 的任一侧读取失败后若被补成空字符串，UI 会把“不可读”误判成
  // “文件为空”，进而把整个文件渲染成新增或删除。完整内容对必须一起成功或一起降级。
  if (beforeContent === null || afterContent === null) {
    return null;
  }

  return { beforeContent, afterContent };
}

// 这些是 .git 目录下代表「某个操作未收尾」的标记文件/目录。
// 用文件存在性判断进行中操作，比解析 stderr 稳定：报错文案随版本变化，
// 而 merge/rebase/cherry-pick 的标记布局多年未变。列表顺序即 rev-parse 的输出顺序，
// 与 markerExists 的下标无关（只做 some），调整顺序不会影响结论。
const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
] as const;

// 分页上限放在本文件而不是 config：Graph 是纯展示入口，属于 UI 契约的一部分。
// 默认 100 是「一次请求足够填满视口」与「单次 git log 耗时」之间的折中；
// 上限 200 防止外部传入极大值把一次渲染变成全历史遍历。
const DEFAULT_GIT_GRAPH_MAX_COUNT = 100;
const MAX_GIT_GRAPH_MAX_COUNT = 200;
const GIT_GRAPH_RECORD_SEPARATOR = "\x1e";
const GIT_GRAPH_FIELD_SEPARATOR = "\x00";
const log = createServiceLogger("git-repo");

// 去掉尾部分隔符再比较，否则 `/repo/.git` 与 `/repo/.git/` 会被当成两个 watcher，
// 导致重复监听同一目录。根路径必须原样保留：`/` 与 `C:\` 去掉尾分隔后
// 会变成空串或盘符，watcher 会因此拒绝启动或监听到错误目录。
function normalizeWatchPath(path: string): string {
  // 做什么：把 watcher 路径归一成唯一 key，去掉首尾空白与末尾目录分隔符。
  // 为什么必须这样：`/repo/.git` 与 `/repo/.git/` 会被当成两条记录，
  // 同一目录挂两个 watcher，refs 变化时刷新被重复触发。
  // 前置条件：根路径不能去尾分隔，`/` 会变成空串、`C:\` 只剩盘符，
  // watcher 会因此拒绝启动或监听到错误目录，所以下面单列一条特判。
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

// 去重按「归一化后的路径」全等比较，不做前缀归并：
// gitCommonDir 常常就是 absoluteGitDir 的父级或同一目录，
// 若按包含关系去重会漏掉真正的独立目录，auto refresh 就收不到 refs 变化。
function addAutoRefreshWatchPath(
  paths: GitResolvedRepository["autoRefreshWatchPaths"],
  path: string,
  recursive: boolean,
): void {
  // 做什么：归一化后按全等去重，把一条监听路径追加进列表。
  // 去重不能改成前缀或包含判断：gitCommonDir 常与 absoluteGitDir 同目录或互为父级，
  // 按包含关系去重会漏掉真正独立、需要监听的目录，refs 变化后界面不刷新且没有报错。
  const normalizedPath = normalizeWatchPath(path);
  // 空路径必须丢弃：rev-parse 偶发返回空字段，空 key 会让 watcher 监听进程 cwd。
  if (!normalizedPath || paths.some((entry) => entry.path === normalizedPath)) {
    return;
  }

  // recursive 由调用方给出：Git 元数据层级固定，统一递归，漏掉子目录会静默漏刷新。
  paths.push({
    path: normalizedPath,
    recursive,
  });
}

function buildAutoRefreshWatchPaths(params: {
  workspacePath: string;
  absoluteGitDir: string;
  gitCommonDir: string;
}): GitResolvedRepository["autoRefreshWatchPaths"] {
  const paths: GitResolvedRepository["autoRefreshWatchPaths"] = [];
  // Linux 上对 workspacePath 做 recursive fs.watch 会为整棵 workspace
  // 分配 watcher；慢挂载或大型生成目录会阻塞 workspace Host。workspace 内容 watcher
  // 由 UI 按 workspace Host 平台决定，这里只输出 Git 元数据边界。

  // Git 元数据可能在 linked worktree 或 separate git-dir 中位于 repoRoot 之外。
  // UI 只知道工作区路径，不能猜 `.git` 布局；这里用 Git 自身解析出的目录作为刷新边界。
  addAutoRefreshWatchPath(paths, params.absoluteGitDir, true);
  const resolvedCommonDir = params.gitCommonDir
    ? isAbsolute(params.gitCommonDir)
      ? params.gitCommonDir
      : // `git rev-parse --git-common-dir` 的相对结果以命令 cwd 为基准，
        // 子目录 workspace 若误用 repoRoot 会把 `/root` + `../.git` 解析成 `/.git`。
        resolve(params.workspacePath, params.gitCommonDir)
    : params.absoluteGitDir;
  addAutoRefreshWatchPath(paths, resolvedCommonDir, true);

  return paths;
}

// 只检查是否含 NUL：Git 自身也以 NUL 判定二进制，保持一致可以避免
// patch 报告 binary、预览却按文本渲染的自相矛盾。
function isPreviewableText(content: string): boolean {
  return !content.includes("\0");
}

// 工作区一侧的全文预览：体积上限复用 DEFAULT_GIT_DIFF_BYTES，
// 保证「能生成 patch」与「能加载全文」是同一个阈值，避免二者互相矛盾。
// 返回 null 表示不可预览，调用方会关闭 MultiFileDiff 而保留 patch。
async function readWorkingTreePreviewContent(absolutePath: string): Promise<string | null> {
  // 做什么：读工作区文件的全文，作为 unstaged diff 的 after 侧。
  // 体积上限复用 diff 预算，保证“能出 patch”与“能加载全文”是同一阈值，
  // 否则会出现 patch 成功但预览永远不可用的矛盾状态。
  try {
    const fileStat = await stat(absolutePath);
    // 目录、设备文件与超限文件都不可预览：读目录会抛 EISDIR，读大文件会拖住主进程。
    if (!fileStat.isFile() || fileStat.size > DEFAULT_GIT_DIFF_BYTES) {
      return null;
    }

    const content = await readFile(absolutePath, "utf-8");
    return isPreviewableText(content) ? content : null;
  } catch {
    // 文件删除和原子保存窗口都会让 stat/readFile 失败；这里不能猜成合法空文件。
    return null;
  }
}

// 用 `git show <ref>:<path>` 取某一版本的文件内容，ref 为空串时是 `:path`，
// 即索引（stage 0）里的版本，用于「已暂存」一侧的比较。
// 失败、超时、截断、二进制全部收敛成 null：这只是预览增强，
// 任何异常都不应让外层已经成功的 patch 结果变成错误。
async function readGitBlobPreviewContent({
  commandProvider,
  repoRoot,
  ref,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  ref: string;
  repoRelativePath: string;
}): Promise<string | null> {
  // 做什么：取某一版本的文件全文，ref 为空串时拼出 `:path`，即索引 stage 0 的版本。
  // 为什么按 ref 取而不是直接读工作区：两侧基准由调用方决定，
  // 这里自己猜来源会让预览与 patch 的基准错位。
  // 前置条件：repoRelativePath 必须是仓库相对路径，`git show` 不接受绝对路径。
  const result = await commandProvider.run({
    cwd: repoRoot,
    // ref 与路径用冒号连成一个参数，不能拆成两个，也不能加 `--`：
    // 拆开后 Git 会把路径当成第二个对象名，加分隔符则改变 `<ref>:<path>` 的语义。
    args: ["show", `${ref}:${repoRelativePath}`],
    timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
  });

  if (
    // 四类失败都归为 null：超时、输出截断、非 0 退出、含 NUL 的二进制内容。
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode !== 0 ||
    !isPreviewableText(result.stdout)
  ) {
    return null;
  }

  // 走到这里说明内容完整且可预览，调用方据此决定是否渲染全文对比。
  return result.stdout;
}

// 分支比较的 before 侧取 merge-base 而不是 upstream 本身：
// 直接用 upstream 会把「远端已有、本地尚未合并」的其它提交算成本地删除。
// [失败路径] merge-base 在无共同祖先时退出码非 0、stdout 为空，此时退回 upstream；
// 宁可少算一次合并点，也不能让 before 侧变成 null 而丢掉整份全文预览。
async function readBranchDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
  trackingBranchName,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
  trackingBranchName: string;
}): Promise<GitDiffContents | null> {
  // 做什么：branch 来源取 before=merge-base(upstream, HEAD)、after=HEAD 两侧全文。
  // 为什么先求合并点：直接拿 upstream 会把“远端已有、本地未合并”的提交算成本地删除，
  // 用户会看到自己从未改过的文件出现在差异列表里。
  const mergeBaseResult = await commandProvider.run({
    cwd: repoRoot,
    args: ["merge-base", trackingBranchName, "HEAD"],
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  });
  // 失败降级：无共同祖先时 merge-base 退出码非 0、stdout 为空，退化为空串即可，
  // 由下面回退到 upstream；宁可少算一次合并点，也不能让 before 侧变 null 丢掉整份预览。
  // 成功时必须 trim：stdout 带尾随换行，直接拼进 `ref:path` 会让 Git 找不到对象。
  const mergeBase = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : "";
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    // 回退链：能定位合并点就用它，否则用 upstream 本身，保证 before 侧尽量有值。
    ref: mergeBase || trackingBranchName,
    repoRelativePath,
  });
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

// 已暂存：before=HEAD，after=索引（ref 为空串）。
// 这里不读工作区文件，因为工作区可能已有未暂存的新改动，
// 混进来会让 staged diff 的 after 侧与 patch 不一致。
async function readStagedDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  // 做什么：已暂存一侧的全文，before=HEAD、after=索引（ref 传空串）。
  // 不能读工作区文件：工作区可能已有未暂存的新改动，混进来会让
  // “已暂存”预览的 after 侧与 patch 内容不一致。
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });
  // 空串 ref 拼出的是 `:path`，这是 Git 表示索引 stage 0 的固定写法；
  // 若误传 HEAD，两侧内容相同，预览永远显示无差异。
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

// 未暂存：before=索引（ref 为空串），after=工作区文件。
// 两侧顺序与 `git diff` 的语义严格一致；反了会让整份 diff 的增删方向倒置。
async function readUnstagedDiffContents({
  absolutePath,
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  absolutePath: string;
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  // 做什么：未暂存一侧的全文，before=索引、after=工作区文件。
  // 顺序必须与 `git diff`（无 --cached）一致：反了会让增删方向整体倒置，
  // 用户看到的是“刚删掉的代码被当成新增”。
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });
  // 工作区侧交给 readWorkingTreePreviewContent：体积、二进制与文件缺失由它判定，
  // 失败返回 null，下面统一收敛，不需要这里再写 try/catch。
  const afterContent = await readWorkingTreePreviewContent(absolutePath);

  return toCompleteDiffContents(beforeContent, afterContent);
}

// 只有 patch 形态才附加全文：binary/truncated/unavailable 附加内容没有意义，
// 反而可能让前端误判为可做双向差异。contents 为 null 时原样返回 patch。
function withDiffContents(diff: GitDiffResult, contents: GitDiffContents | null): GitDiffResult {
  // 做什么：只在 patch 形态上附加 before/after 全文，其余形态原样返回。
  // 只有 patch 才能双向渲染；binary/truncated/unavailable 附加内容没有意义，
  // 反而会让前端误以为可以做逐行对比。
  if (diff.availability !== "patch") {
    return diff;
  }

  if (!contents) {
    // Git patch 已经成功生成时，全文预览失败只应关闭 MultiFileDiff，不能把正确 patch 一并丢弃。
    return diff;
  }

  return {
    // 用展开保留 availability 与 patch，只叠加两侧全文，
    // 重新构造对象会丢掉 toDiffResult 已算好的降级信息。
    ...diff,
    beforeContent: contents.beforeContent,
    afterContent: contents.afterContent,
  };
}

// 失败结果必须携带 summary：UI 依据它刷新脏状态与当前分支，
// 失败路径若省略 summary，前端会退回上一次快照，看起来像是操作没有发生。
function toBranchMutationFailure(params: {
  action: GitBranchMutationAction;
  branchName: string | null;
  created?: boolean;
  summary: GitStatusSnapshot["summary"];
  issues: GitBranchMutationIssue[];
}): GitBranchMutationResult {
  return {
    ok: false,
    action: params.action,
    branchName: params.branchName,
    didChange: false,
    // 失败时 didChange 恒为 false：即使分支已建好但切换失败，也不能让前端以为已切换，
    // 否则它会跳过重新取状态，界面停在错误的分支上。
    // summary 必须由调用方传入当前快照：缺省会让前端退回上一次快照，看起来像操作没发生。
    created: params.created ?? false,
    summary: params.summary,
    // issues 必须非空且带具体 code，前端按 code 选提示文案；空数组会让失败态没有解释。
    issues: params.issues,
  };
}

function toBranchMutationSuccess(params: {
  action: GitBranchMutationAction;
  branchName: string;
  didChange: boolean;
  created: boolean;
  summary: GitStatusSnapshot["summary"];
}): GitBranchMutationResult {
  return {
    ok: true,
    action: params.action,
    branchName: params.branchName,
    // didChange=false 表示“目标分支已经是当前分支”，调用方不必再取状态，
    // 避免一次多余的状态快照与写缓存。
    // created 只由 create-and-switch 置 true；switch 路径必须保持 false，否则会提示“已创建”。
    didChange: params.didChange,
    created: params.created,
    summary: params.summary,
    // 成功路径固定空数组，避免把上一次失败的 issue 带到这次结果里。
    issues: [],
  };
}

// for-each-ref 的格式在调用处用 %00 分隔四个字段，因此这里按 NUL 切；
// 换行还可能是 CRLF，先归一再去空行，否则会出现名为 "\r" 的伪分支。
// 排序规则是契约的一部分：当前分支置顶，其次按提交时间倒序，最后按名称字典序，
// 这样同时间戳（批量导入）下顺序仍然稳定，避免列表每次刷新都抖动。
// 时间戳解析失败给 null 而不是 0：0 会被排到 1970 年，把坏数据挤到末尾是更安全的默认。
function parseBranchRefRecords(stdout: string, currentBranchName: string | null): GitLocalBranch[] {
  // 做什么：解析 for-each-ref 的多行输出，排序后返回本地分支列表。
  // 分隔约定：调用处的格式串用 %00 分隔四个字段，这里必须按 NUL 切；
  // 改成按空白切的话，分支名或 upstream 含空格时字段会整体错位。
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): GitLocalBranch | null => {
      // 字段顺序与格式串一一对应；少一个 %00 会把时间戳读成 commitHash。
      const [name, upstreamName, commitHash, commitTimestamp] = line.split("\0");
      // 空名字无法构造分支对象，返回 null 交给下面的 filter，而不是造一个空名分支。
      if (!name) {
        return null;
      }

      // 解析失败给 NaN 而不是 0：0 会排到 1970 年，把坏数据挤到列表中间。
      const timestampSeconds = commitTimestamp ? Number.parseInt(commitTimestamp, 10) : Number.NaN;
      return {
        name,
        // 用调用方给出的当前分支名比较，不再问 Git，避免两份结论出现时间差。
        isCurrent: name === currentBranchName,
        // upstream:short 为空表示未设置上游，归一成 null，前端才能区分“无”与“空串”。
        upstreamName: upstreamName || null,
        commitHash: commitHash || null,
        commitTimestampMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    // 显式类型收敛，后续 sort 就不必再判空。
    .filter((branch): branch is GitLocalBranch => Boolean(branch))
    .sort((left, right) => {
      // 排序是契约的一部分：`isCurrent` 为真的分支置顶，用户打开列表第一眼就能确认所在分支。
      if (left.isCurrent !== right.isCurrent) {
        return left.isCurrent ? -1 : 1;
      }

      // 缺失时间戳用负无穷参与比较，保证坏数据排在最后，而不是插到正常历史中间。
      const leftTimestamp = left.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      const rightTimestamp = right.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      // 按提交时间倒序；同一秒的批量导入再按名字兜底，保证刷新时顺序不抖动。
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      // 名称比较放在最后一级，避免同时间戳时顺序随 Map 插入顺序变化。
      return left.name.localeCompare(right.name);
    });
}

// 外部可能传入 undefined、NaN、Infinity 或小数，全部在这里收敛：
// 非有限值回默认，有限值先 floor 再夹到 [1, 200]，保证生成的 `--max-count` 合法。
function normalizeGitGraphMaxCount(maxCount: number | undefined): number {
  // 做什么：把外部传入的分页条数收敛成 1..200 的整数。
  // undefined/NaN/Infinity 回默认 100；有限值先 floor 再夹范围，
  // 保证拼进 `--max-count=` 的永远合法，极大值不会把一次渲染变成全历史遍历。
  if (typeof maxCount !== "number" || !Number.isFinite(maxCount)) {
    return DEFAULT_GIT_GRAPH_MAX_COUNT;
  }

  // 上界用常量而不是不设限：Graph 属于 UI 入口，单次 git log 耗时必须有上限。
  return Math.min(MAX_GIT_GRAPH_MAX_COUNT, Math.max(1, Math.floor(maxCount)));
}

function normalizeGitGraphSkip(skip: number | undefined): number {
  // 做什么：把分页偏移收敛成非负整数。
  // 负数会被 Git 当成非法参数直接失败，NaN/Infinity 则会拼出非法字符串。
  if (typeof skip !== "number" || !Number.isFinite(skip)) {
    return 0;
  }

  // 只夹下界不设上界：跳过量由调用方按已加载条数决定，截断它会导致分页错位。
  return Math.max(0, Math.floor(skip));
}

// 同一次 decoration 里 `HEAD -> main` 会同时产生 head 与 branch 两条，
// 而多个 ref 指向同一提交时也可能重复；按 kind+name 去重避免前端重复绘制标签。
function addGitGraphRef(refs: GitCommitGraphRef[], ref: GitCommitGraphRef): void {
  // 做什么：按 kind+name 去重后追加 ref。
  // 同一次 decoration 里 `HEAD -> main` 会同时产生 head 与 branch，
  // 多个 ref 指向同一提交时也会重复；只按 name 去重会让同名分支与标签互相吞掉。
  // 用线性查找而不是 Set：单条提交的 ref 通常个位数，额外编码 key 不划算。
  if (refs.some((candidate) => candidate.kind === ref.kind && candidate.name === ref.name)) {
    return;
  }

  refs.push(ref);
}

// decoration 的形态有三种：`tag: v1`、完整 refname（refs/heads、refs/remotes、refs/tags）、
// 以及没有命名空间的短名。前两种必须剥掉命名空间前缀，否则分支列表里会出现
// `refs/heads/main` 这种只在内部存在的名字。最后一条兜底按是否含 `/` 猜远端，
// 这是显示层的启发式：猜错的代价只是图标不对，不会影响 git 侧行为。
function parseGitGraphDecorationRef(rawRef: string): GitCommitGraphRef | null {
  // 做什么：把 %D 里的一个 decoration 片段解析成 {name, kind}，识别不了返回 null。
  // decoration 有三种形态：`tag: v1`、完整 refname、以及没有命名空间的短名；
  // 前两种必须剥前缀，否则分支列表会出现 `refs/heads/main` 这种内部名字。
  // 前置条件：输入可能带首尾空白，先 trim，否则短名会带尾空格而无法与分支名相等。
  const ref = rawRef.trim();
  // 空片段直接丢弃：无 decoration 时 %D 为空串，不能造出一个空名 ref。
  if (!ref) {
    return null;
  }

  // HEAD 是游离指针，单列一种 kind，前端据此画成空心标记。
  if (ref === "HEAD") {
    return { name: "HEAD", kind: "head" };
  }

  // `tag: v1` 是 %D 对轻量标签的写法，前缀含冒号与空格，剥掉后仍可能带 refs/tags/。
  const tagPrefix = "tag: ";
  if (ref.startsWith(tagPrefix)) {
    const tagRef = ref.slice(tagPrefix.length).trim();
    const name = tagRef.startsWith("refs/tags/") ? tagRef.slice("refs/tags/".length) : tagRef;
    return name ? { name, kind: "tag" } : null;
  }

  // 完整 refname 逐种剥前缀，顺序无所谓，但必须先于末尾的短名启发式。
  if (ref.startsWith("refs/heads/")) {
    const name = ref.slice("refs/heads/".length);
    return name ? { name, kind: "branch" } : null;
  }

  if (ref.startsWith("refs/remotes/")) {
    const name = ref.slice("refs/remotes/".length);
    return name ? { name, kind: "remote" } : null;
  }

  if (ref.startsWith("refs/tags/")) {
    const name = ref.slice("refs/tags/".length);
    return name ? { name, kind: "tag" } : null;
  }

  // 兜底启发式：无命名空间时按是否含 `/` 猜远端（如 origin/main）。
  // 允许猜错：代价只是图标不对，不影响 git 侧任何行为，因此不做额外校验。
  return { name: ref, kind: ref.includes("/") ? "remote" : "branch" };
}

// `%D` 输出以逗号分隔，但 `HEAD -> main` 本身含箭头，所以要单独处理：
// 先记 HEAD，再把箭头右侧当作普通 ref 解析，这样 UI 才能同时显示「HEAD」与所在分支。
function parseGitGraphRefs(rawDecorations: string): GitCommitGraphRef[] {
  // 做什么：把 %D 的整串 decoration 拆成 ref 数组。
  // 分隔约定：%D 用逗号连接多个 ref，按逗号切后必须逐项 trim，否则名字带前导空格。
  const refs: GitCommitGraphRef[] = [];
  // HEAD 标记与普通 ref 混在同一串里，必须逐项判断，不能整体按 refname 解析。
  for (const rawDecoration of rawDecorations.split(",")) {
    const decoration = rawDecoration.trim();
    // 连续逗号或首尾逗号会产生空片段，跳过而不是解析成空名 ref。
    if (!decoration) {
      continue;
    }

    // `HEAD -> main` 含箭头，不能用 refname 规则解析：
    // 先记一条 HEAD，再把箭头右侧当普通 ref，UI 才能同时显示两者。
    const headPointer = "HEAD -> ";
    if (decoration.startsWith(headPointer)) {
      addGitGraphRef(refs, { name: "HEAD", kind: "head" });
      const pointedRef = parseGitGraphDecorationRef(decoration.slice(headPointer.length));
      if (pointedRef) {
        addGitGraphRef(refs, pointedRef);
      }
      continue;
    }

    // 普通 ref 交给统一解析，去重由 addGitGraphRef 负责。
    const parsedRef = parseGitGraphDecorationRef(decoration);
    if (parsedRef) {
      addGitGraphRef(refs, parsedRef);
    }
  }

  return refs;
}

// 记录分隔符用 \x1e、字段分隔符用 \x00，二者都不会出现在 commit subject 里；
// 常规的换行/制表符分隔会被多行 commit message 打断。
// parents 以空格分隔（合并提交有多个），空串要过滤后得到空数组。
function parseGitGraphRecords(stdout: string): GitCommitGraphCommit[] {
  // 做什么：按记录分隔符切开 git log 输出，逐条解析成提交。
  // 分隔约定：记录用 \x1e、字段用 \x00，二者都不会出现在 commit subject 里；
  // 换成换行或制表符会被多行 commit message 打断，解析出半条记录。
  return stdout
    // 分隔符是控制字符常量，不能写成换行：subject 里出现换行就会多切一条。
    .split(GIT_GRAPH_RECORD_SEPARATOR)
    // 只去掉分隔符周围的换行与空白，不碰字段内部内容。
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record): GitCommitGraphCommit | null => {
      // 字段顺序与 --format 串一一对应，错位会把 subject 读成作者名。
      const [hash, parents, authorName, authoredAtSeconds, subject, decorations] =
        record.split(GIT_GRAPH_FIELD_SEPARATOR);
      // 无 hash 的记录没有身份，返回 null 交给外层过滤。
      if (!hash) {
        return null;
      }

      // 时间戳坏数据同样转成 null，与分支列表保持一致的降级口径。
      const timestampSeconds = authoredAtSeconds
        ? Number.parseInt(authoredAtSeconds, 10)
        : Number.NaN;
      return {
        hash,
        // %P 用空格分隔多个父提交（合并提交有多个），空串过滤后得到空数组。
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        // %D 可能整段缺失，兜底空串，解析结果是空数组而不是 null。
        refs: parseGitGraphRefs(decorations ?? ""),
        // 标题缺失给空串：图上标题列不应出现字符串形式的空值。
        subject: subject ?? "",
        authorName: authorName || null,
        authoredAtMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    // 显式类型收敛，调用方不用再处理 null。
    .filter((commit): commit is GitCommitGraphCommit => Boolean(commit));
}

// upstream 形如 `origin/main`，第一段即远端名。远端名本身不允许含 `/`，
// 所以按首个 `/` 切是安全的；无 upstream 时返回 null 交给调用方决定回退策略。
function parseTrackingRemoteName(trackingBranchName: string | null): string | null {
  const remoteName = trackingBranchName?.split("/")[0]?.trim() ?? "";
  return remoteName.length > 0 ? remoteName : null;
}

// `git remote` 每行一个名字，可能带 CRLF 与空行；这里顺带去掉首尾空白，
// 因为后续会拿名字直接拼成 push 参数，带空格会导致远端匹配失败。
function parseRemoteList(stdout: string): string[] {
  // 做什么：把 `git remote` 的逐行输出解析成远端名数组。
  // 归一换行与首尾空白：CRLF 与手写空格都会让名字与实际远端不相等，
  // 而下面会拿名字直接拼 push 参数，带空格会导致远端匹配失败。
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    // 末尾换行会产生空行；过滤后空数组表示“本地仓库未配置远端”，是合法结果。
    .filter((line) => line.length > 0);
}

interface GitIndexEntry {
  mode: string;
  objectHash: string;
  stage: string;
  path: string;
}

// `ls-files --stage -z` 每条是 `mode SP hash SP stage TAB path`。
// 这里选择抛错而不是跳过畸形条目：调用方要用这些条目重建临时索引，
// 少一条就会静默生成一份内容不完整的提交。stage 非 0 表示索引存在冲突，
// 调用方据此拒绝定向提交。
function parseGitIndexEntries(stdout: string): GitIndexEntry[] {
  // 做什么：解析 `ls-files --stage -z` 输出，得到可写回临时索引的条目。
  // 分隔约定：条目以 NUL 结尾，字段间是空格，路径在 TAB 之后；
  // 路径可以含空格，所以必须先按 TAB 切，再对前半段按空白切三列。
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      // 没有 TAB 说明记录畸形；这里抛错而不是跳过，避免静默提交一份不完整的树。
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      // 前半段固定三列：mode、object hash、stage；多列或少列都视为畸形。
      const [mode, objectHash, stage] = record.slice(0, tabIndex).trim().split(/\s+/);
      // 路径统一正斜杠，否则 Windows 上与 status 输出的同一文件无法逐字相等。
      const path = normalizeGitPath(record.slice(tabIndex + 1));
      // 任一字段为空都无法安全重建索引，同样抛错；stage 非 0 留给调用方判冲突。
      if (!mode || !objectHash || !stage || !path) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      // stage 保留原始字符串（"0"/"1"），由调用方判断，不在这里转数字。
      return { mode, objectHash, stage, path };
    });
}

// 工厂而不是类：所有状态都闭包在四个容器里，外部只能通过返回的方法访问，
// 天然避免了「换实例才能清缓存」的问题。
// 四个缓存分别对应：仓库解析、仓库信息、状态快照、未跟踪折叠记忆。
// 前三个以 workspacePath 为 key 并在写操作后失效；最后一个按 repoRoot 记忆，
// 因为同一个仓库可能被多个子目录工作区打开，折叠策略属于仓库属性。
// [权衡] commandProvider 允许注入是为了测试替换进程执行；生产路径永远是真实 CLI。
export function createGitCliRepo(options?: { commandProvider?: GitCommandProvider }): GitCliRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
// 三个 Map 以 workspacePath 为 key：Git 语义只取决于文件系统路径，
// 与业务侧 workspaceIdentity 无关；混用会让同一目录被重复探测。
  const repositoryResolutionRequests = new Map<string, Promise<GitResolvedRepository>>();
  const workspaceRepositoryInfoRequests = new Map<string, Promise<GitWorkspaceRepositoryInfo>>();
  const statusRequests = new Map<string, Promise<GitStatusSnapshot>>();
// 折叠记忆按 repoRoot 而非 workspacePath：同一仓库的多个子目录工作区
// 共享同一份输出上限结论，按工作区记会让每个子目录各自失败一次。
  const collapsedUntrackedRepoRoots = new Set<string>();

// 状态查询的唯一出口，runGitStatus 只负责在超限时换 untrackedMode 再调一次。
// 参数顺序固定为 argv 数组，绝不经 shell 拼接：路径与分支名里可能含空格、引号与 `$`，
// 走 shell 会被二次解释，轻则命令失败，重则执行注入内容。
  function executeGitStatus(resolution: GitResolvedRepository, untrackedMode: "all" | "normal") {
  // 做什么：拼装并执行唯一一条 status 命令，untrackedMode 决定未跟踪项的展开粒度。
  // 参数顺序固定：--porcelain=v2 提供稳定字段，--branch 附带 ahead/behind，
  // -z 用 NUL 分隔条目——路径可能含换行，用换行分隔会把一条记录切碎。
    return commandProvider.run({
      cwd: resolution.repoRoot,
    // 全部走 argv 数组，绝不经 shell 拼接：路径与分支名里的空格、引号、$ 会被二次解释。
      args: ["status", "--porcelain=v2", "--branch", `--untracked-files=${untrackedMode}`, "-z"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
  }

// 详细 status 超出输出上限才降级，且降级结论粘在 repoRoot 上。
// [权衡] 之所以不放大 maxOutputBytes：逐文件未跟踪条目会引出上万个 readFile，
// 上限翻倍只是把失败推后，而代价落在 Host 的内存和句柄上。
  async function runGitStatus(resolution: GitResolvedRepository) {
// 已折叠的仓库直接发 normal，跳过注定超限的详细命令，
// 这是把「一次失败的代价」摊平成「后续零代价」的关键分支。
    const useCollapsedUntracked = collapsedUntrackedRepoRoots.has(resolution.repoRoot);
    const result = await executeGitStatus(resolution, useCollapsedUntracked ? "normal" : "all");
    if (useCollapsedUntracked || !result.outputTruncated) {
      return result;
    }

    // 大仓库的逐文件未跟踪状态可能超过输出上限；直接放大上限会让后续行数统计
    // 并发读取上万个文件。首次超限后按 repoRoot 记住目录折叠模式，既保留可用的 Git
    // 摘要和变更入口，也避免每次自动刷新都重复执行一次必然失败的详细命令。
// 一旦超限就永久折叠该仓库，直到进程重启：
// 这一步把后续每次刷新的「先失败再降级」变成一次命中，
// 代价是即使仓库后来变小也不会恢复详细模式（可接受，反之代价更高）。
    collapsedUntrackedRepoRoots.add(resolution.repoRoot);
    log.warn(
      undefined,
      `git status detailed output exceeded limit; collapsing untracked directories repoRoot=${resolution.repoRoot}`,
    );
    return await executeGitStatus(resolution, "normal");
  }

// [并发] 同一 key 的并发请求共享同一个 Promise，避免渲染时的多路调用各跑一次 git。
// 关键在于 cleanup 必须是「身份比较后再删」：若直接 requests.delete(key)，
// 一个较早的请求结束时会把后来注册的新 Promise 从表里删掉，后续调用就会重复执行，
// 甚至出现新旧两轮结果互相覆盖。
// 失败也要 cleanup（then 的两个回调都传），否则一次失败会让该 workspace 永久命中坏 Promise。
// 不缓存 settled 结果：状态会随文件系统变化，缓存只能覆盖「同一时刻的并发」，不能跨轮次。
  function reuseInFlightRequest<T>(
    requests: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>,
  ): Promise<T> {
  // 做什么：以 key 为粒度复用进行中的 Promise，把并发读请求合并成一次真实调用。
  // 前置条件：factory 必须是只读请求；写操作共用 Promise 会让第二个调用方
  // 拿到第一次的结论，却以为自己的写已经生效。
    const existing = requests.get(key);
    if (existing) {
      return existing;
    }

    // 先注册再挂 cleanup，中间不能有 await：否则两个调用方都会看到空表各起一次。
    const request = factory();
    requests.set(key, request);
    const cleanup = () => {
      // 身份比较后再删：直接 delete 时，较早结束的请求会把后来注册的新 Promise 删掉，
      // 后续调用重复执行，两轮结果还可能互相覆盖。
      if (requests.get(key) === request) {
        requests.delete(key);
      }
    };
    // 成功与失败都清理：否则一次失败会让该 key 永久命中坏 Promise，重试永远失败。
    // 不缓存 settled 结果：状态随文件系统变化，复用只覆盖同一时刻的并发。
    void request.then(cleanup, cleanup);
    return request;
  }

// 三个以 workspacePath 为 key 的缓存必须一起删：只删 status 会让分支操作后的
// 仓库信息（worktree 类型、watch 路径）停留在旧结论上。
// 这里不触碰 collapsedUntrackedRepoRoots：折叠策略按 repoRoot 记录且与写操作无关。
  function invalidate(workspacePath: string): void {
  // 做什么：写操作成功后清掉该 workspacePath 的三份只读缓存。
  // 三份必须一起删：只删 status 会让分支操作后的仓库类型与 watch 路径停留在旧结论。
  // 不触碰折叠记忆：它按 repoRoot 记录且与写操作无关，清掉会让下次刷新重新失败一次。
    repositoryResolutionRequests.delete(workspacePath);
    workspaceRepositoryInfoRequests.delete(workspacePath);
    statusRequests.delete(workspacePath);
  }

// 用 git check-ref-format 而不是自己写正则：分支名规则随 Git 版本演进，
// 自研校验必然出现「我们接受、Git 拒绝」的不一致。
// exitCode=1 表示名字非法，这是正常判定而非命令失败，因此只把 timeout/truncated 交给断言；
// 其余非 0 退出码同样会被映射成 invalid-branch-name，由上层决定提示文案。
  async function validateBranchName(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<GitBranchMutationIssue | null> {
  // 做什么：用 git check-ref-format 判定分支名，非法时返回 issue 而不是抛错。
  // 为什么交给 Git：命名规则随版本演进，自研正则必然出现“我们接受、Git 拒绝”的不一致。
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
    // 不加 `--`：--branch 已声明后面是分支名，加分隔符反而把它变成位置参数。
      args: ["check-ref-format", "--branch", branchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded("git check-ref-format --branch", result);
    }

    // 非 0 统一映射成 invalid-branch-name：stderr 文案不稳定，不适合当判据。
    return result.exitCode === 0 ? null : toInvalidBranchNameIssue(result.stderr);
  }

// 一次 rev-parse 拿到所有标记文件的真实路径（linked worktree 下它们不在 <root>/.git），
// 再并发探测存在性。路径必须是绝对路径，否则 cwd 一换就会探测错位置。
// 标记在操作结束后由 Git 清理，因此这里的结论只对当前时刻有效，不能缓存。
  async function hasOperationInProgress(resolution: GitResolvedRepository): Promise<boolean> {
    // 进行中的 merge / rebase / cherry-pick 在不同 Git 版本上的报错并不完全稳定，
    // 这里先通过 git-dir 标记位做一次轻量探测，让上层能拿到更稳定的阻塞原因。
    const gitPathResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["rev-parse", ...GIT_OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker])],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git rev-parse --git-path", gitPathResult);

// rev-parse --git-path 给出的可能是相对路径（相对命令 cwd），
// 也可能是绝对路径（separate-git-dir）。统一补成绝对路径后再探测，
// 否则一旦后续改了 cwd，存在性判断就会悄悄变成 false。
// 过滤空行是安全的：每个 marker 必有一个输出行，空行只可能来自末尾换行。
    const candidatePaths = gitPathResult.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (isAbsolute(line) ? line : resolve(resolution.repoRoot, line)));

// 并发 stat 多个候选路径，只关心「有没有任意一个存在」：
// some(Boolean) 而不是 find，避免短路导致部分探测 Promise 悬空。
    const markerExists = await Promise.all(candidatePaths.map((path) => fileExists(path)));
    return markerExists.some(Boolean);
  }

// 「可选配置」的三态必须分清：有值 / 无值(exitCode=1) / 命令失败。
// 前两者都返回 null 给调用方继续走回退链，第三者走 ensureGitCommandSucceeded 抛出，
// 否则 Git 不可用时会被误判成「用户没配置」，进而静默套用默认远端。
  async function readOptionalGitConfig(
    resolution: GitResolvedRepository,
    key: string,
  ): Promise<string | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["config", "--get", key],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded(`git config --get ${key}`, result);
    }

    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    }

// config --get 的退出码 1 是「键不存在」的固定答复，必须单独放行：
// 这是调用方最常见的状态（用户未配置），不能让它走统一断言变成异常。
// 其余退出码仍走 ensure，保留真正的配置读取失败。
    if (result.exitCode === 1) {
      return null;
    }

    ensureGitCommandSucceeded(`git config --get ${key}`, result);
    return null;
  }

// remote 列表用于解析推送目标，空数组是合法结果（本地仓库未配置远端），
// 因此这里只断言命令成功，不对内容做任何兜底。
  async function listRemotes(resolution: GitResolvedRepository): Promise<string[]> {
  // 做什么：列出已配置的远端名，供 push 目标解析。
  // 空数组是合法结果（本地仓库未配置远端），因此只断言命令成功，不对内容兜底，
  // 否则纯本地仓库会在刷新链路里被当成失败。
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
    // 不加 -v：只需要名字；带 URL 会多一步解析，还会把认证信息带进日志。
      args: ["remote"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    // 命令失败必须抛错：静默返回空数组会被上层误判成“没配远端”而套用默认值。
    ensureGitCommandSucceeded("git remote", result);
    return parseRemoteList(result.stdout);
  }

// 推送目标的解析顺序与 Git 的默认行为保持一致，逐级回退：
// 1) branch.<name>.remote 是用户显式绑定的上游，优先级最高；
// 2) remote.pushDefault 是仓库级默认；
// 3) 只有一个远端时它没有歧义，可直接用；
// 4) 存在 origin 时优先 origin，这是最常见的约定。
// 有多个远端且没有明确配置时必须抛错而不是猜：猜错会把提交推到错误仓库，
// 这个错误在用户侧几乎不可察觉，代价远高于让用户先补一条配置。
// detached HEAD 或空分支名同样抛错，因为此时拼不出合法的 refspec。
  async function resolvePushRemote(status: GitStatusSnapshot): Promise<string> {
    const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
    const branchName = status.summary.branchName?.trim() ?? "";
    if (branchName.length === 0) {
      throw new Error("Cannot resolve a Git push remote without a current branch.");
    }

// 优先级 1：分支级 remote。注意分支名可含 `/` 与 `.`，
// 直接拼进 config key 是 Git 允许的写法，不需要转义。
// 读到 empty string 时 readOptionalGitConfig 已归一成 null，这里用真值判断即可。
    const branchRemote = await readOptionalGitConfig(resolution, `branch.${branchName}.remote`);
    if (branchRemote) {
      return branchRemote;
    }

// 优先级 2：仓库级 pushDefault。它只影响 push，不影响 fetch，
// 因此不能用 branch.<name>.remote 的缺失来推断它不存在。
    const pushDefaultRemote = await readOptionalGitConfig(resolution, "remote.pushDefault");
    if (pushDefaultRemote) {
      return pushDefaultRemote;
    }

    const remotes = await listRemotes(resolution);
// 有多个远端且无显式配置时选 origin，依据是它在本仓库生态里的事实约定；
// 但只有一个远端的分支更明确，所以那条判断放在前面。
    if (remotes.includes("origin")) {
      return "origin";
    }

    if (remotes.length === 1) {
      return remotes[0]!;
    }

// 零远端与多远端都抛错，但文案必须不同：前者引导用户添加远端，
// 后者引导用户指定 branch.<name>.remote；混用会让用户无从下手。
    if (remotes.length === 0) {
      throw new Error("No Git remote is configured for the current repository.");
    }

    throw new Error(
      "Multiple Git remotes are configured. Configure branch.<name>.remote or remote.pushDefault first.",
    );
  }

  return {
    invalidate,

// 一次 rev-parse 取回四个值，顺序是 --show-toplevel、--show-prefix、
// --absolute-git-dir、--git-common-dir，下面的 lines[0..3] 严格按此顺序消费；
// 多插一个参数或调整顺序会让 repoRoot 与 workspaceInRepoPath 整体错位。
// 缓存 key 用 workspacePath 而不是 workspaceIdentity：Git 语义只与文件系统路径有关，
// 身份标识用于业务隔离，混用会让同一目录在不同 identity 下重复探测。
// Git 不可用时返回 isGitAvailable=false 而不是抛错，让上层统一渲染「无 Git」空态。
    async resolveRepository(workspacePath: string): Promise<GitResolvedRepository> {
      // 启动阶段 summary / changes / branch / identity 会并发读取同一个 workspace，
      // 这里复用进行中的仓库解析，避免一轮刷新里重复执行多次 `git rev-parse`。
      return await reuseInFlightRequest(repositoryResolutionRequests, workspacePath, async () => {
// 先解析 Git 可执行文件再发命令：没有 Git 时不需要 spawn，
// 也避免把「命令不存在」与「仓库有问题」两类失败混在一起。
        const gitBinary = await commandProvider.resolveGitBinary();
        if (!gitBinary) {
          return {
            workspacePath,
            repoRoot: workspacePath,
            workspaceInRepoPath: ".",
            autoRefreshWatchPaths: [],
            isGitAvailable: false,
            isRepository: false,
          };
        }

        const result = await commandProvider.run({
          cwd: workspacePath,
          args: [
            "rev-parse",
            "--show-toplevel",
            "--show-prefix",
            "--absolute-git-dir",
            "--git-common-dir",
          ],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          // 测试/窗口切换时 workspace 目录可能在并发请求过程中被删除（例如临时目录清理）。
          // 之前这里会直接抛错，若调用方是 fire-and-forget 链路就会形成 unhandled rejection，
          // 进而把 Vitest 跑挂成超时。目录缺失不属于“Git 协议失败”，应按“当前非可用仓库”降级返回。
// [失败路径] 目录消失按「非仓库」降级返回，isGitAvailable 仍为 true。
// 这里若抛错，fire-and-forget 的刷新链路会产生 unhandled rejection，
// 在测试环境直接把进程挂成超时；降级返回至少让 UI 有机会自愈。
          if (isMissingWorkingDirectoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

// 非仓库是稳定结论，同样不抛错：工作区随时可能被用户切到非 Git 目录，
// 让 getStatus 抛错会迫使每个调用方各自写 try/catch，错误处理反而更容易漏。
// 注意与上一条的区别仅在 isGitAvailable，它决定 UI 提示「装 Git」还是「初始化仓库」。
          if (isNotRepositoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

          ensureGitCommandSucceeded("git rev-parse", result);
        }

// rev-parse 按参数顺序每行一个结果，因此这里只能按行取值，不能再过滤空行：
// 空的 --show-prefix 结果（工作区就是仓库根）本身占一行，过滤会让后续字段整体上移。
        const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
// [失败路径] toplevel 为空说明 rev-parse 虽退出 0 却没有给出仓库根，
// 这在工作区是裸仓库或输出被截断时可能发生，必须显式抛错而不是继续拼路径。
        const repoRoot = lines[0]?.trim();
// 没有 repoRoot 时后续所有相对路径计算都会以 cwd 为基准，产生错位结果，
// 因此这里宁可失败也不返回一个字段为空的解析结果。
        if (!repoRoot) {
          throw new Error("Failed to resolve Git repository root");
        }

        return {
          workspacePath,
          repoRoot,
          workspaceInRepoPath: normalizeWorkspaceInRepoPath(lines[1] ?? ""),
          autoRefreshWatchPaths: buildAutoRefreshWatchPaths({
            workspacePath,
            absoluteGitDir: lines[2]?.trim() ?? "",
            gitCommonDir: lines[3]?.trim() ?? "",
          }),
          isGitAvailable: true,
          isRepository: true,
        };
      });
    },

// 判定工作区是主树、linked worktree 还是非仓库，只用于「是否参与某些仓库级迁移」这类过滤。
// 判定依据是 .git 的形态：目录即主树（或 separate-git-dir），
// 文件则读首行 gitdir 指向。这个探测不是强一致前置，失败一律 fail-open。
// 缓存按 workspacePath 复用，避免目录树渲染时对同一路径重复 stat。
    async getWorkspaceRepositoryInfo(workspacePath: string): Promise<GitWorkspaceRepositoryInfo> {
      return await reuseInFlightRequest(
        workspaceRepositoryInfoRequests,
        workspacePath,
        async () => {
          const resolution = await this.resolveRepository(workspacePath);
          if (!resolution.isGitAvailable || !resolution.isRepository) {
            return {
              workspacePath,
              kind: "not-repository",
              isGitAvailable: resolution.isGitAvailable,
            };
          }

// 用 repoRoot 而不是 workspacePath 定位 .git：工作区可能是子目录，
// 从子目录找 .git 会得到 ENOENT，进而把所有工作区误判成 main-tree。
          const gitEntryPath = resolve(resolution.repoRoot, ".git");
          try {
// 用 stat 而不是 exists：需要区分「目录」与「文件」两种 .git 形态，
// 前者是普通仓库，后者是 worktree/submodule 的 gitdir 指针。
            const gitEntryStat = await stat(gitEntryPath);
// 目录形态是普通仓库（或 separate-git-dir 的工作区），无需读内容，
// 直接返回 main-tree；提前返回也避免把目录当文件读取而抛错。
            if (gitEntryStat.isDirectory()) {
              return {
                workspacePath,
                kind: "main-tree",
                isGitAvailable: true,
              };
            }

// 只有文件形态才需要读内容；目录形态此时已确定是主树，
// 提前返回可以避免一次无意义的 readFile。
// 读取失败会落到外层 catch 的 fail-open，不影响主功能。
            if (gitEntryStat.isFile()) {
// .git 指针文件很小，一次性读完即可；用 utf-8 是因为内容是文本路径。
// 若读取失败会落到外层 catch 的 fail-open 分支，不影响 Git 主功能。
              const gitEntryContent = await readFile(gitEntryPath, "utf-8");
// .git 文件内容固定是 `gitdir: <path>`，只取首行即可：
// 后续行在部分实现里会带注释或额外字段，一并读取反而破坏 startsWith 判定。
              const firstLine = gitEntryContent.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
              const gitDirPrefix = "gitdir:";
              if (firstLine.startsWith(gitDirPrefix)) {
                const rawGitDir = firstLine.slice(gitDirPrefix.length).trim();
                const resolvedGitDir = rawGitDir
                  ? isAbsolute(rawGitDir)
                    ? rawGitDir
                    : resolve(resolution.repoRoot, rawGitDir)
                  : "";
// 统一成正斜杠后再做结构判断，否则 Windows 路径里的反斜杠会让
// `/.git/worktrees/` 这条特征永远匹配不上。
// 空串表示 gitdir 行不含有效路径，按 main-tree 兜底。
                const normalizedGitDir = resolvedGitDir ? resolvedGitDir.replace(/\\/g, "/") : "";

                // 关键业务逻辑：linked worktree 的 `.git` 文件会指向
                // `<main-tree>/.git/worktrees/<name>`；这里只要命中这个结构就判为 worktree。
                // 其它 `.git` 文件形态（如 submodule / separate-git-dir）一律按 main-tree 放行，
                // 因为迁移过滤不是强依赖，宁可少过滤也不要误杀正常记录。
// 路径统一成正斜杠再比较，否则 Windows 的反斜杠会让这条判定永远不命中，
// 所有 worktree 都被当成 main-tree。submodule 与 separate-git-dir 的 gitdir 不含该段，
// 会落到末尾的 main-tree 兜底，这是有意的保守策略。
                if (normalizedGitDir.includes("/.git/worktrees/")) {
                  return {
                    workspacePath,
                    kind: "linked-worktree",
                    isGitAvailable: true,
                  };
                }
              }
            }
          } catch {
            // 这里的 worktree 识别只用于迁移候选过滤，不是 Git 主功能的强一致前置。
            // 因此遇到 `.git` 缺失、权限异常或非常规布局时，选择 fail-open 当成 main-tree，
            // 避免把本来可迁移的记录误过滤掉。
          }

          return {
            workspacePath,
            kind: "main-tree",
            isGitAvailable: true,
          };
        },
      );
    },

// 一次快照由三条命令组成：status（分支与条目）、staged numstat、unstaged numstat。
// 三者并发而不是串行：它们之间没有依赖，串行会把一次刷新拖成三倍延迟。
// 三条都成功后才解析，任一条失败即整轮失败：混入部分结果会让 UI 的状态自相矛盾。
// 未跟踪行数在解析后单独统计（buildUntrackedStats），因为它需要读文件、成本独立核算。
// isDirty 直接由 entries 推导，不额外调用命令，避免两个数据源给出不同答案。
    async getStatus(workspacePath: string): Promise<GitStatusSnapshot> {
      // staged / unstaged / summary / branch 比较都依赖同一份状态快照，
      // 并发复用可以把一次渲染里的重复 `status + diff --numstat` 合并成一轮 Git CLI 调用。
      return await reuseInFlightRequest(statusRequests, workspacePath, async () => {
        const resolution = await this.resolveRepository(workspacePath);
        if (!resolution.isGitAvailable || !resolution.isRepository) {
          return {
            resolution,
            summary: createEmptySummary(resolution),
            entries: [],
            stagedStats: new Map(),
            unstagedStats: new Map(),
            untrackedStats: new Map(),
          };
        }

// [并发] 三条只读命令并发：它们互不依赖，串行会把一次刷新拖成三倍延迟。
// 全部成功才继续，因此不需要处理「部分成功」的合并语义。
// [权衡] 并发会同时跑三个 Git 进程；对一个工作区来说这点开销远小于串行等待。
// 注意未跟踪行数统计不在这个数组里，它要读文件，单独成本核算。
        const [statusResult, stagedStatsResult, unstagedStatsResult] = await Promise.all([
          // 默认保留逐文件未跟踪状态；只有确认当前 repoRoot 超限后，runGitStatus 才降级为目录折叠。
          runGitStatus(resolution),
          commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["diff", "--cached", "--numstat", "-z", "--find-renames", "--"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          }),
          commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["diff", "--numstat", "-z", "--find-renames", "--"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          }),
        ]);

// 三个断言按「用户最可能关心的顺序」排列：status 失败时先报它，
// 而不是报一条因索引缺失才失败的 numstat。
// 断言放在解析之前，避免对截断输出做解析得到半份条目。
        ensureGitCommandSucceeded("git status", statusResult);
        ensureGitCommandSucceeded("git diff --cached --numstat", stagedStatsResult);
        ensureGitCommandSucceeded("git diff --numstat", unstagedStatsResult);

// 解析放在三条命令都成功之后：提前解析会在后续失败时留下一份半成品结果，
// 调用方若复用这份 entries 就会拿到未统计行数的条目。
        const parsedStatus = parseStatusPorcelain(statusResult.stdout);
// 未跟踪行数需要读工作区文件，成本与 Git 命令不同量级，因此单独 await：
// 放进上面的 Promise.all 会让整轮快照被最慢的一个文件拖住，且错误语义也更难界定。
        const untrackedStats = await buildUntrackedStats(resolution.repoRoot, parsedStatus.entries);

        return {
          resolution,
          summary: {
            workspacePath: resolution.workspacePath,
            repoRoot: resolution.repoRoot,
            workspaceInRepoPath: resolution.workspaceInRepoPath,
            autoRefreshWatchPaths: resolution.autoRefreshWatchPaths,
            branchName: parsedStatus.branchName,
            trackingBranchName: parsedStatus.trackingBranchName,
            headRefType: parsedStatus.headRefType,
            ahead: parsedStatus.ahead,
            behind: parsedStatus.behind,
            isDirty: parsedStatus.entries.length > 0,
            isGitAvailable: true,
            isRepository: true,
          },
          entries: parsedStatus.entries,
          stagedStats: parseNumstat(stagedStatsResult.stdout),
          unstagedStats: parseNumstat(unstagedStatsResult.stdout),
          untrackedStats,
        };
      });
    },

// 批量判断忽略状态：先把每个入参归一成仓库相对路径，越界的直接丢弃（返回 null 后过滤），
// 因为调用方会混入工作区之外的路径，一条越界不该让整批查询失败。
// 返回值回填绝对路径而不是相对路径：文件树按绝对路径建索引。
// check-ignore 的退出码 1 表示「没有一条被忽略」，是正常结果。
// 注意：这里通过 argv 传路径，不能加 -z（-z 只能配合 --stdin），
// 因此必须按换行解析输出；加了 -z 会让命令直接失败。
    async getIgnoredPaths(workspacePath: string, paths: string[]): Promise<string[]> {
      if (paths.length === 0) {
        return [];
      }

      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return [];
      }

// 每个路径独立归一，失败只返回 null：一条越界路径不应让整批 ignored 查询作废。
// 绝对路径与相对路径在这里同时计算，前者用于回填结果，后者交给 check-ignore。
      const inputPairs = await Promise.all(
        paths.map(async (path) => {
          // 每条路径独立归一：越界只让这一条返回 null，不影响整批查询。
          // 绝对路径与仓库相对路径同时算出：前者回填文件树，后者交给 check-ignore。
          try {
            return {
              // 绝对路径只用于结果回填，不参与 Git 命令，避免 Windows 盘符大小写差异。
              absolutePath: isAbsolute(path)
                ? path
                : resolve(resolution.workspacePath, path.split("/").join(sep)),
            // 归一可能抛错（路径越界），由外层 catch 收敛成 null。
              repoRelativePath: await normalizeInputPath(resolution, path),
            };
          } catch {
            return null;
          }
        }),
      );
// 过滤掉归一化失败的项，并显式收敛类型，避免后续 map 里再判空。
      const validInputPairs = inputPairs.filter(
        (pair): pair is { absolutePath: string; repoRelativePath: string } => Boolean(pair),
      );
      if (validInputPairs.length === 0) {
        return [];
      }

// 一次调用判断全部路径：逐条调用会产生 N 次进程启动，
// 而 check-ignore 本身就支持多路径与 -- 终止选项解析。
      const ignoredResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["check-ignore", "--", ...validInputPairs.map((pair) => pair.repoRelativePath)],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });

// 退出码 1 = 全部未命中，必须放在断言之前返回；
// 若先调 ensureGitCommandSucceeded，最常见的情况（没有忽略文件）会被当成错误。
      if (ignoredResult.exitCode === 1) {
        return [];
      }

      ensureGitCommandSucceeded("git check-ignore", ignoredResult);

// 输出只包含「被忽略」的路径，因此用 Set 做存在性判断即可，
// 不需要保留顺序或原始条目。
// 路径统一成正斜杠，才能与 normalizeInputPath 产生的相对路径逐字相等；
// 这一步不能省，否则 Windows 上永远匹配不上。
// 过滤空行的同时不能过滤以空格开头的文件名，因此只过滤整体为空的项。
      const ignoredRepoRelativePaths = new Set(
        ignoredResult.stdout
          // 修复：`git check-ignore -z` 只能和 `--stdin` 一起使用；这里通过 argv 传路径，
          // 所以必须解析普通换行输出，否则命令会直接失败，文件树永远拿不到 ignored 状态。
          .split(/\r?\n/)
          .filter(Boolean)
          .map((path) => path.replace(/\\/g, "/")),
      );

      return validInputPairs
        .filter((pair) => ignoredRepoRelativePaths.has(pair.repoRelativePath))
        .map((pair) => pair.absolutePath);
    },

// 复用 getStatus 而不是再查一次 `git branch`：当前分支与 headRefType 已在状态快照里，
// 复用能保证「列表里的当前分支」与「状态栏显示的分支」永远一致。
// 格式串用 %00 分字段、%（:short）取短名，避免解析 refs/heads/ 前缀。
// detached 时把 currentBranchName 传 null，防止某个同名分支被误标为当前分支。
    async listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult> {
  // 做什么：返回本地分支列表，当前分支直接取自 getStatus。
  // 为什么复用状态快照：再查一次 `git branch` 会引入两份来源，
  // 列表里的当前分支与状态栏可能不同步。
      const status = await this.getStatus(workspacePath);
      // 非仓库或 Git 缺失时返回空列表而不是抛错；headRefType 仍回填，前端据此区分空态。
      if (!status.resolution.isGitAvailable || !status.resolution.isRepository) {
        return {
          headRefType: status.summary.headRefType,
          currentBranchName: status.summary.branchName,
          branches: [],
        };
      }

      const result = await commandProvider.run({
        cwd: status.resolution.repoRoot,
        args: [
          "for-each-ref",
          "refs/heads",
          // 四个字段用 %00 分隔，顺序与 parseBranchRefRecords 严格对应；
          // 取短名与秒级时间戳，避免再剥 refs/heads/ 前缀、也避免时区影响排序。
          "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      // 截断会静默少几条分支，因此失败直接抛错，不返回部分列表。
      ensureGitCommandSucceeded("git for-each-ref refs/heads", result);

      return {
        headRefType: status.summary.headRefType,
        currentBranchName: status.summary.branchName,
        // detached 时传 null：否则某个同名分支会被误标成当前分支。
        branches: parseBranchRefRecords(
          result.stdout,
          status.summary.headRefType === "branch" ? status.summary.branchName : null,
        ),
      };
    },

// 只要用户可见的 refs：显式列出 HEAD/--branches/--tags/--remotes，
// 不用 --all，否则内部的 refs/zcode/checkpoints 会把检查点提交混进可见历史。
// 取 maxCount+1 条用于判断 hasMore，再 slice 回 maxCount；
// 这不是浪费，而是唯一不需要额外 count 命令的分页判据。
// 空仓库的四种报错文案归一成空列表：Git 对「还没有提交」的措辞随版本变化，
// 未命中的话用户看到的是错误而不是空图。
    async getCommitGraph(
      workspacePath: string,
      maxCount?: number,
      skip?: number,
    ): Promise<GitCommitGraphSnapshot> {
  // 做什么：读取可见 ref 的提交图，带 skip/maxCount 两段分页。
  // 只列 HEAD/--branches/--tags/--remotes，不用 --all：
  // 否则 refs/zcode/checkpoints 等内部 ref 会把检查点提交混进用户可见历史。
      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return {
          resolution,
          commits: [],
          hasMore: false,
        };
      }

// 两个分页参数都在发命令前收敛，保证拼出的 --skip/--max-count 一定是非负整数。
      const normalizedMaxCount = normalizeGitGraphMaxCount(maxCount);
      const normalizedSkip = normalizeGitGraphSkip(skip);
      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "log",
          // --all 会把 refs/zcode/checkpoints 等内部 hidden refs 拉进 Git Graph。
          // Graph 只展示用户可见历史，因此限定到 HEAD、分支、标签和远端分支。
          "HEAD",
          "--branches",
          "--tags",
          "--remotes",
          "--date-order",
          "--topo-order",
          `--skip=${normalizedSkip}`,
          // 多取一条用于判断 hasMore，解析后再 slice 回请求条数；
          // 这是唯一不需要额外 count 命令的分页判据。
          `--max-count=${normalizedMaxCount + 1}`,
          "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });

      if (result.exitCode !== 0) {
        // 空仓库的报错文案随 Git 版本变化，四种常见措辞都归一成空列表，
        // 否则用户看到的是错误而不是一张空图。
        const stderr = result.stderr.toLowerCase();
        if (
          stderr.includes("does not have any commits yet") ||
          stderr.includes("your current branch") ||
          stderr.includes("bad default revision") ||
          stderr.includes("ambiguous argument 'head'")
        ) {
          return {
            resolution,
            commits: [],
            hasMore: false,
          };
        }

        ensureGitCommandSucceeded("git log visible refs", result);
      }

// 解析后再切片，因为 hasMore 需要知道「多出来的那一条」是否存在；
// 先切后解析会丢失这个判据，只能再发一次命令统计总数。
      const parsedCommits = parseGitGraphRecords(result.stdout);
      return {
        resolution,
        commits: parsedCommits.slice(0, normalizedMaxCount),
// 用「取回条数 > 请求条数」判断是否还有下一页，
// 这条判据与 slice 共用同一个 normalizedMaxCount，不能各写一份。
        hasMore: parsedCommits.length > normalizedMaxCount,
      };
    },

// 切换前按「冲突 → 进行中操作 → 分支名」的顺序做本地预检，顺序不可调换：
// 冲突与进行中操作是更根本的阻塞原因，先报分支名非法会把用户引向错误方向。
// 目标就是当前分支时直接返回 didChange=false，避免无意义地刷新与写缓存。
// `--no-guess` 禁止 Git 自动创建/匹配同名远端分支，保证「切到不存在的分支」是显式失败。
// 成功后先 invalidate 再重新取状态：顺序反了会把刚失效的旧快照又写回缓存。
    async switchBranch(
      workspacePath: string,
      targetBranchName: string,
    ): Promise<GitBranchMutationResult> {
      const status = await this.getStatus(workspacePath);
      // 做什么：先取当前快照，再按“冲突 → 进行中操作 → 名字”的顺序做本地预检。
      // ensureRepositoryAvailable 在 Git 缺失/非仓库时直接抛错：切换分支没有可降级的形态，
      // 静默返回失败结果会让前端以为只是“没有变化”。
      const resolution = ensureRepositoryAvailable(status.resolution, "switch branches");
      // trim 后再判空：只含空白的名字对 Git 非法，提前返回 issue 比让命令失败更快。
      const normalizedBranchName = targetBranchName.trim();
      if (normalizedBranchName.length === 0) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: null,
          summary: status.summary,
          issues: [toInvalidBranchNameIssue()],
        });
      }

      if (
        // 只有 headRefType=branch 才算“已在目标分支”；detached 时同名分支不能误判。
        status.summary.headRefType === "branch" &&
        // 已经是目标分支时直接成功且 didChange=false，跳过刷新与写缓存。
        status.summary.branchName === normalizedBranchName
      ) {
        return toBranchMutationSuccess({
          action: "switch",
          branchName: normalizedBranchName,
          didChange: false,
          created: false,
          summary: status.summary,
        });
      }

      // 冲突判定来自 porcelain=v2 的 unmerged 记录，属于仓库已知事实；
      // 先于分支名校验返回，避免把用户引向“名字不对”这种错误方向。
      // 这里优先返回当前仓库已知的阻塞状态，避免 UI 只能看到一条模糊的 Git 原生错误。
      if (status.entries.some((entry) => entry.isConflicted)) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "conflicts-present",
              message: "Repository still has unresolved conflicts.",
            },
          ],
        });
      }

      if (await hasOperationInProgress(resolution)) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "operation-in-progress",
              message: "Another Git operation is still in progress.",
            },
          ],
        });
      }

      const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
      if (invalidBranchIssue) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [invalidBranchIssue],
        });
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
// --no-guess 禁止 Git 在本地无同名分支时自动匹配远端分支并创建跟踪：
// 前端展示的只是本地分支列表，隐式创建会凭空多出一个用户没选过的分支。
// 分支名已通过 check-ref-format 校验，且它不可能是选项，故不需要 `--`。
        // 预检全部通过后才发 switch，避免留下“分支已切但校验失败”的中间态。
        // cwd 固定仓库根、参数走 argv 数组：分支名里即使含空格也不会被 shell 拆分。
        args: ["switch", "--no-guess", normalizedBranchName],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        // 失败不是抛错而是结构化结果：Git 的拒绝原因（未跟踪文件会被覆盖等）
        // 由 parseGitBranchMutationIssues 映射成 code，前端才能给出针对性建议。
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: parseGitBranchMutationIssues(result),
        });
      }

      // 顺序不能反：先失效再重取。若先取后失效，刚拿到的新快照会被紧接着删掉，
      // 下一轮又得重跑一遍 status 与 numstat。
      invalidate(workspacePath);
      const nextStatus = await this.getStatus(workspacePath);
      return toBranchMutationSuccess({
        action: "switch",
        branchName: normalizedBranchName,
        didChange: true,
        created: false,
        summary: nextStatus.summary,
      });
    },

// 与 switchBranch 共享「冲突 → 进行中 → 名字」的预检，保证两条路径的报错口径一致。
// startPoint 是可选外部输入，存在时才追加位置参数，避免拼出空引用。
// 预检完成才创建，避免留下一个「分支已建但没切过去」的中间态。
    async createBranchAndSwitch(
      workspacePath: string,
      branchName: string,
      startPoint?: string,
    ): Promise<GitBranchMutationResult> {
      const status = await this.getStatus(workspacePath);
      // 做什么：创建并立即切换分支，预检顺序与 switchBranch 完全一致。
      // 必须先预检再创建：否则失败时会留下一个“分支已建但没切过去”的中间态，
      // 用户重试时又会撞上“分支已存在”。
      const resolution = ensureRepositoryAvailable(status.resolution, "create and switch branches");
      // 名字先 trim 再判空：只含空白的名字会拼出非法 refspec，提前返回 issue 更快。
      const normalizedBranchName = branchName.trim();
      if (normalizedBranchName.length === 0) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: null,
          summary: status.summary,
          issues: [toInvalidBranchNameIssue()],
        });
      }

      if (status.entries.some((entry) => entry.isConflicted)) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "conflicts-present",
              message: "Repository still has unresolved conflicts.",
            },
          ],
        });
      }

      if (await hasOperationInProgress(resolution)) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "operation-in-progress",
              message: "Another Git operation is still in progress.",
            },
          ],
        });
      }

      const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
      if (invalidBranchIssue) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [invalidBranchIssue],
        });
      }

// startPoint 来自外部输入，trim 后仍可能以 `-` 开头，
// 所以下面的命令必须在它之前插入 `--`，否则会被当成 switch 的选项。
// 空串归一成 undefined 语义（falsy），避免拼出一个空的起始引用。
      // startPoint 是可选外部输入，空串归一成 falsy，避免拼出一个空的起始引用；
      // 非空时它会作为位置参数出现，因此下面的数组形式必须显式插入 `--`。
      const normalizedStartPoint = startPoint?.trim();
      // startPoint 可能来自外部输入；如果值本身以 `-` 开头，
      // Git 会把它继续当成 switch 的选项解析，而不是起始引用。
      // 这里显式插入 `--` 终止选项解析，确保后面的值始终按位置参数处理。
      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        // 两条 argv 只在有无 startPoint 时不同，其余选项保持一致，避免日后只改一侧。
        args: normalizedStartPoint
          // `--` 终止选项解析：startPoint 以 `-` 开头时不会被当成 switch 的选项。
          ? ["switch", "--no-guess", "-c", normalizedBranchName, "--", normalizedStartPoint]
          // 无起始点时省略 `--`：此时参数只有分支名，已通过 check-ref-format 校验。
          : ["switch", "--no-guess", "-c", normalizedBranchName],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: parseGitBranchMutationIssues(result),
        });
      }

      invalidate(workspacePath);
      const nextStatus = await this.getStatus(workspacePath);
      return toBranchMutationSuccess({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        didChange: true,
        // created=true 只在“确实新建了分支”的路径出现，前端据此提示“已创建并切换”。
        created: true,
        summary: nextStatus.summary,
      });
    },

// diff 总入口，按来源分三条互斥路径：branch（与 upstream 比较）、staged（HEAD 与索引）、
// unstaged（索引与工作区）。三条路径共享同一个前提：路径必须先归一成仓库相对路径。
// absolutePath 由 workspacePath 还原，仅用于结果回填与读取工作区文件；
// 即使后续命令失败，也必须返回带 path 的结构化结果而不是抛错。
// 固定追加 --no-ext-diff/--no-color：用户配置的外部 diff 工具与颜色码会直接污染 patch。
// --binary 保留二进制补丁，前端据此判定 binary，而不是把空 patch 当成无差异。
// [权衡] 三种来源各自执行一次 git diff 而不是合并：索引侧基准不同，
// 合并需要多次 reset 或临时索引，出错概率高于多跑一次只读命令。
// unstaged 路径在 Git 无输出时还要考虑未跟踪文件，这部分 Git 完全看不到，
// 所以末尾保留手写 patch 与 --no-index 两级兜底。
// 返回类型统一为 GitDiffResult，调用方无需处理异常分支，降级信息放在 summary。
// preview 全文是否附加由 withDiffContents 决定，patch 与全文预览互不拖累。
    async getDiff(params: GitDiffQuery): Promise<GitDiffResult> {
      const resolution = await this.resolveRepository(params.workspacePath);
      const absolutePath = isAbsolute(params.path)
        ? params.path
        : resolve(params.workspacePath, params.path.split("/").join(sep));
      if (!resolution.isGitAvailable) {
        return toUnavailableDiff(
          absolutePath,
          "Git binary is not available in the current environment.",
        );
      }

      if (!resolution.isRepository) {
        return toUnavailableDiff(absolutePath, "Workspace is not inside a Git repository.");
      }

      const repoRelativePath = await normalizeInputPath(resolution, params.path);
      if (params.sourceId === "branch") {
        const status = await this.getStatus(params.workspacePath);
        const trackingBranchName = status.summary.trackingBranchName;
        if (!trackingBranchName) {
          return toUnavailableDiff(
            absolutePath,
            "Current branch does not have an upstream branch.",
          );
        }

// 分支比较用三点 `upstream...HEAD`：两点语法会把「上游领先本地的提交」
// 也算进差异，用户会看到自己从未改过的文件出现在列表里。
// 三个点等价于 `merge-base(upstream, HEAD)..HEAD`，这正是「我在当前分支上做了什么」。
// ref 名来自仓库配置而非用户输入，但仍不能省 `--`：分支名理论上可含特殊字符。
        const branchDiffResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--binary",
            "--find-renames",
            `${trackingBranchName}...HEAD`,
            "--",
            repoRelativePath,
          ],
          timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
        });
// emptySummary 必须针对来源定制：分支比较为空表示「与上游一致」，
// 与未暂存为空（「工作区无改动」）是两种完全不同的用户结论，不能共用文案。
        const parsedBranchDiff = toDiffResult(absolutePath, branchDiffResult, {
          emptySummary: "No branch comparison diff is available for this file.",
        });
        return withDiffContents(
          parsedBranchDiff,
          await readBranchDiffContents({
            commandProvider,
            repoRoot: resolution.repoRoot,
            repoRelativePath,
            trackingBranchName,
          }),
        );
      }

// 两个入口字段并存是协议演进的结果，这里只允许在一处合流：
// 用 ?? 而非 ||，因为 staged=false 是有效输入，|| 会把它当成缺失值。
// sourceId 的优先级更高：新协议字段出现时以它为准，避免旧字段残留导致误判。
// 之后的 patch 命令与全文预览都必须消费这一个变量，
// 若两侧各自推断，会出现 patch 用已暂存、预览用未暂存的内容错位。
// 同一文件可能同时存在已暂存与未暂存改动，本方法一次只描述其中一侧。
      const staged = params.staged ?? params.sourceId === "staged";
// 已暂存与未暂存只差一个 --cached，命令其余部分完全一致，
// 用三元表达式保持两者参数列表同步，避免日后只改一侧。
      const diffResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: staged
          ? ["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath]
          : ["diff", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath],
        timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
      });
// 统一转成结构化结果后再决定是否附加全文：toDiffResult 内部已经处理
// 超时、截断、非允许退出码、空输出与二进制五种降级，这里不再重复判断。
      const parsedDiff = toDiffResult(absolutePath, diffResult, {
        emptySummary: "No Git diff is available for this file.",
      });
// 只有确实拿到 patch（或请求本身就是 staged）时才追加全文预览。
// staged 无条件尝试：即使 patch 为空（例如只改了文件权限），
// MultiFileDiff 仍需要两侧内容来独立渲染。
// unavailable 且未暂存说明这不是已跟踪文件的改动，交给下面的未跟踪兜底，
// 这里不提前 return，是为了保留原降级结论（二进制/截断/超时）。
      if (parsedDiff.availability !== "unavailable" || staged) {
        const contents = staged
          ? await readStagedDiffContents({
              commandProvider,
              repoRoot: resolution.repoRoot,
              repoRelativePath,
            })
          : await readUnstagedDiffContents({
              absolutePath,
              commandProvider,
              repoRoot: resolution.repoRoot,
              repoRelativePath,
            });
        return withDiffContents(parsedDiff, contents);
      }

      // 未跟踪文件不会出现在 `git diff` 里，所以这里先生成一份稳定的单文件 patch。
      // 如果文件无法按文本预览，再退回 `--no-index`，继续兼容二进制等特殊场景。
// 文件已不存在（刚被删除的未跟踪文件）时直接返回原结论：
// 没有内容可读，继续走 --no-index 只会换来一条无意义的报错。
// fileExists 内部吞掉所有异常，这里无需 try/catch。
      if (!(await fileExists(absolutePath))) {
        return parsedDiff;
      }

// 优先使用自建 patch：它只依赖文件内容，头部格式固定，
// 不受平台、Git 版本与用户 diff 配置影响。
// 返回 null 表示文件不可按文本预览（二进制、超限、读取失败），
// 此时才降级到 --no-index，让 Git 给出它自己的结论。
// 第三参传 DEFAULT_GIT_DIFF_BYTES，与其它 diff 路径共用同一个体积预算。
      const normalizedUntrackedDiff = await buildUntrackedTextDiffResult(
        absolutePath,
        repoRelativePath,
        DEFAULT_GIT_DIFF_BYTES,
      );
      if (normalizedUntrackedDiff) {
        return normalizedUntrackedDiff;
      }

// 最后兜底：与 NUL 设备比较，语义就是「相对空内容的全量新增」。
// 必须传绝对路径：--no-index 不要求 cwd 在仓库内，相对路径会按进程 cwd 解析。
// getGitNullDevicePath 按平台返回空设备路径，Windows 上不能硬编码 /dev/null。
// [失败路径] 允许退出码 1：有差异时 git diff 返回 1，这是成功语义而非错误。
      const noIndexDiffResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-color",
          "--binary",
          getGitNullDevicePath(),
          absolutePath,
        ],
        timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
      });
      return toDiffResult(absolutePath, noIndexDiffResult, {
        allowedExitCodes: [0, 1],
        emptySummary: "No previewable diff is available for this file.",
      });
    },

// 与 upstream 的整体比较，只用于列表展示，不生成 patch。
// 没有上游时返回空 changes 而不是抛错：这是常见状态，UI 用空态提示即可。
// 同样使用三点语法，与 getDiff 的 branch 来源共用基准，
// 否则列表里的增删行数与点开文件看到的 patch 会对不上。
// headRef 在 detached 时回退成 HEAD：比较本身仍然成立，只是没有分支名。
    async getBranchComparison(workspacePath: string): Promise<GitBranchComparisonSnapshot> {
  // 做什么：与 upstream 做整体比较，只用于列表展示，不生成 patch。
  // 没有上游时返回空 changes 而不是抛错：这是常见状态，UI 用空态提示即可。
      const status = await this.getStatus(workspacePath);
      if (
        !status.resolution.isGitAvailable ||
        !status.resolution.isRepository ||
        !status.summary.trackingBranchName
      ) {
        return {
          resolution: status.resolution,
          baseRef: status.summary.trackingBranchName,
          headRef: status.summary.branchName ?? "HEAD",
          comparisonLabel: null,
          changes: [],
        };
      }

      const result = await commandProvider.run({
        cwd: status.resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          // 三点语法与 getDiff 的 branch 来源共用基准，
          // 否则列表里的增删行数与点开文件看到的 patch 会对不上。
          `${status.summary.trackingBranchName}...HEAD`,
          "--",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      // numstat 只给增删行数，必须保留 -z 解析：路径含空格或换行时按空白切会错位。
      ensureGitCommandSucceeded("git diff --numstat upstream...HEAD", result);

// numstat 只给增删行数，重命名信息藏在 kind/originalPath 里；
// 统一交给 inferKindFromNumstat 补全，避免每条记录各自推断导致分类不一致。
// Map 的迭代顺序即输出顺序（Git 的字典序），列表渲染因此稳定，无需二次排序。
      // `parseNumstat` 的每条记录转成 `GitBranchComparisonChange`：补 `originalPath` 与 `kind`。
      const changes = Array.from(parseNumstat(result.stdout).entries()).map(
        ([path, stat]): GitBranchComparisonChange => ({
          path,
          originalPath: stat.originalPath ?? null,
          kind: inferKindFromNumstat(stat),
          added: stat.added,
          removed: stat.removed,
        }),
      );

      return {
        resolution: status.resolution,
        baseRef: status.summary.trackingBranchName,
        headRef: status.summary.branchName ?? "HEAD",
        // 标签方向必须与三点语法一致：前者是“当前分支相对上游”，
        // detached 时用 HEAD 代替分支名，比较本身仍然成立。
        comparisonLabel: status.summary.branchName
          ? `${status.summary.branchName} -> ${status.summary.trackingBranchName}`
          : `HEAD -> ${status.summary.trackingBranchName}`,
        changes,
      };
    },

// 批量暂存。先归一化再 Set 去重：重复路径会让部分 Git 版本报 pathspec 重复，
// 直接失败；去重同时缩短 argv 长度。
// 空列表直接返回，不执行 `git add --`（无路径的 add 在不同版本行为不一致）。
// 归一化是异步且可能抛错的（路径越界），因此先 Promise.all 再统一判空：
// 一旦有路径越界，整批失败比静默少暂存更安全。
    async stage(workspacePath: string, paths: string[]): Promise<void> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "stage paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
// `--` 之后全部按路径解释，保证形如 `-p` 的文件名不会被当成选项。
// 这里必须用仓库相对路径：cwd 已是 repoRoot，绝对路径同样可用，
// 但相对路径更短，且不会因盘符大小写差异在 Windows 上匹配失败。
        args: ["add", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      ensureGitCommandSucceeded("git add", result);
      invalidate(workspacePath);
    },

// 取消暂存用 restore --staged：把 HEAD 的版本写回索引，工作区保持不动。
// 不能用 checkout，它会同时覆盖工作区，把用户未暂存的改动一起丢掉。
// 也不建议 reset HEAD --path：语义等价但更老，且容易与 reset --hard 混用。
// 无 HEAD 的初始提交仓库里此命令会失败，这属于预期，交由断言抛出。
    async unstage(workspacePath: string, paths: string[]): Promise<void> {
  // 做什么：把指定路径的索引版本还原成 HEAD，工作区保持不动。
  // 为什么用 restore --staged：checkout 会连工作区一起覆盖，把未暂存的改动丢掉；
  // reset HEAD --path 语义等价但更老，且容易与 reset --hard 混用出事故。
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
    // 非仓库直接抛错：取消暂存没有可降级的形态，调用方必须知道操作没发生。
        "unstage paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
    // `--` 之后全部按路径解释，形如 `-p` 的文件名不会被当成选项；
    // 初始提交仓库没有 HEAD 时命令会失败，属于预期，交由断言抛出。
        args: ["restore", "--staged", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
    // 成功后必须失效缓存，否则状态快照仍显示这些文件“已暂存”。
      ensureGitCommandSucceeded("git restore --staged", result);
      invalidate(workspacePath);
    },

// 丢弃改动分两种，区别在索引是否也回滚：
// staged=true 用 --source=HEAD --staged --worktree，两处都回到 HEAD；
// 只回滚工作区会让索引里留着用户以为已经撤销的内容。
// staged=false 只带 --worktree，绝不能带 --staged，
// 那会把同一文件里其它已暂存的改动一并抹掉。
// 这是不可逆操作，因此只对显式传入的路径执行，不做目录推断。
    async discard(workspacePath: string, paths: string[], staged: boolean): Promise<void> {
  // 做什么：对显式传入的路径执行回滚，不做目录推断。
  // 这是不可逆操作，因此只处理调用方明确列出的路径，避免误删用户未提及的改动。
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "discard paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: staged
// 已暂存场景必须同时还原索引与工作区，两者都回到 HEAD：
// 只还原工作区会让索引保留用户以为已撤销的内容，文件看起来仍是「已暂存」。
// --source=HEAD 显式指定基线，避免受 restore 默认行为变化影响。
          ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...repoPaths]
          : ["restore", "--worktree", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
    // 失败必须抛出：回滚没生效却返回成功，用户会以为改动已经丢弃。
      ensureGitCommandSucceeded("git restore", result);
      invalidate(workspacePath);
    },

// 提交有两条实现路径：普通提交交给 Git；stagedOnly 且给定路径时走临时索引，
// 后者是为了只提交「这些路径里已暂存的部分」，不触碰其它已暂存文件。
// paths 为空表示提交整份索引，此时不加路径参数，由 Git 按全量处理。
// 提交成功后 invalidate 并按需要回读 HEAD，保证返回值一定是真实哈希而非猜测。
    async commit(
      workspacePath: string,
      message: string,
      paths?: string[],
      options?: { stagedOnly?: boolean },
    ): Promise<{ commitHash: string }> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "commit changes",
      );
// 消息先 trim 再判空：只有空白字符的消息对 Git 等同于空消息，
// 但 Git 在无 TTY 的子进程里会因此打开编辑器并挂到超时。
// 提交时使用 trim 后的值，避免标题行带前导空格影响 changelog 生成。
      const trimmedMessage = message.trim();
// 这是唯一在发命令前就拒绝的输入校验：其它校验都依赖 Git 的结论，
// 只有空消息无论 Git 版本如何都注定失败。
      if (trimmedMessage.length === 0) {
        throw new Error("Commit message cannot be empty");
      }
      const repoPaths =
        paths && paths.length > 0
          ? Array.from(
              new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
            )
          : [];

// 定向提交分支的进入条件必须同时满足两项：
// 1) 调用方明确要求 stagedOnly，否则普通提交不应重建索引；
// 2) 至少给了一个路径，没有路径时临时索引等价于整份索引，没有意义。
// 缺任何一项都会退回到下面的普通 commit，而不是报错。
      if (options?.stagedOnly && repoPaths.length > 0) {
// 先查这些路径的 scoped 状态，目的是补齐 rename 的旧路径：
// 新路径在索引里存在，旧路径的删除记录却只出现在 status 的 originalPath 中。
        const scopedStatusResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["status", "--porcelain=v2", "-z", "--", ...repoPaths],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        ensureGitCommandSucceeded("git status selected paths", scopedStatusResult);

// 清理集合 = 目标路径 + 目标路径中发生重命名的旧路径。
// 旧路径不属于用户选中项，但临时索引若保留它，提交结果会多出一条删除记录。
// 用 Set 去重：同一路径可能既是目标又是另一个条目的 originalPath。
        const cleanupRepoPaths = Array.from(
          new Set([
            ...repoPaths,
            ...parseStatusPorcelain(scopedStatusResult.stdout)
              .entries.filter((entry) => repoPaths.includes(entry.path))
              .map((entry) => entry.originalPath)
              .filter((path): path is string => Boolean(path)),
          ]),
        );
// 从真实索引里取出目标路径的 (mode, hash, path)：
// 这是把「用户暂存了什么」原样搬进临时索引的唯一可靠来源。
        const stagedEntriesResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["ls-files", "--stage", "-z", "--", ...repoPaths],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        ensureGitCommandSucceeded("git ls-files selected staged entries", stagedEntriesResult);
// 解析失败会抛错并中断提交，这是有意的：条目缺失会生成内容不完整的树，
// 而一次不完整的提交比失败更难被发现。
        const stagedEntries = parseGitIndexEntries(stagedEntriesResult.stdout);
// stage 非 0 表示索引存在冲突条目（多个 stage 并存）。
// 此时重建索引会挑到任意一个冲突版本，提交内容不确定，必须直接拒绝。
// 这是本方法唯一的业务校验异常，提示要能指导用户先解决冲突。
        if (stagedEntries.some((entry) => entry.stage !== "0")) {
          throw new Error("Cannot commit selected staged paths while index conflicts exist.");
        }

// 用 rev-parse --verify HEAD 判断是否已有父提交：exitCode 非 0 即初始提交，
// 这条探测失败是正常状态，因此不进 ensure 断言。
        const headResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--verify", "HEAD"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
// parentHash 同时决定临时索引的基线：有父提交就继承它的全部条目，
// 没有则从空树开始。用 null 而不是空串表达「无父提交」，
// 避免把空字符串当成引用传给 read-tree 而触发另一类报错。
        const parentHash = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
// [资源] 每次定向提交独占一个临时目录，用 mkdtemp 而不是固定名字：
// 固定名字会让并发提交互相覆盖索引文件，提交内容串台且难以复现。
// 放在系统临时目录而不是仓库内，避免被 Git 状态扫描或用户工作区监视到。
// [失败路径] 这里失败时还没有产生需要清理的状态，所以可以安全地放在 try 之前。
        const tempIndexDir = await mkdtemp(join(tmpdir(), "zcode-git-index-"));
        const tempIndexPath = join(tempIndexDir, "index");
// 只通过环境变量覆盖 GIT_INDEX_FILE，不修改仓库配置也不设置全局状态：
// 子进程退出后真实索引完全不受影响，这是整个方案可回滚的基础。
// env 是增量注入，PATH/HOME 等沿用父进程，Git 才能继续读到用户级配置。
        const tempIndexEnv = { GIT_INDEX_FILE: tempIndexPath };

        try {
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: parentHash ? ["read-tree", parentHash] : ["read-tree", "--empty"],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git read-tree selected commit base", readTreeResult);

          if (cleanupRepoPaths.length > 0) {
            const removeResult = await commandProvider.run({
              cwd: resolution.repoRoot,
              args: ["update-index", "--force-remove", "--", ...cleanupRepoPaths],
              env: tempIndexEnv,
              timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            });
            ensureGitCommandSucceeded("git update-index remove selected paths", removeResult);
          }

// 逐条把原索引的 (mode, hash, path) 写回临时索引。
// 必须用 --cacheinfo 而不是重新 add 工作区文件：工作区可能已被再次修改，
// 重新 hash 会把「尚未暂存的新内容」提交进去，违背 stagedOnly 的承诺。
// 必须串行：并发写同一个索引文件会触发 index.lock 冲突。
          for (const entry of stagedEntries) {
            const addResult = await commandProvider.run({
              cwd: resolution.repoRoot,
              args: [
                "update-index",
                "--add",
                "--cacheinfo",
                entry.mode,
                entry.objectHash,
                entry.path,
              ],
              env: tempIndexEnv,
              timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            });
            ensureGitCommandSucceeded("git update-index add selected paths", addResult);
          }

          const scopedCommitResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["commit", "-m", trimmedMessage],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          });
          ensureGitCommandSucceeded("git commit selected staged paths", scopedCommitResult);

          const hashResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["rev-parse", "HEAD"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git rev-parse selected commit HEAD", hashResult);
// 提交后必须重新 rev-parse HEAD 取自真实哈希，不能自行推算：
// 提交可能被 hook 改写（rebase/amend），只有回读才能拿到最终值。
// trim 必做：stdout 带尾随换行，直接返回会让前端把它当成非法哈希。
          const commitHash = hashResult.stdout.trim();

          // 提交当前会话文件时不能把真实 index 整体替换成临时 index。
          // 这里只把已提交的路径同步到新 HEAD，保留其它已暂存文件继续等待用户手动提交。
          const resetSelectedResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["reset", "--quiet", "HEAD", "--", ...cleanupRepoPaths],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git reset selected committed paths", resetSelectedResult);
          invalidate(workspacePath);
          return { commitHash };
        } finally {
// [资源] finally 中递归删除临时目录，成功、失败、抛错三种路径都要执行。
// force:true 用来覆盖 Git 留下的只读锁文件（Windows 上尤其常见）。
// 清理失败不应吞掉异常：提交已成功时它的影响只是残留文件，
// 而提交失败时应让原始错误优先传播，因此这里不做额外包装。
          await rm(tempIndexDir, { recursive: true, force: true });
        }
      }

// 普通提交路径。有目标路径时把 `--` 放在消息之后、路径之前：
// 顺序颠倒会让 Git 把 `--` 当成消息的一部分。
// 无路径时不追加 `--`，让 Git 提交整份索引。
      const commitResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args:
          repoPaths.length > 0
            ? ["commit", "-m", trimmedMessage, "--", ...repoPaths]
            : ["commit", "-m", trimmedMessage],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git commit", commitResult);
      invalidate(workspacePath);

      const hashResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["rev-parse", "HEAD"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
// 普通提交路径的哈希回读同样走统一断言：
// 提交成功但读取 HEAD 失败时必须报错，否则返回值会是空串，
// 前端会把它当成非法哈希并弹出更难理解的错误。
      ensureGitCommandSucceeded("git rev-parse HEAD", hashResult);
      return { commitHash: hashResult.stdout.trim() };
    },

// push 是显式用户动作，允许比其它命令更长的执行时间与更大的输出上限：
// pre-push hook 常跑完整测试，默认阈值会让「正在推送」被误判成失败。
// 有上游时直接 push，由 Git 按 branch.<name>.merge 推导 refspec；
// 无上游时显式 --set-upstream，避免用户每次手动建立跟踪关系。
// 推送成功后重新取状态，保证返回的 ahead/behind 与 tracking 名是最新的。
    async push(workspacePath: string): Promise<GitPushResult> {
      const status = await this.getStatus(workspacePath);
      const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
      const branchName = status.summary.branchName?.trim() ?? "";
// 用 headRefType 而不是只判分支名是否为空：detached 时 branchName 可能残留旧值，
// 只看字符串会把一个不存在的分支推上去。这是用户可见的失败，应抛出而非返回结构化结果。
      if (status.summary.headRefType !== "branch" || branchName.length === 0) {
        throw new Error("Cannot push while HEAD is detached.");
      }

// 是否有 upstream 决定两条完全不同的命令形态，也决定返回值里的 setUpstream。
// 有 upstream 时不再自行解析 remote：交给 Git 处理多远端配置，
// 我们拼 `origin branch` 反而会覆盖用户已有的跟踪设置。
      const hasTrackingBranch = Boolean(status.summary.trackingBranchName);
      const remoteName = hasTrackingBranch
        ? parseTrackingRemoteName(status.summary.trackingBranchName)
        : await resolvePushRemote(status);
// 两个 timeout/output 上限是 push 专用的常量，不在通用阈值上随便放大：
// 放大只影响这一条命令，避免把 status/diff 这些高频命令的超时一起拉长。
      const pushResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: hasTrackingBranch
          ? ["push"]
          : ["push", "--set-upstream", remoteName ?? "origin", branchName],
        // 关键业务逻辑：push 是显式用户动作，而且可能被 pre-push hook 拉长。
        // 这里单独使用更长超时，避免测试/校验脚本尚未跑完就被前端误判成 push 失败。
        timeoutMs: DEFAULT_GIT_PUSH_TIMEOUT_MS,
        // 关键业务逻辑：pre-push hook 可能输出完整测试日志。
        // 这里单独放宽输出上限，避免在 push 真正完成前因为 hook 输出过多被截断。
        maxOutputBytes: DEFAULT_GIT_PUSH_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git push", pushResult);
      invalidate(workspacePath);

      const nextStatus = await this.getStatus(workspacePath);
      return {
        branchName,
        trackingBranchName: nextStatus.summary.trackingBranchName,
        remoteName: remoteName ?? parseTrackingRemoteName(nextStatus.summary.trackingBranchName),
        setUpstream: !hasTrackingBranch,
        summary: nextStatus.summary,
      };
    },

// 身份只用于展示与预填提交信息，不参与鉴权：
// 因此缺失 user.name/user.email 时返回全 null 而不是抛错。
// 两次查询并发执行，互不依赖且都很轻量。
// --show-scope 与 --show-origin 一起用，才能同时说明「哪一层配置」与「来自哪个文件」。
// scopeLabel 以 name 优先、email 兜底：用户最关心名字来自哪一层。
    async getIdentity(workspacePath: string): Promise<GitIdentity> {
  // 做什么：读取 user.name/user.email 及其来源层级，用于展示与预填提交信息。
  // 身份不参与鉴权，因此缺失时返回全 null 而不是抛错：
  // 抛错会让“未配置 Git 身份”的工作区连状态面板都打不开。
      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return {
          userName: null,
          userEmail: null,
          nameSource: null,
          emailSource: null,
          scopeLabel: null,
        };
      }

      const [nameResult, emailResult] = await Promise.all([
        commandProvider.run({
          cwd: resolution.repoRoot,
          // 两次查询并发：互不依赖且都很轻量，串行只是多一次进程调度。
          // --show-scope 给层级（local/global/system），--show-origin 给来源文件；
          // 必须带 --get：不带键名会输出整份配置，解析成本与信息量都不合适。
          args: ["config", "--show-scope", "--show-origin", "--get", "user.name"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        }),
        commandProvider.run({
          cwd: resolution.repoRoot,
          // 邮箱单独查，才能分别报告两侧的来源；合并查询会丢掉其中一个 scope。
          args: ["config", "--show-scope", "--show-origin", "--get", "user.email"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        }),
      ]);

      // 解析统一交给 parseGitConfigValue：它处理 exitCode=1（键不存在）与输出格式，
      // 在这里各写一份会把“无值”和“命令失败”混为一谈。
      const name = parseGitConfigValue(nameResult);
      const email = parseGitConfigValue(emailResult);
      return {
        userName: name.value,
        userEmail: email.value,
        nameSource: name.source,
        emailSource: email.source,
        // scopeLabel 以 name 优先、email 兜底：用户最关心名字来自哪一层；
        // 两者都缺失时给 null，不编造默认层级。
        scopeLabel: name.scope ?? email.scope ?? null,
      };
    },
  };
}
