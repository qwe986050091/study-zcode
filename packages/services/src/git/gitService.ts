// Git 业务层：把 repo 层解析出的原始 Git 状态裁剪成「当前 workspace 可见」的视图。
// 上游是 UI 的 Git 面板与 commit message 生成，下游是 gitCliRepo（命令执行与解析）。
// INV-01：返回给上层的文件必须同时带绝对路径、repoRelativePath、workspaceRelativePath（守住：buildFileChange / toBranchComparisonChange）。
//   若少一个：面板按 workspaceRelativePath 分组、按绝对路径读文件，缺任一项会静默丢条目或读错文件。
// INV-02：工作区作用域过滤只在这一层做，repo 层不得了解 workspace 子目录（守住：matchesWorkspaceScope 及其所有调用）。
//   若下移到 repo：同一份 status 会被多个 workspace 视角共享，过滤条件无处可放。
import { resolve } from "node:path";
import type { GitBranchComparison, GitFileChange, GitChangeSectionId } from "@zcode/shared";
import { isPathInWorkspaceScope, normalizeGitPath, toWorkspaceRelativeGitPath } from "./config.js";
import { filterCommitMessageFilesByCurrentSession } from "./commitMessageFileScope.js";
import type { IGitService } from "./git.js";
import type { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";
import {
  createGitCliRepo,
  type GitBranchComparisonChange,
  type GitBranchComparisonSnapshot,
  type GitCliRepo,
  type GitStatusEntry,
  type GitStatusSnapshot,
} from "./repo/gitCliRepo.js";

// 用 resolve 而不是字符串拼接：分隔符与 Windows 盘符都由它统一处理，
// 手工拼 / 会得到混合分隔符的路径，后续路径比较会失败。
function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

// 重命名的两个端点都要判：只看新路径会漏掉「移出 workspace」的旧路径一侧，
// 反之漏新路径；任一在作用域内就算相关，宁多勿漏。
function matchesWorkspaceScope(
  workspaceInRepoPath: string,
  entry: { path: string; originalPath: string | null },
): boolean {
  return (
    isPathInWorkspaceScope(entry.path, workspaceInRepoPath) ||
    (entry.originalPath ? isPathInWorkspaceScope(entry.originalPath, workspaceInRepoPath) : false)
  );
}

// 单条变更的统一构造点：把 Git 的 x/y 标记翻译成 UI 需要的 section 布尔量。
// isStaged/isUntracked/isConflicted 由 section 派生而不是从 x/y 推断，
// 保证「分组」与「标记」同源，不会出现 staged 组里混进未跟踪文件。
function buildFileChange(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  section: GitChangeSectionId,
  added: number,
  removed: number,
): GitFileChange {
  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, entry.path),
    repoRelativePath: entry.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      entry.path,
      snapshot.summary.workspaceInRepoPath,
    ),
    x: entry.x ?? undefined,
    y: entry.y ?? undefined,
    kind: entry.kind,
    section,
    added,
    removed,
    isStaged: section === "staged",
    isUntracked: section === "untracked",
    isConflicted: section === "conflicted",
  };
}

// 只有以 / 结尾的「目录占位记录」允许 0 增 0 减，因为它是可 stage/discard 的降级入口。
function shouldIncludeUntrackedChange(
  entry: GitStatusEntry,
  stat: { added: number; removed: number },
): boolean {
  // 构建目录里常见大量未跟踪的空文件、失效链接或不可读产物。
  // 这类条目没有可审查的文本增删，之前会以 +0/-0 挤进 Review 面板，既污染列表又拖慢打开。
  // 但详细 status 超限后，Git 会用末尾 `/` 的目录记录表达整棵未跟踪目录；它本身不可读，
  // 行数必然为 0，却仍必须作为可 stage/discard 的降级入口保留。
  return entry.path.endsWith("/") || stat.added > 0 || stat.removed > 0;
}

// 把一条 status 条目映射到指定 section，返回 null 表示它不属于该 section。
// 同一条目会在 unstaged 与 staged 两个 sourceId 下各判一次，因此分支必须互斥，
// 否则同一文件在两个分组重复出现，review 计数翻倍。
// 作用域过滤放最前：不属于本 workspace 的条目连统计都不该参与。
function toChangeForSource(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  sourceId: "unstaged" | "staged",
): GitFileChange | null {
// 先裁作用域再判 section：monorepo 下 repo 会给出全仓条目，
// 不先裁剪会让 staging 统计（repo 层按全仓算）与展示条目对不上。
  if (!matchesWorkspaceScope(snapshot.summary.workspaceInRepoPath, entry)) {
    return null;
  }

// staged 看 x（暂存区）、unstaged 看 y（工作区），这是 porcelain 的列语义；
// 混用会让「已暂存但工作区又改动」的文件落到错误分组。
  if (sourceId === "staged") {
// x 为空或 . 表示暂存区没有内容，不算 staged；冲突条目单独进 conflicted 组，避免重复展示。
    if (entry.isUntracked || entry.isConflicted || !entry.x || entry.x === ".") {
      return null;
    }

    const stat = snapshot.stagedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    return buildFileChange(snapshot, entry, "staged", stat.added, stat.removed);
  }

// 冲突优先于未跟踪/未暂存判断：冲突文件两侧都有内容，归到任何单侧都会误导用户以为可直接 commit。
  if (entry.isConflicted) {
    return buildFileChange(snapshot, entry, "conflicted", 0, 0);
  }

// 未跟踪条目没有 diff 统计（git 不为它算行数），stat 缺失按 0 处理，再由 shouldIncludeUntrackedChange 去留。
  if (entry.isUntracked) {
    const stat = snapshot.untrackedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    if (!shouldIncludeUntrackedChange(entry, stat)) {
      return null;
    }
    return buildFileChange(snapshot, entry, "untracked", stat.added, stat.removed);
  }

// y 为空说明工作区与暂存区一致，没有可展示的未暂存改动，返回 null 而不是空 diff。
  if (!entry.y || entry.y === ".") {
    return null;
  }

  const stat = snapshot.unstagedStats.get(entry.path) ?? {
    added: 0,
    removed: 0,
  };
  return buildFileChange(snapshot, entry, "unstaged", stat.added, stat.removed);
}

// map + filter 两步而不是循环 push：让「条目属于哪个 section」的判定收敛在 toChangeForSource 一处。
function getChangesForSource(
  snapshot: GitStatusSnapshot,
  sourceId: "unstaged" | "staged",
): GitFileChange[] {
// 顺序沿用 git status 输出，不在这里重排；UI 需要稳定顺序时按路径自行排序，避免两处规则打架。
  return snapshot.entries
    .map((entry) => toChangeForSource(snapshot, entry, sourceId))
    .filter((entry): entry is GitFileChange => Boolean(entry));
}

// 分支对比条目没有暂存/未跟踪语义，三个布尔量固定 false；
// kind 沿用 diff 侧类型，避免再维护一套映射表。
function toBranchComparisonChange(
  snapshot: GitBranchComparisonSnapshot,
  change: GitBranchComparisonChange,
): GitFileChange | null {
  if (!matchesWorkspaceScope(snapshot.resolution.workspaceInRepoPath, change)) {
    return null;
  }

  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, change.path),
    repoRelativePath: change.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      change.path,
      snapshot.resolution.workspaceInRepoPath,
    ),
    kind: change.kind,
    section: "branch",
    added: change.added,
    removed: change.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  };
}

// 只取前 8 个文件的 diff：模型上下文有限，文件过多会让真正重要的变更摘要被挤掉。
const COMMIT_MESSAGE_DIFF_FILE_LIMIT = 8;

// 为每个文件决定从暂存区还是工作区取 diff；顺序沿用 files 的顺序，
// 保证同一批变更每次生成的 prompt 结构一致，结果可复现。
function getCommitMessageDiffQueries(
  files: readonly GitFileChange[],
  includeUnstaged: boolean,
): Array<{ path: string; sourceId: "unstaged" | "staged" }> {
  const queries: Array<{ path: string; sourceId: "unstaged" | "staged" }> = [];
// 截断放在这里而不是调用方：limit 与「取哪一侧 diff」的规则属于同一条策略，分开会漂移。
  for (const file of files.slice(0, COMMIT_MESSAGE_DIFF_FILE_LIMIT)) {
// staged 文件优先用暂存区 diff：commit 带的是暂存内容，用工作区 diff 会描述出将要提交之外的改动。
    if (file.section === "staged") {
      queries.push({ path: file.path, sourceId: "staged" });
      continue;
    }

// includeUnstaged 为假时只保留 staged 部分，对应「只提交已暂存」的模式。
    if (!includeUnstaged) {
      continue;
    }

    queries.push({ path: file.path, sourceId: "unstaged" });
  }
  return queries;
}

// 依赖注入点：repo 与 commitMessageGenerator 都可替换，测试不必真的跑 git。
// 未注入 generator 时 generateCommitMessage 显式抛错，而不是返回空字符串——
// 空 message 会被上层当成「生成成功」直接提交。
export function createGitService(options?: {
  repo?: GitCliRepo;
  commitMessageGenerator?: GitCommitMessageGenerator;
}): IGitService {
// 默认装配真实的 CLI repo；注入只用于测试与远程宿主。
// repo 是本模块唯一的外部 IO 出口，保持单实例避免每条命令各自建连接/缓存。
  const repo = options?.repo ?? createGitCliRepo();

  return {
// 只回 summary：已有独立分支信息 RPC 时，调用方不必拉整份 status 视图。
    async getRepositorySummary(params) {
      const status = await repo.getStatus(params.workspacePath);
// 直接返回 repo 的 summary 对象而不是逐字段复制：字段演进时这里无需跟着改。
      return status.summary;
    },

// 仓库身份（是否 Git 仓库、根目录、workspace 子路径）直接透传，service 层不做缓存。
    async getWorkspaceRepositoryInfo(params) {
      return await repo.getWorkspaceRepositoryInfo(params.workspacePath);
    },

// 本地分支列表透传；排序由 repo 层负责，避免两处排序规则不一致。
    async getLocalBranches(params) {
      return await repo.listLocalBranches(params.workspacePath);
    },

// 分页由 maxCount/skip 表达，service 只裁掉 repo 内部字段，对外保持 commits + hasMore。
    async getCommitGraph(params) {
      const snapshot = await repo.getCommitGraph(
        params.workspacePath,
        params.maxCount,
        params.skip,
      );
      return {
        commits: snapshot.commits,
        hasMore: snapshot.hasMore,
      };
    },

// 切换分支会改工作区文件，repo 层已负责串行与错误映射；
// 这里不重试：失败通常意味着有未提交改动或分支不存在，重试只会放大错误。
    async switchBranch(params) {
      return await repo.switchBranch(params.workspacePath, params.targetBranchName);
    },

// startPoint 可选：缺省时由 repo 用当前 HEAD，业务层不猜默认分支，避免与 Git 版本行为不一致。
    async createBranchAndSwitch(params) {
      return await repo.createBranchAndSwitch(
        params.workspacePath,
        params.branchName,
        params.startPoint,
      );
    },

// 每次调用都重新取 status、不缓存：面板可能在 stage 之后立刻重拉，
// 陈旧快照会让用户看到「已暂存又变回未暂存」。
    async getChanges(params) {
      const status = await repo.getStatus(params.workspacePath);

      // workspace 可以是 monorepo 子目录，所以这里统一在 service 层按作用域裁剪。
      // 这样 repo 继续只负责“把 Git 原始状态解析出来”，上层则始终拿到符合当前 workspace 边界的数据。
      return getChangesForSource(status, params.sourceId);
    },

// 忽略列表可能涉及大量路径，repo 会分段调用，这里只透传不聚合。
    async getIgnoredPaths(params) {
      return await repo.getIgnoredPaths(params.workspacePath, params.paths);
    },

// diff 直接透传：patch 与 summary 的取舍、行数统计都由 repo 决定，service 不做二次格式化。
    async getDiff(params) {
      return await repo.getDiff(params);
    },

// 分支对比的作用域过滤与工作区变更一致（都走 matchesWorkspaceScope），
// 否则同一文件在「变更」与「分支对比」两个 tab 里的可见性不同。
    async getBranchComparison(params): Promise<GitBranchComparison> {
      const comparison = await repo.getBranchComparison(params.workspacePath);
      return {
        baseRef: comparison.baseRef,
        headRef: comparison.headRef,
        comparisonLabel: comparison.comparisonLabel,
        changes: comparison.changes
          .map((change) => toBranchComparisonChange(comparison, change))
          .filter((change): change is GitFileChange => Boolean(change)),
      };
    },

// stage 是批量且幂等的写操作（重复调用结果相同）；不做乐观更新，
// UI 以写完后重新拉取的 status 为准，避免本地推测与 Git 实际状态分叉。
    async stagePaths(params) {
      await repo.stage(params.workspacePath, params.paths);
    },

// unstage 只动索引、不动工作区，失败时用户数据不会丢，错误直接向上抛即可。
    async unstagePaths(params) {
      await repo.unstage(params.workspacePath, params.paths);
    },

// discard 会丢工作区改动，最依赖参数正确：staged 标志决定是否连索引一起回滚，
// 缺省 false 表示只还原工作区。
    async discardPaths(params) {
      await repo.discard(params.workspacePath, params.paths, params.staged ?? false);
    },

// 生成 message 的输入 = 当前会话相关文件的 diff + 分支名，不把整库 diff 交给模型。
// 先取一次 status 再用同一快照切两份变更，保证 unstaged 与 staged 的行数统计同源。
// 任何一步拿不到可用 diff 都继续（allSettled + 过滤），单个文件失败不阻断整次生成。
    async generateCommitMessage(params) {
// [失败路径] 未注入 generator 属装配错误，必须抛错而不是降级成空 message，
// 否则用户会提交一个空 commit 且无从察觉。
      if (!options?.commitMessageGenerator) {
        throw new Error("Commit message generation is not available.");
      }

// 缺省 true 表示「有未暂存改动也一起参与生成」，与 Git 面板默认展示全部改动一致；
// 该字段在 IGitService 的旧签名里没有，因此这里做一次窄化读取而不是改接口。
      const includeUnstaged = (params as { includeUnstaged?: boolean }).includeUnstaged ?? true;
      const status = await repo.getStatus(params.workspacePath);
      const unstagedChanges = includeUnstaged ? getChangesForSource(status, "unstaged") : [];
      const stagedChanges = getChangesForSource(status, "staged");
// 只保留「当前会话真正改过」的文件：agent 批量写文件时工作区会混入无关变更，
// 不过滤会生成描述别的任务的 commit message。
// 过滤放在 diff 之前：先缩小文件集合能显著减少 git diff 调用次数。
      const files = filterCommitMessageFilesByCurrentSession({
        files: [...unstagedChanges, ...stagedChanges],
        workspacePath: params.workspacePath,
        repoRoot: status.resolution.repoRoot,
        workspaceInRepoPath: status.resolution.workspaceInRepoPath,
        currentSessionFilePaths: params.currentSessionFilePaths,
      });
// 空集合显式报错：空 message 比报错更糟，用户会以为「没有改动」而继续提交流程。
      if (files.length === 0) {
        throw new Error("There are no changes available to commit.");
      }

      const diffQueries = getCommitMessageDiffQueries(files, includeUnstaged);
      const diffResults = await Promise.allSettled(
        diffQueries.map((query) =>
          repo.getDiff({
            workspacePath: params.workspacePath,
            path: query.path,
            sourceId: query.sourceId,
          }),
        ),
      );
// [失败路径] 用 allSettled 而不是 all：个别文件 diff 失败（二进制、权限、超大文件）
// 不应让整次生成失败，只要还有一个文件有内容就继续。
// 同时过滤 patch 与 summary 都为空的 diff，避免把空段落塞进 prompt。
      const diffs = diffResults.flatMap((result) =>
        result.status === "fulfilled" && (result.value.patch || result.value.summary)
          ? [result.value]
          : [],
      );

// 可选字段用条件展开而不是写 undefined：generator 侧按「键是否存在」判断是否使用，
// 显式 undefined 会让某些实现走到不同的默认分支。
      return await options.commitMessageGenerator.generate({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.locale ? { locale: params.locale } : {}),
        branchName: status.summary.branchName,
        files,
        diffs,
        ...(params.conversationContext ? { conversationContext: params.conversationContext } : {}),
      });
    },

// commit 之后再取一次 status：返回的 summary 必须是提交后的状态（ahead 数会变），
// 沿用提交前快照会让 UI 短暂显示旧的分支信息。
    async commit(params) {
      const result = await repo.commit(params.workspacePath, params.message, params.paths, {
        stagedOnly: params.stagedOnly,
      });
      const status = await repo.getStatus(params.workspacePath);
      return {
        commitHash: result.commitHash,
        summary: status.summary,
      };
    },

// push 结果原样透传（是否设置上游、是否被拒绝），service 不二次解释，避免丢失 Git 错误细节。
    async push(params) {
      const result = await repo.push(params.workspacePath);
      return result;
    },

// 身份（user.name/email）用于提交预览，缺失时由 repo 返回 null，UI 负责引导配置。
    async getIdentity(params) {
      return await repo.getIdentity(params.workspacePath);
    },

// refresh 是 UI 自动刷新的唯一入口：一次 status 快照切出 summary/unstaged/staged，
// 把原本三个并发 RPC 各自执行一次 git status 的开销压成一次。
// identity 与 branchComparison 按需并发，三者无数据依赖，可同时发起。
    async refresh(params) {
      const statusPromise = repo.getStatus(params.workspacePath);
      const identityPromise = params.includeIdentity
        ? repo.getIdentity(params.workspacePath)
        : Promise.resolve(null);
      const branchComparisonPromise = params.includeBranchComparison
        ? repo.getBranchComparison(params.workspacePath)
        : Promise.resolve(null);
      const [status, identity, branchComparisonSnapshot] = await Promise.all([
        statusPromise,
        identityPromise,
        branchComparisonPromise,
      ]);
// 只有快照存在才映射：includeBranchComparison 为假时保持 null，
// 与「有快照但过滤后为空数组」区分开，UI 据此决定是否显示分支对比 tab。
      const branchComparison: GitBranchComparison | null = branchComparisonSnapshot
        ? {
            baseRef: branchComparisonSnapshot.baseRef,
            headRef: branchComparisonSnapshot.headRef,
            comparisonLabel: branchComparisonSnapshot.comparisonLabel,
            changes: branchComparisonSnapshot.changes
              .map((change) => toBranchComparisonChange(branchComparisonSnapshot, change))
              .filter((change): change is GitFileChange => Boolean(change)),
          }
        : null;

      // UI 的自动刷新原本会并发调用 summary、unstaged、staged 三个 RPC，
      // 每个 RPC 都重新执行一次 git status。agent 批量写文件时这会把 renderer 卡在
      // 重复的 Git I/O 和 RPC 日志上。refresh 在一次 status 快照里切出三份数据。
      return {
        summary: status.summary,
        identity,
// 两个列表共享同一个 status 快照，保证 staged + unstaged 集合自洽；
// 分别重新取 status 会在两次调用之间出现「同一条目两边都有」的中间态。
        unstagedChanges: getChangesForSource(status, "unstaged"),
        stagedChanges: getChangesForSource(status, "staged"),
        branchComparison,
      };
    },
  };
}
