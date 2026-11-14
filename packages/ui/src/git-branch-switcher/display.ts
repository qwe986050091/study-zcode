// INV-01 守住位置：脏文件计数以仓库相对路径去重，暂存与未暂存共用同一集合；改错故障：按改动条数累加会让同一文件重复计数，切换前脏检查虚高。
// INV-02 守住位置：触发器标题先判游离 HEAD，再读分支名；改错故障：顺序对调会让游离状态下显示空串或陈旧分支名。
// INV-03 守住位置：分支名 trim 后为空才回退默认文案；改错故障：把全空白串当标题会渲染出没有文字的按钮。
// INV-04 守住位置：搜索串为空视为全部命中；改错故障：空串走子串比较时语义依赖巧合，一旦改成等值比较列表立刻清空。
// INV-05 守住位置：搜索串与分支名两侧都先 trim 再转小写比较；改错故障：透传原始大小写会让用户输入大写时零命中。
// INV-06 守住位置：主提示固定取 issue 数组首项；改错故障：本层再挑一次「最严重」会与上游排序形成两套优先级。
// INV-07 守住位置：提交辅助类 issue 按 code 白名单判定；改错故障：用提示文案匹配会随翻译改动而失效。
// INV-08 守住位置：issue 为空或未知 code 一律返回空文案 id；改错故障：给默认分支塞通用文案会掩盖新错误码未接入。
// INV-09 守住位置：成功提示先看 didChange 再区分创建与切换；改错故障：无实际变更仍弹成功会误导用户以为切换生效。
// INV-10 守住位置：动作是 create-and-switch 或带 created 标记都算创建成功；改错故障：只看动作会漏掉隐式新建分支的提示。
// INV-11 守住位置：路径摘要先剔除空白项再截断；改错故障：空串占位会让可见名额被浪费，剩余计数也失真。
// INV-12 守住位置：可见路径按 limit 截断，剩余数取差值且下限为零；改错故障：负值剩余数会渲染出「还要 -1 个」这类文案。
// INV-13 守住位置：提交预览以仓库相对路径为唯一键聚合；改错故障：用 stage 路径当键会让同一文件产生两条重复卡片。
// INV-14 守住位置：同文件重复出现时增删行数相加；改错故障：后写覆盖前写会漏算已暂存那部分的行数。
// INV-15 守住位置：两侧 kind 一致才保留，否则降级为 modified；改错故障：沿用旧 kind 会把新增加删除的复合改动误报成纯新增。
// INV-16 守住位置：预览列表按仓库相对路径做稳定字典序排序；改错故障：依赖 Map 插入序会让同一批改动两次打开顺序不同。
// INV-17 守住位置：汇总只累加，不修改入参里的文件对象；改错故障：原地改 added 会让预览数字与真实提交内容不一致。
// INV-18 守住位置：受影响文件在预览里缺失时补零行数占位对象；改错故障：直接丢弃会让弹窗少列文件，与 issue 路径对不上。
//
// 模块职责：集中 Git 分支切换相关的纯展示派生逻辑——脏文件计数、触发器标题、搜索匹配、issue 选择与文案映射、成功提示、路径摘要、提交预览聚合与汇总、受影响文件、自动提交信息。
// 状态所有权：本文件不持有状态，也不访问 store、服务或平台 API；所有入参由调用方传入，输出是可渲染的值或新数组，缓存与订阅留在组件或 hooks。
// 阅读顺序：先读上方 18 条不变量建立边界，再按导出函数自上而下阅读；聚合与排序部分最易改错，建议配合调用方一起看。
import type {
  GitBranchMutationIssueCode,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitFileChange,
  GitHeadRefType,
} from "@zcode/shared";

interface GitDirtySectionLike {
  changes: Array<{
    path: string;
  }>;
}

interface GitDirtyDatasetsLike {
  staged: {
    sections: GitDirtySectionLike[];
  };
  unstaged: {
    sections: GitDirtySectionLike[];
  };
}

export interface GitBranchCommitPreviewFile {
  stagePath: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  kind: GitFileChange["kind"];
  added: number;
  removed: number;
}

export function getGitDirtyFileCount(datasets: GitDirtyDatasetsLike): number {
  // 用集合去重，键是仓库相对路径，暂存与未暂存共同参与
  // 同一文件可能同时出现在两个分组，只有跨组去重才得到真实文件数
  // 分组顺序沿用数据来源，但集合语义下顺序不影响最终计数
  const dirtyPaths = new Set<string>();
  for (const dataset of [datasets.unstaged, datasets.staged]) {
    for (const section of dataset.sections) {
      for (const change of section.changes) {
        dirtyPaths.add(change.path);
      }
    }
  }

  return dirtyPaths.size;
}

export function resolveGitBranchTriggerLabel(options: {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  detachedLabel: string;
  fallbackLabel: string;
}): string {
  // 游离 HEAD 判定必须排在读取分支名之前
  // 该状态下分支名可能仍是旧值或为空，不能作为标题来源
  // detachedLabel 由调用方注入，本文件不拼装任何文案
  // 提前返回同时省掉了后面去空白的无效计算
  if (options.headRefType === "detached") {
    return options.detachedLabel;
  }

  const normalizedBranchName = options.currentBranchName?.trim() ?? "";
  // normalizedBranchName 为空串时与 undefined 收敛到同一个 fallback 分支
  // 判空用 normalizedBranchName.length 而不是真值，避免全空格被当成有效标题
  // 展示侧只取 options.currentBranchName 原值，不做大小写或截断改写
  return normalizedBranchName.length > 0 ? normalizedBranchName : options.fallbackLabel;
}

export function matchesGitBranchSearch(branchName: string, searchText: string): boolean {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  // 空搜索等价于不过滤，必须整条放行
  // 提前返回让调用方不必再为无搜索词单独分支
  // 此处判据是归一后的长度，空格输入也因此落入放行分支
  if (normalizedSearchText.length === 0) {
    return true;
  }

  return branchName.trim().toLocaleLowerCase().includes(normalizedSearchText);
}

export function getPrimaryGitBranchIssue(
  issues: readonly GitBranchMutationIssue[],
): GitBranchMutationIssue | null {
  // 主提示固定取首项，信任上游已按重要性排好顺序
  // 空数组与未定义收敛为 null，调用方只需判空一次
  // 不在本层重新排序，避免出现第二套优先级规则
  return issues[0] ?? null;
}

export function isGitBranchCommitAssistIssue(
  code: GitBranchMutationIssueCode | undefined,
): boolean {
  return (
    code === "tracked-changes-would-be-overwritten" ||
    code === "untracked-changes-would-be-overwritten"
  );
}

export function resolveGitBranchIssueMessageId(
  issue: GitBranchMutationIssue | null,
): string | null {
  // 用错误码到文案 id 的显式映射，翻译职责留给展示层
  // 返回的是 i18n key 而不是已翻译文案，切换语言时无需重算
  // 默认分支返回 null 表示没有专属文案，兜底策略交给调用方
  // 新增错误码必须同步补一条映射，否则会静默落到空值
  switch (issue?.code) {
    case "invalid-branch-name":
      return "git.branchSwitcher.error.invalidBranchName";
    case "branch-already-exists":
      return "git.branchSwitcher.error.branchAlreadyExists";
    case "target-branch-not-found":
      return "git.branchSwitcher.error.targetBranchNotFound";
    case "tracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.trackedOverwrite";
    case "untracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.untrackedOverwrite";
    case "conflicts-present":
      return "git.branchSwitcher.error.conflictsPresent";
    case "operation-in-progress":
      return "git.branchSwitcher.error.operationInProgress";
    case "branch-in-other-worktree":
      return "git.branchSwitcher.error.branchInOtherWorktree";
    default:
      return null;
  }
}

export function resolveGitBranchSuccessMessageId(
  result: Pick<GitBranchMutationResult, "action" | "created" | "didChange">,
): string | null {
  // 没有实际变更时不弹成功提示，避免误以为分支已切换
  // 是否生效只看 didChange，不根据动作反推
  // 返回 null 与业务成败无关，调用方据此跳过提示
  if (!result.didChange) {
    return null;
  }

  if (result.action === "create-and-switch" || result.created) {
    return "git.branchSwitcher.toast.createSuccess";
  }

  return "git.branchSwitcher.toast.switchSuccess";
}

export function summarizeGitBranchIssuePaths(
  paths: readonly string[] | undefined,
  limit = 2,
): {
  visiblePaths: string[];
  remainingCount: number;
} {
  // 先按 path.trim().length 过滤空白路径，空白项不应占用 visible 名额
  // filter 发生在 slice 截断之前，剩余数才基于真实非空项计算
  // paths 缺失时按空数组处理，摘要退化为零条
  // normalizedPaths 保留原始顺序，先后由上游调用方决定
  const normalizedPaths = (paths ?? []).filter((path) => path.trim().length > 0);
  return {
    visiblePaths: normalizedPaths.slice(0, limit),
    remainingCount: Math.max(0, normalizedPaths.length - limit),
  };
}

export function buildGitBranchCommitPreviewFiles(
  changes: readonly GitFileChange[],
): GitBranchCommitPreviewFile[] {
  const previewByRepoPath = new Map<string, GitBranchCommitPreviewFile>();

  for (const change of changes) {
    // 以仓库相对路径为唯一键，同一文件的暂存与未暂存记录合并成一条
    // 首次出现时直接写入六个字段，不做额外计算
    // 再次出现时增删行数相加，避免重复卡片与数字遗漏
    // kind 仅两侧一致时保留，否则降级为 modified
    // 除增删数字外其余字段取首次出现的值，结果与遍历顺序无关
    const existing = previewByRepoPath.get(change.repoRelativePath);
    if (!existing) {
      previewByRepoPath.set(change.repoRelativePath, {
        stagePath: change.path,
        repoRelativePath: change.repoRelativePath,
        workspaceRelativePath: change.workspaceRelativePath,
        kind: change.kind,
        added: change.added,
        removed: change.removed,
      });
      continue;
    }

    previewByRepoPath.set(change.repoRelativePath, {
      ...existing,
      // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
      // 这里把增删行数聚合后再展示，避免阻塞卡片和提交弹窗看到两条重复记录。
      added: existing.added + change.added,
      removed: existing.removed + change.removed,
      kind: existing.kind === change.kind ? existing.kind : "modified",
    });
  }

  // 输出前按仓库相对路径做稳定字典序排序
  // 不依赖 Map 插入顺序，保证同一批改动两次打开顺序一致
  // 排序键是仓库相对路径，与展示用的工作区路径无关
  // 本地化比较在混合大小写路径上更稳，与普通比较的差异仅在少数场景可见
  return Array.from(previewByRepoPath.values()).sort((left, right) =>
    left.repoRelativePath.localeCompare(right.repoRelativePath),
  );
}

export function getGitBranchCommitTotals(files: readonly GitBranchCommitPreviewFile[]): {
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
} {
  return files.reduce(
    (result, file) => {
      result.fileCount += 1;
      result.totalAdded += file.added;
      result.totalRemoved += file.removed;
      return result;
    },
    {
      fileCount: 0,
      totalAdded: 0,
      totalRemoved: 0,
    },
  );
}

export function selectGitBranchAffectedFiles(options: {
  files: readonly GitBranchCommitPreviewFile[];
  issuePaths: readonly string[] | undefined;
}): GitBranchCommitPreviewFile[] {
  const fileByRepoPath = new Map(
    options.files.map((file) => [file.repoRelativePath, file] as const),
  );
  const normalizedIssuePaths = (options.issuePaths ?? []).filter((path) => path.trim().length > 0);

  return normalizedIssuePaths.map(
    (repoRelativePath) =>
      fileByRepoPath.get(repoRelativePath) ?? {
        stagePath: repoRelativePath,
        repoRelativePath,
        workspaceRelativePath: repoRelativePath,
        kind: "modified",
        added: 0,
        removed: 0,
      },
  );
}

export function buildGitBranchAutoCommitMessage(targetBranchName: string): string {
  const normalizedBranchName = targetBranchName.trim();
  return normalizedBranchName.length > 0
    ? `chore: checkpoint before switching to ${normalizedBranchName}`
    : "chore: checkpoint before switching branches";
}
