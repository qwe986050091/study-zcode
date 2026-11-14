// 模块职责：Git CLI 的「解析与错误映射」层。本文件不执行任何命令，只把
// GitCommandExecutionResult（stdout/stderr/exitCode/超时与截断标记）翻译成领域类型，
// 并把易变的 Git 原生文案归一成稳定的 issue code 与 diff 可用性枚举。
// 集中在这里的原因：repo 层保持线性业务流程，所有格式兼容性与平台差异只在一处处理。
//
// INV 不变量表（每条被破坏时上层不会立刻报错，而是静默给出错误结论）：
// INV-01：解析函数只读 result，绝不改写输入或二次执行命令（守住它的位置：本文件全部导出函数）；
//         破坏后果：一次 status 退化为多次 Git 调用，自动刷新成本随文件数线性放大。
// INV-02：config 查询的 exitCode=1 表示「键不存在」，不是失败（parseGitConfigValue 首个分支）；
//         破坏后果：未配置 user.name 被当成仓库损坏，提交面板直接报错。
// INV-03：config --show-scope/--show-origin 输出按 TAB 分三段，value 段允许再含 TAB
//         （parseGitConfigValue 的 parts.slice(2).join）；破坏后果：含 TAB 的配置值被截断。
// INV-04：porcelain v2 -z 的记录以 NUL 分隔，rename 的原路径独占下一条记录
//         （parseStatusPorcelain 的 records[index + 1]）；破坏后果：重命名退化为「删除 + 新增」。
// INV-05：完整 diff 的 before/after 必须同生同死（toCompleteDiffContents）；
//         破坏后果：单侧读取失败被补成空串，整个文件被渲染成新增或删除。
// INV-06：未跟踪文件的 patch 由本文件自行拼装，不借用 git diff --no-index
//         （buildUntrackedTextDiffResult）；破坏后果：Windows 头部格式触发前端 diff 组件异常。
// INV-07：未跟踪行数统计受字节预算约束，越预算或含 NUL 一律记 0（countUntrackedFileLines）；
//         破坏后果：大文件与二进制被当文本读取，Host 内存和耗时不可控。
// INV-08：路径进入领域模型前统一过 normalizeGitPath（所有 entries/stats 的写入点）；
//         破坏后果：反斜杠与正斜杠路径在 Map 中成为两个 key，改动条目重复计数。
/* eslint-disable max-lines */
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GitBranchMutationIssue,
  GitChangeKind,
  GitDiffResult,
  GitHeadRefType,
} from "@zcode/shared";
import {
  GIT_UNTRACKED_STAT_CHUNK_BYTES,
  GIT_UNTRACKED_STAT_CONCURRENCY,
  GIT_UNTRACKED_STAT_MAX_BYTES,
  normalizeGitPath,
} from "#src/git/config.js";
import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";
import type { GitLineStat, GitResolvedRepository, GitStatusEntry } from "./gitCliTypes.js";

// stderr 优先于 stdout：Git 的失败说明几乎只写在 stderr，而 stdout 可能残留半截数据；
// 两者都空时退化成 exitCode 文本，因为进程根本没启动时（spawn 错误）这两个流都是空的，
// 此时若返回空串，上层会把「无法执行」显示成没有任何信息的失败。
// 注意 exitCode 用 ?? 而不是 ||：0 是合法退出码，不能被当成缺失值。
function toResultMessage(result: GitCommandExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exitCode=${result.exitCode ?? "null"}`;
}

// Git for Windows 与 POSIX 的换行不一致，正则按单行匹配前必须先归一，否则 `$` 前会多出 \r；
// 行尾空白也要剥掉：porcelain 上报的路径末尾可能带空格，而报错正文里的缩进不能用 trim 直接吃掉，
// 因为 extractIndentedPaths 正是靠「行首有缩进」判断文件列表的开始与结束。
function toNormalizedLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

// 从报错正文里抠出「文件名列表」：Git 的格式是提示行 + 若干缩进路径。
// 判定结束的条件是遇到第一条无缩进的非空行，而不是遇到空行——Git 版本之间会在列表中间插空行，
// 提前退出会漏掉后半段路径，UI 上就只提示了部分被覆盖的文件。
// 路径本身可能含空格，所以按整行 trim 取值，不能按空白切分。
function extractIndentedPaths(lines: string[], headerPattern: RegExp): string[] {
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.toLowerCase()));
// 匹配不到提示行时返回空数组而不是抛错：Git 文案会随版本与本地化变化，
// 这里失败只应退化为「没识别出具体路径」，不能让一次分支切换的错误处理变成崩溃。
  if (headerIndex < 0) {
    return [];
  }

  const paths: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

// 列表的结束条件是出现第一条顶格行（通常是 Git 的后续建议文案），
// 因此这里不能用 trim 后的空值判断：空行在列表中会出现，过早 break 会截断路径列表。
    if (!/^\s+/.test(line)) {
      break;
    }

    const value = line.trim();
    if (value.length > 0) {
      paths.push(normalizeGitPath(value));
    }
  }

  return paths;
}

// detail 保留 Git 原始 stderr 供 UI 悬浮展示：分支名校验规则随 Git 版本变化，
// 我们自己复述规则会过期，只保证 code 稳定，文案交给 Git。
// 空串归一成 null，避免 UI 渲染出空 tooltip 或「详情：」这样的残句。
export function toInvalidBranchNameIssue(detail?: string | null): GitBranchMutationIssue {
  return {
    code: "invalid-branch-name",
    message: "Branch name is invalid.",
    detail: detail?.trim() || null,
  };
}

// 分支切换失败的归一化入口。分支判断顺序不可随意调换：
// 「local changes would be overwritten」与「untracked ... overwritten」属于可恢复的本地改动冲突，
// 必须排在 already exists / invalid reference 之前，否则同一段 stderr 会被归成错误类别，
// 上层就无法引导用户「先处理改动」而是误导成「分支名非法」。
// 全部模式用 lowercase 匹配，因为 Git 的英文文案大小写在不同版本与本地化开关下并不稳定。
export function parseGitBranchMutationIssues(
  result: GitCommandExecutionResult,
): GitBranchMutationIssue[] {
// detail 同时保留原文并做 lowercase 副本：原文供 UI 展示，副本只用于匹配。
// 不要在匹配前就地 toLowerCase，否则用户看到的是被改写的 Git 文案。
  const detail = result.stderr.trim() || result.stdout.trim() || null;
  const lines = toNormalizedLines(detail ?? "");
  const normalizedDetail = detail?.toLowerCase() ?? "";

  // 分支切换是否被阻塞，最终以 Git 原生命令的真实报错为准。
  // 这里集中把常见 stderr 归一成稳定 issue code，避免 UI 直接依赖易变的原始文案。

// [权衡] 先查 tracked 覆盖冲突再查未跟踪冲突：两条提示可能同时出现，
// 但已跟踪改动的处置代价更高（可能需要 stash/commit），优先提示它更能避免用户误操作。
// 命中后立刻 return 单条 issue，而不是合并多条：上层只消费第一个阻塞原因，
// 拼装多条会让同一份 stderr 被反复测量与展示。
  const trackedOverwritePaths = extractIndentedPaths(
    lines,
    /your local changes to the following files would be overwritten by (checkout|switch)/,
  );
  if (trackedOverwritePaths.length > 0) {
    return [
      {
        code: "tracked-changes-would-be-overwritten",
        message: "Tracked changes would be overwritten by switching branches.",
        paths: trackedOverwritePaths,
        detail,
      },
    ];
  }

// 未跟踪文件被覆盖意味着用户会永久丢数据，因此单独成类而不是并入 tracked：
// 两类的前置处置完全不同（未跟踪只需移动或删除，tracked 需要提交或暂存）。
// 注意未跟踪列表同样允许路径含空格，不能按空白切分后取首段。
  const untrackedOverwritePaths = extractIndentedPaths(
    lines,
    /the following untracked working tree files would be overwritten by (checkout|switch)/,
  );
  if (untrackedOverwritePaths.length > 0) {
    return [
      {
        code: "untracked-changes-would-be-overwritten",
        message: "Untracked files would be overwritten by switching branches.",
        paths: untrackedOverwritePaths,
        detail,
      },
    ];
  }

// 用 includes 而不是前缀匹配：Git 的前缀是 `fatal: a branch named 'x' already exists`，
// 且不同版本会多出提示行。这里只关心语义片段，任何更严格的匹配都会随版本失效。
  if (normalizedDetail.includes("already exists")) {
    return [
      {
        code: "branch-already-exists",
        message: "Branch already exists.",
        detail,
      },
    ];
  }

// switch 使用 --no-guess，因此「本地不存在的分支」只会以 invalid reference 出现，
// 不会被 Git 悄悄创建或匹配到远端同名分支；这个映射就是用户视角的「目标分支不存在」。
  if (normalizedDetail.includes("invalid reference:")) {
    return [
      {
        code: "target-branch-not-found",
        message: "Target branch was not found.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("is already used by worktree at")) {
    return [
      {
        code: "branch-in-other-worktree",
        message: "Branch is already checked out in another worktree.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("resolve your current index first")) {
    return [
      {
        code: "conflicts-present",
        message: "Repository still has unresolved conflicts.",
        detail,
      },
    ];
  }

  if (
// 进行中的操作有三套措辞，缺一不可：
// 1) `cannot switch branch while <op>`：较新 Git 的统一提示；
// 2) `you have not concluded your merge`：merge 冲突未收尾时的旧措辞；
// 3) `rebase in progress`：rebase 交互中断时的独立提示。
// 只匹配其中一条，就会让某类仓库永远拿到 unknown，UI 无法给出「先完成合并」的引导。
    /cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(
      normalizedDetail,
    ) ||
    normalizedDetail.includes("you have not concluded your merge") ||
    normalizedDetail.includes("rebase in progress")
  ) {
    return [
      {
        code: "operation-in-progress",
        message: "Another Git operation is still in progress.",
        detail,
      },
    ];
  }

  return [
    {
      code: "unknown",
      message: "Git could not complete the branch operation.",
      detail,
    },
  ];
}

// 统一的失败断言：超时与截断即使 exitCode=0 也必须抛错。
// [失败路径] exitCode 为 0 但 outputTruncated 时，stdout 是被腰斩的 JSON/porcelain，
// 继续解析会得到「看起来合法但缺后半段」的结果，比直接失败更难排查。
// allowedExitCodes 用 NaN 兜底比较：exitCode 缺失（进程未启动）不能等于调用方希望放行的 0。
export function ensureGitCommandSucceeded(
  label: string,
  result: GitCommandExecutionResult,
  allowedExitCodes: number[] = [0],
): GitCommandExecutionResult {
  if (result.timedOut) {
    // timeout 阈值和进程清理总耗时不是一回事；日志里同时保留两者，
    // 避免把“15s 触发超时、随后等待清理”的场景误读成真正配置了更长超时。
    const timeoutMs = result.timeoutMs ?? result.durationMs;
    const details = [`elapsed=${result.durationMs}ms`];
    if (result.timeoutElapsedMs !== undefined) {
      details.push(`killAt=${result.timeoutElapsedMs}ms`);
    }
    if (result.timeoutCloseDelayMs !== undefined) {
      details.push(`cleanup=${result.timeoutCloseDelayMs}ms`);
    }
    if (result.forceKillAttempted) {
      details.push("forceKill=true");
    }
    if (result.orphaned) {
      details.push("orphaned=true");
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms (${details.join(", ")})`);
  }

  if (result.outputTruncated) {
    throw new Error(`${label} output exceeded limit`);
  }

  if (allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return result;
  }

  throw new Error(`${label} failed: ${toResultMessage(result)}`);
}

// 只有 stderr 参与判定：`git rev-parse` 在非仓库目录下 stdout 为空，任何命中 stdout 的匹配
// 都可能把一个真实仓库误判成非仓库。两个短语覆盖「不在工作树内」与「目录在仓库之外」两种措辞。
export function isNotRepositoryResult(result: GitCommandExecutionResult): boolean {
  const stderr = result.stderr.toLowerCase();
  return stderr.includes("not a git repository") || stderr.includes("outside repository");
}

// 工作目录消失（临时目录被清理、窗口切换）与「不是仓库」是两件事，必须分开：
// 前者意味着环境暂不可用，后者是稳定结论。exitCode=-2 是本仓库命令提供方对 spawn 失败的约定，
// 单独用它区分「Git 没跑起来」，避免把 ENOENT 一律当成仓库问题。
export function isMissingWorkingDirectoryResult(result: GitCommandExecutionResult): boolean {
  const stderr = result.stderr.toLowerCase();
  return (
    (result.exitCode === -2 && stderr.includes("enoent")) ||
// 这三条覆盖目录不可用的不同阶段：spawn 前的 ENOENT、chdir 失败、
// 以及目录在此之后被删除。任何一条都不能换算成「非仓库」以外的新状态，
// 否则调用方会重试一个永远失败的命令。
    stderr.includes("unable to read current working directory") ||
    stderr.includes("no such file or directory")
  );
}

// porcelain v2 的 XY 两位分别表示 index 与 worktree 状态，这里只取调用方挑出的那一位。
// `?` 归入 added（未跟踪等价于「相对 HEAD 新增」），R/C 都归 renamed：
// 复制在 UI 上按重命名展示比按「新增」更能说明两处路径的关联。
function inferKindFromStatusCode(statusCode: string): GitChangeKind {
  if (statusCode === "A" || statusCode === "?") {
    return "added";
  }

  if (statusCode === "D") {
    return "deleted";
  }

  if (statusCode === "R" || statusCode === "C") {
    return "renamed";
  }

  return "modified";
}

// `# branch.ab +3 -1` 是本仓库唯一消费的 ahead/behind 来源，不用 rev-list 二次统计：
// 后者在无 upstream 时会直接失败，而这里缺字段时默认 0 更符合「没有可比较远端」的语义。
function parseBranchAheadBehind(value: string): { ahead: number; behind: number } {
  const aheadMatch = value.match(/\+(\d+)/);
  const behindMatch = value.match(/-(\d+)/);
  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1]!, 10) : 0,
  };
}

// 只解析 `--porcelain=v2 -z`。v1 与人类可读输出在路径含空格、重命名、未跟踪目录折叠时都有歧义。
// -z 下每条记录以 NUL 结尾，因此末尾的空 record 必须过滤，否则会多出一条空路径条目。
export function parseStatusPorcelain(stdout: string): {
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
} {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];
  let branchName: string | null = null;
  let trackingBranchName: string | null = null;
  let headRefType: GitHeadRefType = "branch";
  let ahead = 0;
  let behind = 0;

  // `git status --porcelain=v2 -z` 的价值在于格式稳定，不受本地语言影响。
  // 这里集中做一次解析，把 branch/header/rename/unmerged 等低层细节都挡在 repo 层里。
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) {
        const head = record.slice("# branch.head ".length);
// detached 时不能把 `(detached)` 当成分支名：上层会拿它去执行 switch/push，
// 而 Git 对这类伪分支名的报错是 invalid reference，用户看到的原因会完全错位。
        if (head === "(detached)") {
          branchName = null;
          headRefType = "detached";
        } else {
          branchName = head;
          headRefType = "branch";
        }
      } else if (record.startsWith("# branch.upstream ")) {
        trackingBranchName = record.slice("# branch.upstream ".length);
// 只有配置了 upstream 才有这一行；缺失时 ahead/behind 保持 0，
// 不能据此推断「已同步」，UI 需要结合 trackingBranchName 是否为 null 判断。
      } else if (record.startsWith("# branch.ab ")) {
        const parsed = parseBranchAheadBehind(record.slice("# branch.ab ".length));
        ahead = parsed.ahead;
        behind = parsed.behind;
      }
      continue;
    }

// 未跟踪记录没有 XY 位，这里显式填 x=null / y="?"：若给成空串，
// UI 的「部分暂存」判定会把未跟踪文件误判成有 index 侧改动。
    if (record.startsWith("? ")) {
      entries.push({
        path: normalizeGitPath(record.slice(2)),
        originalPath: null,
        kind: "added",
        x: null,
        y: "?",
        isUntracked: true,
        isConflicted: false,
      });
      continue;
    }

// `1` 记录的字段顺序是固定 7 个占位后接路径，路径可含空格，所以只能贪婪匹配结尾；
// 解析失败时选择 continue 而不是抛错：一条畸形记录不应该让整份改动列表消失。
    if (record.startsWith("1 ")) {
      const match = record.match(/^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

      const xy = match[1]!;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: null,
        kind: inferKindFromStatusCode(xy[0] !== "." ? xy[0]! : xy[1]!),
        x: xy[0]!,
        y: xy[1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

// `2` 是 rename/copy 记录，比 `1` 多一个相似度字段，所以正则多一组 `[^ ]+`；
// 字段数写错会导致路径整体前移，最终把相似度当成路径的一部分返回给 UI。
// kind 固定为 renamed：`2` 记录本身已表明这是一次路径重命名或复制。
    if (record.startsWith("2 ")) {
      const match = record.match(/^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

// [失败路径] rename/copy 的原路径是紧随其后的独立 record（仍以 NUL 结尾）。
// 这里同时做两件事：取走下一条、把游标前移一位；若忘了 index += 1，
// 原路径会被当成一条独立变更再次解析，列表里凭空多出一条陌生路径。
      const originalPath = records[index + 1] ?? null;
      index += 1;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: originalPath ? normalizeGitPath(originalPath) : null,
        kind: "renamed",
        x: match[1]![0]!,
        y: match[1]![1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

// `u` 是 unmerged 记录（三路合并冲突），必须排在 1/2 之后判断：
// 冲突条目同样有 XY 位，但它代表索引里存在多个 stage，isConflicted 才是上层要的结论。
    if (!record.startsWith("u ")) {
      continue;
    }

    const match = record.match(
      /^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/,
    );
    if (!match) {
      continue;
    }

    entries.push({
      path: normalizeGitPath(match[2]!),
      originalPath: null,
      kind: "modified",
      x: match[1]![0]!,
      y: match[1]![1]!,
      isUntracked: false,
      isConflicted: true,
    });
  }

  return { branchName, trackingBranchName, headRefType, ahead, behind, entries };
}

// numstat 用 `-` 表示二进制文件（无法按行计数），这里归 0 而不是 null：
// 一行统计缺失不应该让整个文件在改动列表里消失，UI 会另按 binary 标记展示。
function parseNumstatValue(value: string): number {
  if (value === "-") {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 显式 kind 优先于按增删行数推断：重命名可能同时有增有删，纯靠行数会被判成 modified，
// 导致 UI 无法把重命名折叠成一条，而是展示成两条互不相关的改动。
export function inferKindFromNumstat(stat: GitLineStat): GitChangeKind {
  if (stat.kind) {
    return stat.kind;
  }

  if (stat.added > 0 && stat.removed === 0) {
    return "added";
  }

  if (stat.removed > 0 && stat.added === 0) {
    return "deleted";
  }

  return "modified";
}

// -z 下的 numstat 是「数字 TAB 数字 TAB 路径 NUL」；路径本身可能含 TAB，
// 所以前两段按 TAB 切、剩下全部 join 回路径。rename 时路径段为空，
// 真正的新旧路径各占后续一条 record，这是本函数必须手动前移游标的原因。
export function parseNumstat(stdout: string): Map<string, GitLineStat> {
  const records = stdout.split("\0");
  const stats = new Map<string, GitLineStat>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    const fields = record.split("\t");
    if (fields.length < 3) {
      continue;
    }

    const added = parseNumstatValue(fields[0]!);
    const removed = parseNumstatValue(fields[1]!);
    const pathField = fields.slice(2).join("\t");
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }

    const originalPath = records[index + 1] ?? "";
    const renamedPath = records[index + 2] ?? "";
    index += 2;
    if (renamedPath.length === 0) {
      continue;
    }

    stats.set(normalizeGitPath(renamedPath), {
      added,
      removed,
      kind: "renamed",
      originalPath: normalizeGitPath(originalPath),
    });
  }

  return stats;
}

// 未跟踪文件没有 Git 统计，只能自己数换行。三条硬约束：
// 1) 先 stat 再读：目录、超大文件、设备文件直接返回 0，避免 readFile 把 Host 拖死；
// 2) 复用调用方传入的 buffer：并发 worker 各自持有一块，不能在此分配；
// 3) 读到 NUL 立即判二进制返回 0，否则 NUL 会混进行数统计得到无意义的大数。
// [资源] file 必须在 finally 关闭：读循环有多处提前 return，放在函数尾部会泄漏句柄。
async function countUntrackedFileLines(absolutePath: string, buffer: Buffer): Promise<number> {
  const info = await stat(absolutePath);
// 目录（未跟踪的子模块或空目录）不参与行数统计；超过上限时保留变更条目、
// 只把行数记 0，这样大文件仍能出现在改动列表里，只是不显示增删行。
  if (!info.isFile() || info.size > GIT_UNTRACKED_STAT_MAX_BYTES) return 0;

  const file = await open(absolutePath, "r");
  try {
    let totalBytes = 0;
    let newlines = 0;
    let lastByte = 10;
    while (totalBytes <= GIT_UNTRACKED_STAT_MAX_BYTES) {
      // 文件可能在 stat 后增长；实际读取也必须受预算约束，额外一字节只用于识别越界。
      const length = Math.min(buffer.length, GIT_UNTRACKED_STAT_MAX_BYTES + 1 - totalBytes);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (bytesRead === 0) return newlines + (lastByte === 10 ? 0 : 1);
      totalBytes += bytesRead;
      if (totalBytes > GIT_UNTRACKED_STAT_MAX_BYTES) return 0;
      for (let index = 0; index < bytesRead; index++) {
// 二进制判定只看已读到的前缀，这是有意的近似：真正的二进制文件几乎立刻出现 NUL，
// 而为了绝对准确必须读完整文件，与字节预算的初衷冲突。
        if (buffer[index] === 0) return 0;
        if (buffer[index] === 10) newlines++;
      }
      lastByte = buffer[bytesRead - 1]!;
    }
    return 0;
  } finally {
    await file.close();
  }
}

// 固定 worker + 共享游标，而不是给每个文件起一个 Promise.all：
// 上万个未跟踪文件时后者会一次性打开上万个句柄，超出 Windows 与 macOS 的默认上限。
// nextIndex++ 在单线程事件循环里是原子的，无需加锁；这也是不再引入并发原语的前提。
// worker 数取 min(并发上限, 条目数)，条目为 0 时不会创建空转的 worker。
export async function buildUntrackedStats(
  repoRoot: string,
  entries: GitStatusEntry[],
): Promise<Map<string, GitLineStat>> {
  const stats = new Map<string, GitLineStat>();
  const untrackedEntries = entries.filter((entry) => entry.isUntracked);
  let nextIndex = 0;
  // 并发 readFile 全部未跟踪文件、读取后才识别二进制会让 Host 瞬间分配数 GiB。
  // 固定 worker 各复用一个小缓冲，逐文件限量读取；大文件仍保留变更条目，只跳过行数统计。
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(GIT_UNTRACKED_STAT_CHUNK_BYTES);
    while (nextIndex < untrackedEntries.length) {
      const entry = untrackedEntries[nextIndex++]!;
// 领域模型里的路径已被 normalizeGitPath 统一成正斜杠，
// 直接把它交给 path.resolve 在 Windows 上也能用，但 split 后展开可避免把
// 「含盘符或前导斜杠」的相对路径误当成绝对路径而跳出 repoRoot。
      const absolutePath = resolve(repoRoot, ...entry.path.split("/"));
      try {
        stats.set(entry.path, {
          added: await countUntrackedFileLines(absolutePath, buffer),
          removed: 0,
        });
      } catch {
// 单个文件读取失败（权限、被删、路径过长）只降级成 0 行，不中断整批：
// 未跟踪统计是展示增强项，不能因为一个坏文件让整个改动列表报错。
        stats.set(entry.path, { added: 0, removed: 0 });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(GIT_UNTRACKED_STAT_CONCURRENCY, untrackedEntries.length) },
      worker,
    ),
  );

  return stats;
}

// 用 access 而不是 stat：这里只关心「能否访问」，不关心大小与类型；
// 任何异常都收敛成 false，调用方据此决定是否继续探测，避免把 EACCES 与 ENOENT 混为异常抛出。
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 空文件与「只有一个换行」必须区分：前者不应产生 hunk，后者是一行空内容，
// 用 split 后统一 pop 会把两者混为一谈。hasTrailingNewline 单独返回，
// 因为 patch 需要据此决定是否补 `\ No newline at end of file`。
function splitUntrackedText(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
// 空文件提前返回，避免 split 产生 [""] 这样一条伪空行：
// 那会让空文件被渲染成「新增 1 行空内容」，与 file stat 的 0 行互相矛盾。
// hasTrailingNewline 此时给 false，调用方据此判断是否补 no-newline 标记。
  if (normalizedContent.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = normalizedContent.endsWith("\n");
  const lines = normalizedContent.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  return {
    lines,
    hasTrailingNewline,
  };
}

// 为未跟踪（或无法被 git diff 覆盖）的文件手写 unified diff。
// 输出形态固定为 `--- /dev/null` + `+++ b/<相对路径>` + 单个 `@@ -0,0 +1,N @@`，
// 这正是前端 diff 组件最稳定的输入；不要为了「更真实」去调用 --no-index。
// 顺序上先判二进制再判体积：二进制即使很小也不应进入文本预览。
export async function buildUntrackedTextDiffResult(
  absolutePath: string,
  repoRelativePath: string,
  maxPreviewBytes: number,
): Promise<GitDiffResult | null> {
  try {
    const content = await readFile(absolutePath);

    // 未跟踪文件的 patch 不能依赖 `git diff --no-index` 生成。
    // 这类 patch 在 Windows 上会带入平台相关头部，而 `@pierre/diffs` 对某些 `diff --git`
    // 头部格式本身也有兼容问题，最终会在 UI 展开时直接抛异常。
    // 这里统一退回最稳定的 unified diff 形态，只保留单文件预览真正需要的 `---/+++ / @@` 信息。
// 用 NUL 字节判定二进制，而不是扩展名或 content-type：
// Git 自身的启发式也是「前若干字节出现 NUL」，这样与 git diff 的 binary 结论保持一致。
    if (content.includes(0)) {
      return {
        path: absolutePath,
        availability: "binary",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Binary diff is not previewable.",
      };
    }

    if (content.byteLength > maxPreviewBytes) {
      return {
        path: absolutePath,
        availability: "truncated",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Git diff output exceeded the preview limit.",
      };
    }

    const normalizedPath = normalizeGitPath(repoRelativePath);
    const { lines, hasTrailingNewline } = splitUntrackedText(content.toString("utf-8"));
    const patchLines = ["--- /dev/null", `+++ b/${normalizedPath}`];

// hunk 头固定写成 `-0,0`（旧文件无内容）与 `+1,N`（新文件从第 1 行起共 N 行），
// 不能由数组长度反推起始行：统一 diff 的行号是从 1 开始计数的，不是 0。
// 空文件不产出 hunk，但 `--- /dev/null` 与 `+++ b/...` 仍要保留，
// 否则前端无法据此知道「这是一个被创建的空文件」而不是「读取失败」。
    if (lines.length > 0) {
      patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
      patchLines.push(...lines.map((line) => `+${line}`));
      if (!hasTrailingNewline) {
        patchLines.push("\\ No newline at end of file");
      }
    }

    return {
      path: absolutePath,
      availability: "patch",
      patch: `${patchLines.join("\n")}\n`,
      beforeContent: "",
      afterContent: content.toString("utf-8"),
      summary: null,
    };
  } catch {
    return null;
  }
}

// 两个短语对应两种输出：`GIT binary patch` 是 --binary 的补丁体，
// `Binary files ... differ` 是不带 --binary 时的摘要行。只看其一会在某些 Git 版本上漏判。
function isBinaryDiff(stdout: string): boolean {
  return stdout.includes("GIT binary patch") || stdout.includes("Binary files ");
}

// diff 的可用性判定是一条有严格顺序的状态机：超时 → 截断 → 非允许退出码 → 空输出 → 二进制 → patch。
// 顺序不能重排：例如空 stdout 的 exitCode=1 在 --no-index 下是「文件相同」，
// 若先判退出码就会把它当成失败，而不是「无差异」。
// 所有分支都返回结构化结果而不抛错，因为 diff 面板允许局部降级。
export function toDiffResult(
  path: string,
  result: GitCommandExecutionResult,
  options?: {
    allowedExitCodes?: number[];
    emptySummary?: string;
    binarySummary?: string;
  },
): GitDiffResult {
  if (result.timedOut) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff command timed out.",
    };
  }

  if (result.outputTruncated) {
    return {
      path,
      availability: "truncated",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff output exceeded the preview limit.",
    };
  }

// 默认只有 0 算成功；`--no-index` 的调用方显式传入 [0, 1]，
// 因为 git diff --no-index 对「有差异」返回 1，那是正常结果而非失败。
  const allowedExitCodes = options?.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: toResultMessage(result),
    };
  }

// 空输出统一降级为 unavailable 并使用调用方给的 emptySummary：
// 不同来源的「无差异」对用户含义不同（无改动 / 无上游），不能共用一句话。
  if (!result.stdout.trim()) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.emptySummary ?? "No diff output available.",
    };
  }

// 二进制判定放在 patch 返回之前：patch 字段一旦被填成二进制内容，
// 前端就会尝试按文本渲染并抛异常，所以此处必须返回 binary 并清空 patch。
  if (isBinaryDiff(result.stdout)) {
    return {
      path,
      availability: "binary",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.binarySummary ?? "Binary diff is not previewable.",
    };
  }

  return {
    path,
    availability: "patch",
    patch: result.stdout,
    beforeContent: null,
    afterContent: null,
    summary: null,
  };
}

// exitCode=1 直接返回全 null：这是 `git config --get` 对「键不存在」的固定答复，
// 不是错误，不能走 ensureGitCommandSucceeded。
// 输出形如 `global<TAB>/home/u/.gitconfig<TAB>Alice`；value 段允许含 TAB，
// 因此按 tabs 切三段后必须把剩余部分 join 回去，否则含 TAB 的值会被截断。
export function parseGitConfigValue(result: GitCommandExecutionResult): {
  scope: string | null;
  source: string | null;
  value: string | null;
} {
// [失败路径] 这里必须在 ensureGitCommandSucceeded 之前返回：
// 该函数默认只放行 0，迟一步调用就会把「未配置」抛成命令失败。
// 1 之外的退出码仍走统一断言，保持真正的错误可见。
  if (result.exitCode === 1) {
    return { scope: null, source: null, value: null };
  }

  ensureGitCommandSucceeded("git config", result);
  const line = result.stdout.replace(/\r?\n$/, "");
  const parts = line.split("\t");
  if (parts.length < 3) {
// 输出不足三段说明 Git 版本不支持 --show-scope/--show-origin 的组合输出，
// 此时整行就是 value，scope/source 留空让 UI 退化为「只显示值」。
    return { scope: null, source: null, value: line || null };
  }

  return {
    scope: parts[0] ?? null,
    source: parts[1] ?? null,
    value: parts.slice(2).join("\t") || null,
  };
}

// 所有写操作（stage/unstage/discard/commit）与 diff 的唯一路径入口。
// 先把仓库相对路径还原成绝对路径再 realpath：符号链接可能指向仓库之外，
// 只用字符串比较 relative 结果会漏掉这种越界。realpath 失败时退回原路径，
// 因为文件可能刚被删除，此时仍需要给出相对路径让 Git 自己报错。
// 下面四个判断覆盖越界的所有形态：空串、`.`、`..`、以及 `../x` 前缀。
export async function normalizeInputPath(
  resolution: GitResolvedRepository,
  path: string,
): Promise<string> {
// 入参既可能是绝对路径也可能来自 UI 的仓库相对路径，先分流再 realpath；
// 相对路径按 workspacePath 拼接而不是 repoRoot，因为用户看到的是工作区视图，
// 只有工作区可能是仓库的子目录。
  const rawAbsolutePath = isAbsolute(path)
    ? path
    : resolve(resolution.workspacePath, path.split("/").join(sep));
  const absolutePath = await realpath(rawAbsolutePath).catch(() => rawAbsolutePath);
  const repoRelativePath = normalizeGitPath(relative(resolution.repoRoot, absolutePath));
  if (
    repoRelativePath.length === 0 ||
    repoRelativePath === "." ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith("../")
  ) {
// 越界一律抛出而不是静默过滤：调用方拿到空结果会误以为「该路径没有改动」，
// 抛错至少能让上层记录一条明确原因。注意比较的是 realpath 之后的相对路径，
// 这样 `..` 与符号链接两种逃逸方式都会被同一处拦截。
    throw new Error(`Path is outside repository scope: ${path}`);
  }

  return repoRelativePath;
}

// 两类前置条件分开报错，是为了让 UI 能给出不同引导：
// 未安装 Git 需要提示安装或选择别的 Git 路径，非仓库则需要提示初始化/切换工作区。
// 返回 resolution 而不是 void，是因为它已经经过检查，调用方可直接使用而无需再判空。
export function ensureRepositoryAvailable(
  resolution: GitResolvedRepository,
  label: string,
): GitResolvedRepository {
  if (!resolution.isGitAvailable) {
    throw new Error(`Cannot ${label}: Git binary is not available`);
  }

  if (!resolution.isRepository) {
    throw new Error(`Cannot ${label}: workspace is not inside a Git repository`);
  }

  return resolution;
}
