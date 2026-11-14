// useGitRepository：把 gitService 的一次仓库快照投影成 header 与 Git pane 共用的只读视图状态。
//
// 职责（做什么）：按 workspaceKey 决定投影口径，判断是否需要真实刷新，调用 refresh 拉取 summary、
// identity、未暂存与已暂存变更以及 branch comparison，再按 section 固定顺序分组、排序并统计各源计数。
// 职责（不做什么）：不直接触碰平台 API，不写 store，不做持久化，不渲染 diff，也不重试失败请求。
// 职责（依赖谁）：依赖 useServices 注入的 gitService、workspace RPC 可用性判定、远端 session 解析
// 与 taskChangeSummary 的路径换算；调用方是 Git pane 与 header 相关的容器组件。
// 对外契约：返回值永远是完整的 GitPaneRepositoryState，缺数据时用空骨架补位而不是 undefined。
//
// 关键约束：面板只是 Git 事实的投影，状态里只保留最近一次成功快照与错误文案；切换 workspace 时，
// 渲染阶段先按 workspaceKey 降级为空态，等 effect 完成清理后再对齐，避免旧机器的路径泄漏到新远端。
// 远端未连通时一律不发查询，否则断连代理错误会变成每次首屏挂载的日志噪音。
// 刷新判定与请求版本号是两件事：前者决定要不要再拉，后者决定回来的响应还算不算数。
// 空态、加载态与错误态互斥呈现，错误分支同样要保留 revision，消费者才不会误判成新一轮。
//
// 数据集来源：unstaged/staged/branch 来自服务端快照，last-turn 来自本地持久化的单轮文件变更。
//
// 阅读顺序：先看 shouldRefreshLiveGitData 的判定，再看 useEffect 的三条分支，最后看 useMemo 的投影。
//
// 以下不变量在改造本文件时必须逐条自检，任何一条被破坏都会让面板数据与仓库真实状态脱节。
// INV-01 面板是只读投影：不得写回 Git 事实，也不得缓存第二份 summary —— 守住它的位置：useEffect 内全部 setRepositoryState 调用 —— 改错故障：面板与服务端状态分叉，出现幽灵改动。
// INV-02 空骨架必须完整：createEmptySummary 与 createEmptyDatasets 的每个字段都要有默认值 —— 守住它的位置：两个 createEmpty 函数 —— 改错故障：消费者读取 undefined 字段直接崩溃。
// INV-03 刷新必须有闸门：shouldRefreshLiveGitData 为 false 时不得发起 RPC —— 守住它的位置：useEffect 中 shouldRefresh 早退分支 —— 改错故障：首屏与每次渲染都打一轮 Git，日志被刷爆。
// INV-04 断连不发查询：workspaceRpcEnabled 为 false 时只能交付空壳 —— 守住它的位置：useEffect 第一条分支 —— 改错故障：断连代理错误被放大成挂载期错误风暴。
// INV-05 版本号必须自增：每次进入刷新分支或断连分支都要推进 requestVersionRef —— 守住它的位置：requestVersionRef.current 自增与 requestVersion 赋值处 —— 改错故障：旧响应回写覆盖新 workspace 的数据。
// INV-06 过期响应必须丢弃：写入前同时检查 disposed 与版本号 —— 守住它的位置：then 与 catch 的首个判断 —— 改错故障：卸载后 setState，或慢请求覆盖新一轮结果。
// INV-07 清理函数不能省：effect 必须返回置 disposed 的回调 —— 守住它的位置：useEffect 末尾的 return 闭包 —— 改错故障：切换 workspace 后旧请求继续写状态。
// INV-08 依赖数组不能删项：gitService、workspaceKey、workspacePath、workspaceRpcEnabled 等都必须在内 —— 守住它的位置：useEffect 的依赖列表 —— 改错故障：切换仓库后仍展示上一个仓库的数据。
// INV-09 扩展数据只单向补拉：includeExtendedData 仅允许从 false 变 true 时触发刷新 —— 守住它的位置：shouldRefreshLiveGitData 的末尾返回 —— 改错故障：关闭面板时反复回拉 branch 与 identity。
// INV-10 一次刷新只发一个 RPC：不得拆成 summary/unstaged/staged 三次调用 —— 守住它的位置：refreshPromise 的构造处 —— 改错故障：每次刷新服务端跑三遍 git status。
// INV-11 branch 缺省共享同一空对象：comparison 为空时复用 EMPTY_BRANCH_COMPARISON —— 守住它的位置：buildRepositoryDatasets 调用处的兜底 —— 改错故障：每次渲染新建引用，下游 memo 全部失效。
// INV-12 section 顺序唯一：分组与展示顺序只认 SECTION_ORDER_BY_SOURCE —— 守住它的位置：buildSectionsForSource 的映射链 —— 改错故障：同一文件在面板里的位置发生漂移。
// INV-13 空 section 必须过滤：没有文件的 section 不进入数据集 —— 守住它的位置：buildSectionsForSource 末尾的类型守卫过滤 —— 改错故障：面板出现空的折叠标题。
// INV-14 路径换算单一入口：工作区相对路径统一走 toWorkspaceRelativePath —— 守住它的位置：createLastTurnChange 开头 —— 改错故障：Windows 与 POSIX 分隔符混用导致路径匹配失败。
// INV-15 快照缺失不得伪造补丁：没有快照时 availability 必须为 unavailable —— 守住它的位置：createLastTurnChange 中 diff 的构造 —— 改错故障：diff 视图展示空白却被当作无变更。
// INV-16 last-turn 只读：该数据集永远 readonly 且不参与暂存操作 —— 守住它的位置：buildLastTurnDataset 与 createEmptyDataset 的 last-turn 分支 —— 改错故障：用户对历史快照执行暂存，状态无处落地。
// INV-17 渲染期按 workspaceKey 降级：workspaceKey 不匹配时投影空态 —— 守住它的位置：useMemo 内的三元分支 —— 改错故障：旧 workspace 的 Git 路径被新远端 watcher 注册。
// INV-18 错误不吞：catch 必须记录 warn 并把消息写进 state.error —— 守住它的位置：refreshPromise 的 catch —— 改错故障：失败静默，面板一直转圈却无提示。
/* eslint-disable max-lines */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePersistedFileChange,
  ZCodePersistedFileSnapshot,
  ZCodeTaskChangeSummary,
  GitBranchComparison,
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@zcode/shared";
import { buildTurnChangeSummary, toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";

type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;

// [契约] 三个源的数据集名称固定为 unstaged/staged/branch，由 buildRepositoryDatasets 统一组装
// last-turn 不在本结构内，它由 useMemo 单独回填，避免本地派生数据与 Git 快照混在一处
// 新增源时必须同步 SECTION_ORDER_BY_SOURCE 与 buildSourceOptions，否则源选项与数据集错位
// 该类型只在模块内部使用，不导出，改动的影响面因此可控
// 字段保持必需而非可选，任何缺失都应在构造处补空数组而不是让消费端运行期判空
interface RepositoryDatasets {
  unstaged: GitPaneDataset;
  staged: GitPaneDataset;
  branch: GitPaneDataset;
}

// [权衡] 服务端未返回 branchComparison 时复用这一个空比较对象，避免每次渲染新建引用
// 该对象只含空数组与 null 字段，消费方按只读方式使用，不允许在其上追加内容
// 若将来需要区分没有 branch 数据与 branch 确实为空，应新增字段而不是修改这里
// 常量复用还能让 useMemo 的依赖比较保持稳定，不会因引用变化反复重算
// 改动此对象的形状必须同步 GitBranchComparison 的共享类型定义
const EMPTY_BRANCH_COMPARISON: GitBranchComparison = {
  baseRef: null,
  headRef: null,
  comparisonLabel: null,
  changes: [],
};

interface GitLiveDataRefreshInput {
  workspacePath: string;
  workspaceKey: string;
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
}

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

// [契约] dataset 的 id 与键名可能不一致：last-turn 由 createEmptyDataset 构造后放进同名键
// readonly 表示该源不允许交互式暂存或取消暂存，UI 读取后据此禁用对应操作
// sections 永远按 SECTION_ORDER_BY_SOURCE 的顺序排列，空 section 在构建阶段就被过滤掉
// comparisonLabel 只对 branch 源有意义，其余源保持缺省，不要用它做通用标签
// turnIndex 只对 last-turn 有意义，不要用它推断其他源的轮次
export interface GitPaneDataset {
  id: GitChangeSourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  turnIndex?: number | null;
}

export interface GitPaneSourceOption {
  id: GitChangeSourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitChangeSourceId, GitPaneDataset>;
}

// [契约] section 顺序是面板分组展示的唯一来源，不要在组件里再写一份排序逻辑
// unstaged 源必须依次覆盖 unstaged、untracked、conflicted 三类，漏掉任何一类都会让文件消失
// branch 源只有 branch 一个 section，避免把分支差异混进工作区语义
// 该映射的键是三个可编辑源，last-turn 由独立的构建函数处理，不在此登记
// 新增 GitChangeSectionId 时先在这里登记，再补 buildSectionsForSource 的分组逻辑
const SECTION_ORDER_BY_SOURCE: Record<GitRepositorySourceId, readonly GitChangeSectionId[]> = {
  unstaged: ["unstaged", "untracked", "conflicted"],
  staged: ["staged"],
  branch: ["branch"],
};

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

// [失败路径] 错误对象可能来自远端序列化，instanceof Error 失配时要退回到 message 字段探测
// 错误文案为空字符串时继续退回 name 与 String，避免把空串当成有效信息展示
// 这里只做展示用途的提取，不记录日志，日志由调用点带上 workspacePath 输出
// 不要在此吞掉异常，任何分支都必须返回字符串
// 非对象、符号、循环引用等输入由 String 兜底，保证函数总有返回值
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function sumSectionCount(sections: readonly GitPaneSection[]): number {
  return sections.reduce((count, section) => count + section.changes.length, 0);
}

// [权衡] 纯新增与纯删除用增删行数推断，其余一律视为 modified，这是对 Git status 的近似
// 文件重命名会表现为 modified，因为持久化快照里没有 rename 信息可用于判定
// 新增与删除行数都为 0 的文件归入 modified，UI 侧不应据此隐藏条目
// 该推断只服务 last-turn 数据集，真实源直接使用服务端返回的 kind
// 不要把这里改成读取 diff，那会把同步的 useMemo 变成异步链路
function inferGitKind(added: number, removed: number): GitFileChange["kind"] {
  if (added > 0 && removed === 0) {
    return "added";
  }

  if (removed > 0 && added === 0) {
    return "deleted";
  }

  return "modified";
}

// [契约] 空 summary 的 repoRoot 与 workspacePath 相同、workspaceInRepoPath 为点，表示尚未探测
// isGitAvailable 与 isRepository 同时为 false，消费方据此展示未初始化提示
// branchName 与 trackingBranchName 为 null 而不是空串，避免被当成真实分支名
// ahead、behind 归零且 isDirty 为 false，防止首屏闪出错误的徽标计数
// 该函数必须是纯函数，任何内部缓存都会让空态在不同 workspace 之间串味
function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(id: GitChangeSourceId, readonly: boolean): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitChangeSourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
    "last-turn": createEmptyDataset("last-turn", true),
  };
}

// [契约] 源选项的计数来自 sumSectionCount，只统计当前投影内的文件数
// branch 源标注 readonly 为 true，必须与数据集里的 readonly 保持一致
// disabled 目前恒为 false，保留该字段是为了后续接入不可用源时无需改签名
// 选项顺序固定为 unstaged、staged、branch、last-turn，与面板标签顺序一致
// 不要在选项里附带文件列表，那会让大仓库每次刷新都复制整棵结构
function buildSourceOptions(
  datasets: Record<GitChangeSourceId, GitPaneDataset>,
): GitPaneSourceOption[] {
  return [
    {
      id: "unstaged",
      count: sumSectionCount(datasets.unstaged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "staged",
      count: sumSectionCount(datasets.staged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "branch",
      count: sumSectionCount(datasets.branch.sections),
      readonly: true,
      disabled: false,
      comparisonLabel: datasets.branch.comparisonLabel,
    },
    {
      id: "last-turn",
      count: sumSectionCount(datasets["last-turn"].sections),
      readonly: true,
      disabled: false,
    },
  ];
}

function createInitialState(
  workspacePath: string,
  options?: {
    workspaceKey?: string;
    loading?: boolean;
    error?: string | null;
    revision?: number;
  },
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey: options?.workspaceKey ?? workspacePath,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: options?.loading ?? true,
    error: options?.error ?? null,
    revision: options?.revision ?? 0,
    sourceOptions: buildSourceOptions(datasets),
    datasets,
  };
}

// [契约] 该函数把 GitFileChange 升级为带 diff 的 pane 条目，diff 缺省为 null
// 使用展开而非逐字段拷贝，保证共享类型新增字段时这里自动跟上
// diff 的默认值必须是 null，不能用空对象冒充可用补丁
// 不要在内部做深拷贝，Git 快照在本次刷新内视为只读
// 调用方只有 buildSectionsForSource 与 last-turn 的构建路径
function toPaneFileChange(
  change: GitFileChange,
  diff: GitDiffResult | null = null,
): GitPaneFileChange {
  return {
    ...change,
    diff,
  };
}

// [事务] 先按 section 分桶再按固定顺序映射，最后过滤空桶，保证一次投影内顺序稳定
// 排序使用 localeCompare 比较 workspaceRelativePath，让同 section 内的结果可预期
// 分组 Map 的键来自 change.section，未知 section 会被静默丢弃，新增类型须同步顺序表
// 不能改成先过滤再排序的写法，那会改变每个 section 的引用并导致下游重复渲染
// 返回处的类型守卫过滤确保调用方拿到的元素一定非空
function buildSectionsForSource(
  sourceId: GitRepositorySourceId,
  changes: GitFileChange[],
): GitPaneSection[] {
  const grouped = new Map<GitChangeSectionId, GitPaneFileChange[]>();
  for (const change of changes) {
    const sectionChanges = grouped.get(change.section) ?? [];
    sectionChanges.push(toPaneFileChange(change));
    grouped.set(change.section, sectionChanges);
  }

  return SECTION_ORDER_BY_SOURCE[sourceId]
    .map((sectionId) => {
      const sectionChanges = grouped.get(sectionId);
      if (!sectionChanges || sectionChanges.length === 0) {
        return null;
      }

      sectionChanges.sort((left, right) =>
        left.workspaceRelativePath.localeCompare(right.workspaceRelativePath),
      );

      return {
        id: sectionId,
        changes: sectionChanges,
      };
    })
    .filter((section): section is GitPaneSection => Boolean(section));
}

// [契约] 三个源在同一时刻基于同一份快照构建，不允许跨请求拼接
// branchComparison.changes 直接作为 branch 源输入，不再做二次过滤
// comparisonLabel 原样透传，null 表示当前没有可比基线
// 这里不构造 last-turn，因为它依赖 React 侧的持久化快照，属于本地派生
// 函数保持无副作用，不读 ref、不发请求
function buildRepositoryDatasets(options: {
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison;
}): RepositoryDatasets {
  return {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: buildSectionsForSource("unstaged", options.unstagedChanges),
    },
    staged: {
      id: "staged",
      readonly: false,
      sections: buildSectionsForSource("staged", options.stagedChanges),
    },
    branch: {
      id: "branch",
      readonly: true,
      sections: buildSectionsForSource("branch", options.branchComparison.changes),
      comparisonLabel: options.branchComparison.comparisonLabel,
    },
  };
}

// [契约] 路径换算统一走 toWorkspaceRelativePath，repo 相对路径与工作区相对路径同值
// 快照缺失时把 availability 标为 unavailable，而不是伪造一份空补丁
// beforeContent 与 afterContent 允许为 null，UI 侧需按不可用渲染
// section 固定为 last-turn，kind 由增删行数推断
// isStaged、isUntracked、isConflicted 全部为 false，因为这是历史快照而非当前工作区状态
function createLastTurnChange(
  workspacePath: string,
  snapshotByPath: Map<string, ZCodePersistedFileSnapshot>,
  file: ZCodeTaskChangeSummary["files"][number],
): GitPaneFileChange {
  const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
  const snapshot = snapshotByPath.get(file.path);

  return {
    path: file.path,
    repoRelativePath: relativePath,
    workspaceRelativePath: relativePath,
    kind: inferGitKind(file.added, file.removed),
    section: "last-turn",
    added: file.added,
    removed: file.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: {
      path: file.path,
      availability: snapshot ? "patch" : "unavailable",
      patch: null,
      beforeContent: snapshot?.beforeContent ?? null,
      afterContent: snapshot?.afterContent ?? null,
      summary: null,
    },
  };
}

// [契约] 先用文件路径建快照索引，再映射 summary.files，单次遍历完成
// summary 为空时返回空 sections，而不是省略该字段
// turnIndex 原样透传，null 表示没有可对应的轮次
// 该数据集只读，禁止在这里触发任何服务调用
// 快照索引只服务本次构建，不提升到 hook 级缓存，避免与持久化层形成第二份事实
function buildLastTurnDataset(options: {
  workspacePath: string;
  turnIndex: number | null;
  fileChange: ZCodePersistedFileChange | null;
  summary: ZCodeTaskChangeSummary | null;
}): GitPaneDataset {
  const snapshotByPath = new Map<string, ZCodePersistedFileSnapshot>(
    options.fileChange?.snapshots.map((snapshot) => [snapshot.path, snapshot]) ?? [],
  );

  return {
    id: "last-turn",
    readonly: true,
    turnIndex: options.turnIndex,
    // 关键业务逻辑：上一轮更改继续优先复用 ZCode Agent 已持久化的单轮文件快照，
    // 这样 Git pane 接入真实仓库数据后，agent 视角的只读审阅链路仍然保持独立稳定。
    sections: options.summary
      ? [
          {
            id: "last-turn",
            changes: options.summary.files.map((file) =>
              createLastTurnChange(options.workspacePath, snapshotByPath, file),
            ),
          },
        ]
      : [],
  };
}

// [并发] 该判定只回答要不要再拉一次，不负责取消在途请求，取消由请求版本号完成
// workspaceRpc 关闭时一律不刷新，开启后首次必须刷新，因为上一次的可用性不可信
// workspacePath、workspaceKey、refreshToken 任一变化都要刷新
// includeExtendedData 只允许从 false 变 true 触发，反向变化交给本地重投影承担
// 改动比较项时必须同步 useEffect 的依赖数组，否则判定与实际触发会不一致
export function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) {
    return false;
  }

  if (!previous || !previous.workspaceRpcEnabled) {
    return true;
  }

  if (previous.workspacePath !== next.workspacePath) {
    return true;
  }

  if (previous.workspaceKey !== next.workspaceKey) {
    return true;
  }

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // 关键业务逻辑：Git pane 关闭时不应该因为“少拿 branch/identity”反向触发一轮真实 Git。
  // 只有从关闭 -> 打开时，才补拉扩展数据；task/last-turn 的切换则只走本地数据重组。
  return !previous.includeExtendedData && next.includeExtendedData;
}

export function useGitRepository(options: {
  workspacePath: string;
  activeTaskId: string | null;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // store 收尾：per-turn 变更摘要 map（setPerTurnSummaries/setPerTurnFileChanges）
  // 的写入链路随旧 ChatView 流订阅删除，store 不再保存该派生态（删除前也恒为空）。
  // "last-turn" 数据集保留空态骨架，待 v4 投影的 per-turn 变更面接入后回填。
  // [状态] 初始状态按当前 workspace 懒构造，避免首次渲染出现其他 workspace 的残留
  // initializer 只执行一次，后续 workspace 变化靠 effect 重建而不是重新挂载组件
  // 不要在 initializer 里发请求，渲染阶段必须保持纯
  // loading 默认为 true，让首帧呈现加载态而不是一个空的仓库视图
  // revision 从 0 起算，与服务端语义无关，仅用于消费方的失效判断
  const [repositoryState, setRepositoryState] = useState<GitPaneRepositoryState>(() =>
    createInitialState(workspacePath, { workspaceKey }),
  );
  // [并发] 版本号是丢弃过期响应的唯一依据，不要在它之外再造一个取消开关
  // 每次进入真实刷新分支才自增，断连分支也要自增以作废在途请求
  // 比较时用全等比较快照版本，不能用大于等于，否则连续两次刷新会被当成同一个
  // 该 ref 不参与渲染，不要改成 state，否则每次请求都会触发一次额外渲染
  // 清理函数只置 disposed，不动版本号，避免卸载后误伤下一轮
  const requestVersionRef = useRef(0);
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);
  const lastFileChangeEntry = null;
  const lastSummaryEntry = null;

  // [资源] 本 effect 的唯一清理动作是置 disposed，防止卸载后继续 setState
  // 依赖数组必须包含 gitService、workspaceKey、workspacePath、workspaceRpcEnabled 等全部输入
  // 删掉任何一项都会让面板停留在上一个 workspace 的数据上
  // effect 内不要直接 await，异步链路全部以 promise 加 void 的方式接续
  // 三条分支（断连、无需刷新、正常刷新）都必须显式返回或保持可清理
  useEffect(() => {
    const nextRefreshInput: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };

    if (!workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
      // 断连远端 workspace 可以展示 Git 面板空壳，但不能在 session 未恢复前
      // 主动查询远端 Git，否则会把断连代理错误放大成每次首屏挂载的日志噪音。
      setRepositoryState((current) =>
        createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          error: null,
          revision: current.revision,
        }),
      );
      return;
    }

    const shouldRefresh = shouldRefreshLiveGitData(
      lastLiveRefreshInputRef.current,
      nextRefreshInput,
    );
    lastLiveRefreshInputRef.current = nextRefreshInput;
    if (!shouldRefresh) {
      return;
    }

    // [失败路径] disposed 与版本号是两道独立闸门，缺一都可能写入过期状态
    // 成功分支与错误分支都要先检查这两者再写状态
    // catch 里先做闸门检查再记日志，避免为已丢弃的请求刷错误日志
    // 错误分支重建初始状态时要保留当前 revision，避免消费方误判为新一轮
    // 不要用 finally 统一收尾，成功与失败的状态语义并不相同
    let disposed = false;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setRepositoryState((current) =>
      current.workspaceKey === workspaceKey
        ? {
            ...current,
            loading: true,
            error: null,
          }
        : createInitialState(workspacePath, { workspaceKey }),
    );

    // agent 写文件会触发 Git 自动刷新。这里不能拆成 summary/unstaged/staged
    // 三个 RPC，因为服务端每个 RPC 都会重新跑 git status，日志里会形成一轮一组三连。
    // 统一走 refresh，让一次状态快照产出 header 和 Git pane 需要的基础数据。
    // [事务] 一次 refresh 同时产出 header 与 pane 所需数据，避免拆成三个 RPC 触发三轮 git status
    // includeExtendedData 决定是否附带 identity 与 branch comparison，首屏不预取
    // promise 在创建处即发起，不 await，保证后续 then 链能被清理标记覆盖
    // 服务端失败由下游 catch 统一转成错误态
    // 不要在参数里塞 UI 关注点，服务层只接受路径与开关
    const refreshPromise = gitService.refresh({
      workspacePath,
      includeIdentity: includeExtendedData,
      includeBranchComparison: includeExtendedData,
    });

    // 关键业务逻辑：header 常驻时只需要 summary + staged/unstaged 统计；
    // branch comparison 与 identity 只在真正展开 Git pane 后再拉取，避免首屏预取整套 Git pane 数据。
    void refreshPromise
      .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const repositoryDatasets = buildRepositoryDatasets({
          unstagedChanges,
          stagedChanges,
          branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
        });
        const datasets: Record<GitChangeSourceId, GitPaneDataset> = {
          ...repositoryDatasets,
          "last-turn": createEmptyDataset("last-turn", true),
        };

        setRepositoryState({
          workspaceKey,
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: {
            enabled: false,
          },
          loading: false,
          error: null,
          revision: requestVersion,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", {
          workspacePath,
          error: message,
        });
        setRepositoryState((current) => ({
          ...createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: current.revision,
          }),
        }));
      });

    return () => {
      disposed = true;
    };
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // [契约] 渲染阶段按 workspaceKey 投影空态，避免旧机器的路径被新远端注册
  // datasets 先浅拷贝再覆盖 last-turn，防止直接修改 state 里的原始引用
  // 依赖数组包含 repositoryState、workspaceKey、workspacePath 与两个本地条目
  // last-turn 的构建放在 memo 内，保证同一快照只计算一次
  // 删掉 workspacePath 依赖会让路径换算沿用旧工作区，产出错位的相对路径
  return useMemo(() => {
    // useEffect 在 workspace 切换后的 commit 才会清理旧状态。render 阶段先按
    // workspaceKey 投影为空状态，避免旧机器的 Git 路径通过新远端 fileWatcherService 注册。
    const currentRepositoryState =
      repositoryState.workspaceKey === workspaceKey
        ? repositoryState
        : createInitialState(workspacePath, { workspaceKey });
    const datasets = {
      ...currentRepositoryState.datasets,
    };
    const lastTurnIndex = lastFileChangeEntry?.[0] ?? lastSummaryEntry?.[0] ?? null;
    const lastFileChange = lastFileChangeEntry?.[1] ?? null;
    const lastTurnSummary = buildTurnChangeSummary(lastFileChange) ?? lastSummaryEntry?.[1] ?? null;

    datasets["last-turn"] = buildLastTurnDataset({
      workspacePath,
      turnIndex: lastTurnIndex,
      fileChange: lastFileChange,
      summary: lastTurnSummary,
    });

    return {
      ...currentRepositoryState,
      sourceOptions: buildSourceOptions(datasets),
      datasets,
    };
  }, [lastFileChangeEntry, lastSummaryEntry, repositoryState, workspaceKey, workspacePath]);
}
