/* eslint-disable max-lines -- Treemapping 需要在同一视图里组合活动树、矩形布局和详情区；等交互稳定后再拆分子组件。 */
// ============================================================================
// 职责边界
// 做：把一轮或全部对话里的文件活动（写、改、删、查看）聚合成目录树，用面积化矩形展示，
//     并提供节点选中与详情（diff、views、最近事件）。
// 不做：不采集活动（treemappingActivity 负责），不读 store（useTreemappingConversationMessage 负责），
//       不写任务状态，不发起任何文件操作。
// 依赖：TreemappingActivityModel（纯数据）、fileDisplay/path/i18n 纯函数、logger。
// 边界：组件只从 message 与 workspacePath 派生树；树是不可变快照，每次 message 变化整体重建，
//       选中态只保留路径字符串，不持有节点引用。
// 观测：除选中日志外无副作用，任何「看起来该优化」的 memo 依赖都要先确认 message 身份语义。
// 布局：面积权重集中在四个尺度常量与 getAreaSideWeight，视觉调整只能从这两处入手。
// 失败：模型为空时渲染空状态，不抛错；树的任何字段缺失都按 0 处理。
//
// INV 不变量表
// INV-01 断言：树只由 buildTree 一次性构建，选中状态只存路径不存节点引用 —— 守住它的位置：selectedPath state —— 改错故障：模型刷新后选中指向旧树节点，详情显示过期数据。
// INV-02 断言：选定节点必须回落到 findFirstFile 再回落到树根 —— 守住它的位置：selectedNode 表达式 —— 改错故障：空选时详情区崩溃或显示 undefined。
// INV-03 断言：目录必须先于文件排序，同类按 diff 降序再按路径字典序 —— 守住它的位置：sortTree comparator —— 改错故障：排序不稳定，每次渲染顺序抖动。
// INV-04 断言：目录权重必须聚合子树 diff，不能只看目录自身 —— 守住它的位置：getDirectoryWeight —— 改错故障：大改动目录被排到小文件之后，面积失真。
// INV-05 断言：面积权重必须用 sqrt(weight) 同时影响宽高 —— 守住它的位置：getAreaSideWeight 与 flexBasis/minHeight —— 改错故障：大改动被挤成长条，视觉比例误导。
// INV-06 断言：diff 为 0 的文件不得权重为 0 —— 守住它的位置：getFileWeight —— 改错故障：零权重节点塌缩到不可见且不可点击。
// INV-07 断言：kind 只存在于文件节点，目录不得复用文件色 —— 守住它的位置：getFileTone 参数类型 —— 改错故障：目录误用文件色，层级不可辨。
// INV-08 断言：pending 计数必须按子树累加 —— 守住它的位置：summarizeNode —— 改错故障：目录上看不到子文件的等待指示。
// INV-09 断言：views 汇总必须包含目录自身 views 再叠加子节点 —— 守住它的位置：summarizeNode 初值 —— 改错故障：目录自身的浏览次数被漏计。
// INV-10 断言：树路径必须统一用斜杠分隔并去掉空段 —— 守住它的位置：getNodePathParts —— 改错故障：Windows 反斜杠路径生成重复节点。
// INV-11 断言：getParentPath 在无分隔符时必须返回 ROOT_PATH 而不是空串 —— 守住它的位置：getParentPath —— 改错故障：顶层文件挂到空路径目录，出现幽灵根。
// INV-12 断言：ensureDirectory 必须逐段累积路径匹配 —— 守住它的位置：ensureDirectory 循环 —— 改错故障：同名目录跨层级被合并。
// INV-13 断言：selectedPath 必须与节点 path 完全相等才命中 —— 守住它的位置：findNode —— 改错故障：叶子名相同导致跨目录误选。
// INV-14 断言：选中态视觉不得依赖 ring 或 box-shadow —— 守住它的位置：FileBox/DirectoryBox 的 !border-primary —— 改错故障：全局 focus reset 清掉 ring，选中不可见。
// INV-15 断言：最近触达只能用边框色表达，与 hover/选中同一视觉语言 —— 守住它的位置：FileBox className —— 改错故障：与 focus reset 冲突，高亮随机消失。
// INV-16 断言：目录容器不得有 hover 变色 —— 守住它的位置：DirectoryBox className —— 改错故障：子文件 hover 时所有祖先目录一起变色。
// INV-17 断言：flexGrow 与 flexBasis/minHeight 必须同源，都来自同一个 weight —— 守住它的位置：两个组件的 style —— 改错故障：面积与高度权重不一致，布局抖动。
// INV-18 断言：isLive 必须由 source.kind 与 message.streaming 共同决定 —— 守住它的位置：isLive 表达式 —— 改错故障：快照被标成 live，用户以为数据实时。
// INV-19 断言：事件列表只取最近 4 条且 key 必须含 index —— 守住它的位置：events.slice(-4).map —— 改错故障：同 toolCallId 多事件时 key 冲突，渲染错位。
// INV-20 断言：目录点击必须 stopPropagation —— 守住它的位置：DirectoryBox onClick —— 改错故障：点文件同时改变目录选中，详情区跳变。
// ============================================================================
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { FolderIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  FileDisplayInline,
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTreemappingActivityModel,
  type TreemappingActivityEvent,
  type TreemappingActivityModel,
  type TreemappingFileActivity,
  type TreemappingFileKind,
} from "@/lib/treemappingActivity.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { TreemappingSidePaneSource } from "@/lib/workspaceSidePane.js";
import { useTreemappingConversationMessage } from "@/v4/useTreemappingConversationMessage.js";

// [契约] 文件节点是 TreemappingFileActivity 的交叉类型：字段全部来自模型，组件不新增业务字段。
// type 判别字段只用于收窄，不参与渲染排序，改字段名会同时影响 summarizeNode 与 findNode。
//
// [边界] 目录节点持有 children/events 与聚合值 views/lastTouchedAt，
// 文件节点不持有 children——不要为了统一递归给文件也加空数组，会让类型收窄失效。
//
// [权衡] 路径是唯一身份键：同叶子名不同目录必须能区分，所以不要用文件名做 key。
// [资源] 树只存在于内存，不做持久化，避免与 conversation 投影产生第二份事实。
interface TreemappingFileNode extends TreemappingFileActivity {
  type: "file";
}

interface TreemappingDirectoryNode {
  type: "directory";
  path: string;
  views: number;
  lastTouchedAt: number;
  children: TreemappingNode[];
  events: TreemappingActivityEvent[];
}

type TreemappingNode = TreemappingDirectoryNode | TreemappingFileNode;

interface TreemappingSummary {
  added: number;
  removed: number;
  views: number;
  files: number;
  written: number;
  modified: number;
  deleted: number;
  pending: number;
}

// [权衡] 四个尺度常量共同决定视觉面积，任意一个单独放大都会让「改动」与「查看」失衡。
// VIEWED_ONLY_WEIGHT 与 MIN_CHANGE_WEIGHT 的比值决定无 diff 文件能否被看见。
//
// [契约] getAreaSideWeight 用 sqrt(weight)：面积是边长的平方，
// 直接线性映射会让大改动目录的面积占比远超其 diff 占比。
// [边界] DIRECTORY_BASIS_SCALE 与 FILE_BASIS_SCALE 不同是刻意的：目录有内边距与标题行，
// 同样的权重下目录需要更大的基准宽度。
//
// [失败路径] 权重若被改成 0，clampSize 仍会给最小宽度，但 flexGrow 为 0 会让块塌缩；
// 所以 getFileWeight 与 getDirectoryWeight 都不能返回 0（见 INV-06）。
const VIEWED_ONLY_WEIGHT = 6;
const MIN_CHANGE_WEIGHT = 14;
const ROOT_PATH = ".";
const DIRECTORY_BASIS_SCALE = 64;
const DIRECTORY_HEIGHT_SCALE = 34;
const FILE_BASIS_SCALE = 52;
const FILE_HEIGHT_SCALE = 24;

// [契约] 新建目录必须初始化全部聚合字段：views 为 0、lastTouchedAt 为 0、events 为空数组。
// 漏掉 events 会在 buildTree 的 push(...events) 处抛错，整页白屏。
//
// [并发] 这里只创建不查重：去重由 ensureDirectory 的 findChildDirectory 负责，
// 两处都做去重会让查找成本翻倍。
// [边界] path 由调用方保证已归一（斜杠分隔），本函数不再处理反斜杠。
function createDirectory(path: string): TreemappingDirectoryNode {
  return {
    type: "directory",
    path,
    views: 0,
    lastTouchedAt: 0,
    events: [],
    children: [],
  };
}

function getNodePathParts(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function findChildDirectory(
  directory: TreemappingDirectoryNode,
  path: string,
): TreemappingDirectoryNode | null {
  const child = directory.children.find(
    (node): node is TreemappingDirectoryNode => node.type === "directory" && node.path === path,
  );
  return child ?? null;
}

// [契约] 空路径与 ROOT_PATH 都返回根节点：调用方传点号表示工作区根，不能新建子目录。
//
// [并发] 必须逐段累积路径（a → a/b → a/b/c）再查找，不能按整段字符串拼接口径查找：
// 后者会让同名目录跨层级被合并，树出现错误的父子关系。
// [权衡] 每次 lookup 都遍历当前层 children，目录数量级下足够；
// 改成全局 Map 会和 findNode 形成两套索引，容易不一致。
// [失败路径] 命中已存在目录时 continue，但必须更新 current；漏掉这一步会让后续段挂到根上。
//
// [边界] 本函数不做排序，排序统一在 buildTree 末尾调用 sortTree，避免每次插入都重排子树。
// [资源] 目录节点是可变对象，构建期直接 push children，构建完成后不再修改。
function ensureDirectory(
  root: TreemappingDirectoryNode,
  directoryPath: string,
): TreemappingDirectoryNode {
  if (!directoryPath || directoryPath === ROOT_PATH) {
    return root;
  }

  let current = root;
  const parts = getNodePathParts(directoryPath);
  let accumulatedPath = "";
  for (const part of parts) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
    const existing = findChildDirectory(current, accumulatedPath);
    if (existing) {
      current = existing;
      continue;
    }

    const next = createDirectory(accumulatedPath);
    current.children.push(next);
    current = next;
  }
  return current;
}

function getParentPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex > 0 ? path.slice(0, slashIndex) : ROOT_PATH;
}

// [契约] 树构建分两遍：先目录（保证父先存在），再文件（挂到 getParentPath 目录）。
// 顺序不能反——先插文件会创建出只有文件的目录，随后目录活动再插入会重复节点。
// [事务] directoryByPath 只服务于「快速确认目录已建」，不是渲染索引；
// 不要用它做 findNode，两张映射在 sortTree 之后会失去一致性。
// [并发] 目录活动可能重复出现（同一 path 多条事件），views 与 events 必须累加而不是覆盖。
// lastTouchedAt 取最大值，覆盖会让时间戳回退，recentlyTouched 高亮闪一下就消失。
//
// [失败路径] 文件没有父目录活动时 ensureDirectory 会按路径补建中间目录，
// 补建目录 views 为 0，不能因此从树中剔除——否则文件失去挂载点。
//
// [边界] 根节点 label 来自 workspaceLabel，空串回退 ROOT_PATH：展示名不参与路径计算。
// [资源] 每次 model 变化都重建整棵树，不做增量合并，复杂度可控且无脏状态。
function buildTree(
  model: TreemappingActivityModel,
  workspaceLabel: string,
): TreemappingDirectoryNode {
  const root = createDirectory(workspaceLabel || ROOT_PATH);
  const directoryByPath = new Map<string, TreemappingDirectoryNode>([[ROOT_PATH, root]]);

  for (const directoryActivity of model.directories) {
    const directory = ensureDirectory(root, directoryActivity.path);
    directoryByPath.set(directoryActivity.path, directory);
    directory.views += directoryActivity.views;
    directory.lastTouchedAt = Math.max(directory.lastTouchedAt, directoryActivity.lastTouchedAt);
    directory.events.push(...directoryActivity.events);
  }

  for (const file of model.files) {
    const parentDirectory = ensureDirectory(root, getParentPath(file.path));
    parentDirectory.children.push({
      ...file,
      type: "file",
    });
  }

  sortTree(root);
  return root;
}

// [契约] 目录必须先于文件（type 比较），这是层级可读性的前提，不是视觉偏好。
// [并发] 同类按 diff 降序，再按 path 字典序兜底：缺少字典序兜底时
// 相同 diff 的节点顺序依赖 sort 实现细节，跨引擎渲染顺序不同。
//
// [权衡] summarizeNode 在 comparator 里被反复调用（每次比较两次），
// 目录规模小可以接受；若要优化必须先把 summary 缓存到节点上，而不是改比较逻辑。
//
// [失败路径] 相等时返回 0 会让顺序不稳定，所以必须显式用 localeCompare 给出全序。
// [边界] 只递归目录，文件没有 children；递归前用 type 收窄，避免对文件访问 children。
// [资源] sortTree 原地排序并返回 void，调用方不要假设它返回新树。
function sortTree(node: TreemappingDirectoryNode) {
  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    const leftDiff = summarizeNode(left).added + summarizeNode(left).removed;
    const rightDiff = summarizeNode(right).added + summarizeNode(right).removed;
    if (leftDiff !== rightDiff) {
      return rightDiff - leftDiff;
    }
    return left.path.localeCompare(right.path);
  });

  for (const child of node.children) {
    if (child.type === "directory") {
      sortTree(child);
    }
  }
}

// [契约] 文件直接映射自身字段；目录把所有子节点汇总，并叠加目录自身的 views。
// [并发] 目录的 views 初值必须是 node.views 而不是 0：
// 目录活动（不是文件）也贡献浏览数，从 0 开始会漏计（见 INV-09）。
// [事务] pending 是 pendingToolCallIds 长度的和，用来驱动目录上的等待指示；
// 只取节点自身会让目录看不到子文件的等待状态（见 INV-08）。
// [失败路径] 空目录的 reduce 初值决定返回值：added/removed/files 等必须为 0，
// 缺字段会得到 undefined，渲染成 NaN。
//
// [权衡] 每次调用都重新遍历子树，没有缓存；不要为了性能在树节点上挂 summary，
// 那会让树变成「数据 + 派生」双重事实，message 变化时需要手动失效。
// [边界] written/modified/deleted 是互斥计数，三者和等于 files 中有 kind 的节点数。
// [资源] 返回新对象，不复用子节点 summary 引用，避免调用方原地修改污染树。
function summarizeNode(node: TreemappingNode): TreemappingSummary {
  if (node.type === "file") {
    return {
      added: node.added,
      removed: node.removed,
      views: node.views,
      files: 1,
      written: node.kind === "written" ? 1 : 0,
      modified: node.kind === "modified" ? 1 : 0,
      deleted: node.kind === "deleted" ? 1 : 0,
      pending: node.pendingToolCallIds.length,
    };
  }

  return node.children.reduce<TreemappingSummary>(
    (summary, child) => {
      const childSummary = summarizeNode(child);
      return {
        added: summary.added + childSummary.added,
        removed: summary.removed + childSummary.removed,
        views: summary.views + childSummary.views,
        files: summary.files + childSummary.files,
        written: summary.written + childSummary.written,
        modified: summary.modified + childSummary.modified,
        deleted: summary.deleted + childSummary.deleted,
        pending: summary.pending + childSummary.pending,
      };
    },
    {
      added: 0,
      removed: 0,
      views: node.views,
      files: 0,
      written: 0,
      modified: 0,
      deleted: 0,
      pending: 0,
    },
  );
}

function getDiffCount(summary: Pick<TreemappingSummary, "added" | "removed">): number {
  return summary.added + summary.removed;
}

// [契约] 有 diff 时取 diff 与 MIN_CHANGE_WEIGHT 的较大者，无 diff 时按 kind 区分查看与其他。
//
// [权衡] 用 Math.max 而不是直接返回 diff：diff 为 1 的文件若按 1 计权重，
// 其面积会小到不可点击；下限保证所有改动可见。
//
// [失败路径] 本函数不允许返回 0：零权重会让 flex-grow 失效，节点塌缩（见 INV-06）。
//
// [边界] deleted 文件同样参与 diff 权重，不要因为已删除而降低权重——
// 删除往往是最需要被看到的活动。
// [资源] `getFileWeight` 是纯函数；渲染期可调用，复杂度 O(1)。
function getFileWeight(node: TreemappingFileNode): number {
  const diffCount = node.added + node.removed;
  if (diffCount > 0) {
    return Math.max(diffCount, MIN_CHANGE_WEIGHT);
  }
  return node.kind === "viewed" ? VIEWED_ONLY_WEIGHT : MIN_CHANGE_WEIGHT;
}

function getDirectoryWeight(node: TreemappingDirectoryNode): number {
  const summary = summarizeNode(node);
  const diffCount = getDiffCount(summary);
  if (diffCount > 0) {
    return Math.max(diffCount, MIN_CHANGE_WEIGHT);
  }

  return summary.views > 0 ? VIEWED_ONLY_WEIGHT : MIN_CHANGE_WEIGHT;
}

function getAreaSideWeight(weight: number): number {
  return Math.sqrt(Math.max(weight, 1));
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// [契约] 选中路径与节点 path 必须完全相等，不做大小写或分隔符归一：
// 树的 path 已由 buildTree 归一，宽松匹配会把不同节点视为同一个（见 INV-13）。
//
// [并发] 深度优先且遇文件直接返回 null：文件没有子树，继续递归会访问 undefined.children。
//
// [失败路径] 未命中返回 null，由调用方的空值合并回退；不要在内部回退到根节点，
// 那会让空选与「选中根」无法区分。
// [资源] 每次选中都全树遍历，节点规模小；不要为此维护 path 到节点的 Map。
function findNode(node: TreemappingNode, path: string): TreemappingNode | null {
  if (node.path === path) {
    return node;
  }

  if (node.type === "file") {
    return null;
  }

  for (const child of node.children) {
    const match = findNode(child, path);
    if (match) {
      return match;
    }
  }

  return null;
}

function findFirstFile(node: TreemappingNode): TreemappingFileNode | null {
  if (node.type === "file") {
    return node;
  }

  for (const child of node.children) {
    const file = findFirstFile(child);
    if (file) {
      return file;
    }
  }

  return null;
}

// [契约] 返回的是完整 Tailwind 类串（边框 + 背景 + 文字），调用方直接拼进 className。
// 新增 kind 必须同时加 i18n 的 treemapping.change 前缀键，否则标签回落成原始 key。
//
// [权衡] 颜色全部走语义 token（success/warning/destructive/file-node），
// 不写具体色值：写死颜色在深浅主题下会失去对比度。
// [失败路径] 未知 kind 落到默认分支而不是抛错：老快照可能含已删除的 kind，
// 抛错会让整棵树渲染失败。
// [边界] 这里只决定视觉，不决定排序或权重，三者改动需要一起评审。
function getFileTone(kind: TreemappingFileKind): string {
  if (kind === "written") {
    return "border-success/50 bg-success/15 text-foreground";
  }
  if (kind === "modified") {
    return "border-warning/50 bg-warning/20 text-foreground";
  }
  if (kind === "deleted") {
    return "border-destructive/60 bg-destructive/15 text-foreground";
  }

  return "border-file-node-foreground/45 bg-file-node text-foreground";
}

function getChangeLabel(kind: TreemappingFileKind, formatMessage: (id: string) => string) {
  return formatMessage(`treemapping.change.${kind}`);
}

function getEventActionLabel(
  action: TreemappingActivityEvent["action"],
  formatMessage: (id: string) => string,
) {
  if (action === "write") {
    return getChangeLabel("written", formatMessage);
  }
  if (action === "modify") {
    return getChangeLabel("modified", formatMessage);
  }
  if (action === "delete") {
    return getChangeLabel("deleted", formatMessage);
  }
  return getChangeLabel("viewed", formatMessage);
}

export function TreemappingPane({
  activeTaskId,
  workspacePath,
  workspaceIdentity,
  source,
}: {
  activeTaskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  source: TreemappingSidePaneSource;
}) {
  const { intl } = useZCodeIntl();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // store 收尾：消息源从旧 zcodeSessionStore 迁 v4 conversation 投影 rows。
  // 旧 source.kind === "message"（按 legacy messageId 锚定某条消息）的入口随旧
  // ChatView 一起删除，这里统一取最后一个 assistant 轮的活动。
  // [契约] 状态只有 selectedPath 一个；message/model/tree 全部是派生值，由 memo 计算。
  // 不要为 summary、selectedSummary 再建 state，那会产生第二份可漂移的事实。
  //
  // [并发] model 的依赖是 message 与 workspacePath：消息源返回的对象身份随流式更新变化，
  // memo 因此整体重算——这是预期行为，不要给 message 加深比较。
  //
  // [事务] 旧的按 messageId 锚定入口已随旧 ChatView 删除，这里统一取最后一个 assistant 轮；
  // 恢复旧入口需要同时恢复选择器，不能只加一个分支。
  //
  // [权衡] source.kind 为 current 与 message.streaming 都会让 isLive 为真：
  // 两者语义不同（范围 vs 流式中），合并判断是为了避免出现「live 但不更新」的空窗。
  // [边界] workspaceIdentity 只用于会话定位，不参与树路径计算（路径仍用 workspacePath）。
  // [资源] 每次 message 变化重建树，旧树由 GC 回收；不要在树节点上挂 DOM 或 timer。
  // [失败路径] message 为 null 时模型为空，树只有根节点，UI 走空状态，不抛错。
  const message: TaskChatMessage | null = useTreemappingConversationMessage({
    sessionId: activeTaskId,
    workspacePath,
    workspaceIdentity,
  });
  const model = useMemo(
    () => buildTreemappingActivityModel(message, workspacePath),
    [message, workspacePath],
  );
  const tree = useMemo(
    () => buildTree(model, getPathLeaf(workspacePath) || workspacePath),
    [model, workspacePath],
  );
  // [契约] 回退链是 findNode → findFirstFile → 根节点，顺序不能变：
  // 空选时优先展示第一个文件，比展示空目录信息量更大。
  // [并发] selectedPath 可能指向已被删除的文件（message 刷新），此时 findNode 返回 null，
  // 回退到第一个文件而不是保持旧节点——旧节点引用会让详情区显示不存在的 diff。
  //
  // [失败路径] findFirstFile 也返回 null 时用 tree 兜底，保证 selectedNode 永不为 null，
  // 下游所有 selectedNode.path 才能无守卫访问。
  // [边界] 这里不在渲染期修正 selectedPath：改 state 会触发额外一轮 render；
  // 不在渲染期改 `selectedPath`：选中态留到下次点击自然对齐。
  // [资源] findNode 与 findFirstFile 各做一次遍历，规模小可接受。
  const selectedNode =
    (selectedPath ? findNode(tree, selectedPath) : null) ?? findFirstFile(tree) ?? tree;
  const handleSelectPath = useCallback(
    (path: string) => {
      logger.debug("[TreemappingPane] select node", {
        activeTaskId,
        path,
        previousPath: selectedNode.path,
        sourceKind: source.kind,
      });
      setSelectedPath(path);
    },
    [activeTaskId, selectedNode.path, source.kind],
  );
  const summary = summarizeNode(tree);
  const selectedSummary = summarizeNode(selectedNode);
  const isLive = source.kind === "current" || Boolean(message?.streaming);
  const formatMessage = (id: string) => intl.formatMessage({ id });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-ui-base font-medium">
              {intl.formatMessage({ id: "treemapping.title" })}
            </h2>
            <p className="truncate text-ui-base text-foreground-subtle">
              {source.kind === "current"
                ? intl.formatMessage({ id: "treemapping.scope.current" })
                : intl.formatMessage(
                    { id: "treemapping.scope.turn" },
                    {
                      turn: String(source.turnIndex !== undefined ? source.turnIndex + 1 : ""),
                    },
                  )}
            </p>
          </div>
          <span className="rounded-full border border-border px-2 py-0.5 text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: isLive ? "treemapping.badge.live" : "treemapping.badge.snapshot",
            })}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-ui-base">
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.files" })}
            value={summary.files}
          />
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.diff" })}
            value={<DiffCount added={summary.added} removed={summary.removed} />}
          />
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.views" })}
            value={summary.views}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {summary.files === 0 ? (
          <EmptyState runningWithoutPathCount={model.runningWithoutPathCount} />
        ) : (
          <DirectoryBox
            node={tree}
            depth={0}
            selectedPath={selectedNode.path}
            onSelect={handleSelectPath}
            formatMessage={formatMessage}
          />
        )}
      </div>

      <div className="border-t border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 flex-1 overflow-hidden">
            {selectedNode.type === "file" ? (
              <FileDisplayInline
                path={selectedNode.path}
                options={{
                  showFilePath: true,
                  className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                  fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                  filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                }}
              />
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="truncate font-mono text-ui-base font-medium text-foreground">
                  {selectedNode.path}
                </span>
              </span>
            )}
          </div>
          <DiffCount
            added={selectedSummary.added}
            removed={selectedSummary.removed}
            className="shrink-0 text-ui-base"
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
          <span>
            <span className="text-foreground-subtlest">
              {intl.formatMessage({ id: "treemapping.summary.views" })}:
            </span>{" "}
            <span className="font-mono text-foreground-subtle">{selectedSummary.views}</span>
          </span>
          {selectedNode.type === "file" ? (
            <span className="text-foreground-subtle">
              {getChangeLabel(selectedNode.kind, formatMessage)}
            </span>
          ) : (
            <span>
              <span className="text-foreground-subtlest">
                {intl.formatMessage({ id: "treemapping.summary.files" })}:
              </span>{" "}
              <span className="font-mono text-foreground-subtle">{selectedSummary.files}</span>
            </span>
          )}
        </div>
        {selectedNode.type === "file" && selectedNode.events.length > 0 ? (
          <div className="mt-2 max-h-24 overflow-auto rounded-lg border border-border bg-background/50">
            {selectedNode.events.slice(-4).map((event, index) => (
              <div
                key={`${event.toolCallId}-${event.action}-${index}`}
                className={cn(
                  "flex min-h-8 min-w-0 items-center justify-between gap-3 px-2 py-1.5 text-ui-base",
                  index > 0 && "border-t border-border/60",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {getEventActionLabel(event.action, formatMessage)}
                  </span>
                </span>
                <DiffCount added={event.added} removed={event.removed} className="shrink-0" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// [契约] label 与 value 都由调用方传入，组件不做 i18n 与格式化：
// 正负号格式属于 DiffCount 的职责，不要在这里二次格式化。
//
// [边界] 固定三列由父容器 grid-cols-3 决定，组件本身不设宽度；
// 新增第四列必须同时改父容器，否则会换行。
// [资源] 纯展示组件，无状态。
function SummaryCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <div className="truncate text-ui-base text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

function DiffCount({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}>
      <span className={added > 0 ? "text-diff-added" : "text-foreground-subtlest"}>+{added}</span>
      <span className={removed > 0 ? "text-diff-removed" : "text-foreground-subtlest"}>
        -{removed}
      </span>
    </span>
  );
}

function EmptyState({ runningWithoutPathCount }: { runningWithoutPathCount: number }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 text-center">
      {runningWithoutPathCount > 0 ? (
        <Loader2Icon className="size-4 animate-spin text-foreground-subtle" />
      ) : null}
      <div className="text-ui-base font-medium">
        {intl.formatMessage({ id: "treemapping.empty.title" })}
      </div>
      <div className="max-w-64 text-ui-base leading-5 text-foreground-subtle">
        {runningWithoutPathCount > 0
          ? intl.formatMessage(
              { id: "treemapping.empty.running" },
              { count: String(runningWithoutPathCount) },
            )
          : intl.formatMessage({ id: "treemapping.empty.description" })}
      </div>
    </div>
  );
}

// [契约] style 的 flexGrow、flexBasis、minHeight 全部来自同一个 weight：
// 三者不同源会让面积与高度表达不一致，resize 时布局抖动（见 INV-17）。
// [并发] depth 为 0（根）不设 flexBasis 与 minHeight：根容器需要撑满，
// 给它固定基准会让整个树被压缩到一角。
// [权衡] 目录容器不写 hover 样式：CSS hover 会同时命中所有祖先目录，
// 子文件 hover 时整条链路变色（见 INV-16）；悬停反馈只留给文件块。
// [失败路径] 点击必须 stopPropagation：目录嵌套，冒泡会让一次点击选中多层，
// 详情区在同一个事件里被改写多次。
// [边界] 选中态用 !border-primary 覆盖，感叹号是因为全局 focus reset。
// [资源] 递归渲染直接展开子树，不做虚拟化；深层目录规模受活动量限制。
function DirectoryBox({
  node,
  depth,
  selectedPath,
  onSelect,
  formatMessage,
}: {
  node: TreemappingDirectoryNode;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
  formatMessage: (id: string) => string;
}) {
  const summary = summarizeNode(node);
  const weight = getDirectoryWeight(node);
  const style: CSSProperties = {
    // 目录本身没有状态色，但面积要反映子树聚合 diff。
    // 之前宽度按 weight 线性增长，视觉比例几乎只看宽度；这里用 sqrt(weight) 同时影响宽高，
    // 让矩形面积更接近活动权重，而不是把大改动目录挤成长条。
    flexGrow: weight,
    flexBasis:
      depth === 0
        ? undefined
        : `${clampSize(getAreaSideWeight(weight) * DIRECTORY_BASIS_SCALE, 160, 360)}px`,
    minHeight:
      depth === 0
        ? undefined
        : `${clampSize(getAreaSideWeight(weight) * DIRECTORY_HEIGHT_SCALE, 96, 220)}px`,
  };

  return (
    <section
      style={style}
      className={cn(
        // CSS 的 :hover 会同时命中所有祖先目录，子文件 hover 时父目录也会变色。
        // 目录容器只表达层级和选中态，悬停反馈留给当前文件块，避免父级被子级 hover 牵连。
        "flex min-w-0 flex-col rounded-lg border-2 border-border p-2 transition-colors duration-150",
        depth > 0 && "flex-1",
        selectedPath === node.path && "!border-primary",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.path);
      }}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2 text-ui-base">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="truncate font-mono">
            {depth === 0 ? node.path : getPathLeaf(node.path)}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-baseline gap-1.5 text-foreground-subtle">
          <DiffCount added={summary.added} removed={summary.removed} />
          {node.views > 0 ? <span className="font-mono">· {node.views}v</span> : null}
        </span>
      </div>
      <div className="flex min-h-20 flex-1 flex-wrap content-stretch items-stretch gap-2">
        {node.children.map((child) =>
          child.type === "directory" ? (
            <DirectoryBox
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              formatMessage={formatMessage}
            />
          ) : (
            <FileBox
              key={child.path}
              node={child}
              selected={selectedPath === child.path}
              onSelect={onSelect}
              formatMessage={formatMessage}
            />
          ),
        )}
      </div>
    </section>
  );
}

// [契约] 选中与最近触达都用边框色表达，不用 ring：全局 focus reset 会用 !important 清掉
// outline 与 box-shadow，ring 也是 box-shadow，选中态会随机消失（见 INV-14/15）。
//
// [并发] recentlyTouched 依赖 Date.now() 与 lastTouchedAt 的差，只在渲染时求值；
// 它不会自动过期，message 更新触发的重渲染才会刷新，不要为此加 timer。
//
// [事务] style 的 flexGrow 与 minHeight 必须同源：只改一个会让大 diff 文件变成细长条。
//
// [权衡] 文件块是 button 而不是 div：原生可聚焦、可键盘激活；
// 改成 div 加 role 会失去 focus-visible 的浏览器语义。
//
// [失败路径] pendingToolCallIds 为空时不渲染指示点；判空必须用 length，
// 空数组是 truthy，写成节点真值判断会永远显示。
// [边界] title 里的增删数只是悬浮提示，与 DiffCount 同源但独立拼接。
// [资源] 图标来自 resolveFileDisplayDescriptor，纯函数且不发网络请求。
function FileBox({
  node,
  selected,
  onSelect,
  formatMessage,
}: {
  node: TreemappingFileNode;
  selected: boolean;
  onSelect: (path: string) => void;
  formatMessage: (id: string) => string;
}) {
  const diffCount = node.added + node.removed;
  const weight = getFileWeight(node);
  const recentlyTouched = Date.now() - node.lastTouchedAt < 2000;
  const descriptor = resolveFileDisplayDescriptor(node.path);
  const style: CSSProperties = {
    flexGrow: weight,
    flexBasis: `${clampSize(getAreaSideWeight(weight) * FILE_BASIS_SCALE, 88, 260)}px`,
    // 文件叶子用 sqrt(weight) 同时影响宽高，避免 diff 大小只体现在横向占比上。
    // 实际高度仍由父级 stretch 分配，这里只提供面积权重的下限信号。
    minHeight: `${clampSize(getAreaSideWeight(weight) * FILE_HEIGHT_SCALE, 58, 156)}px`,
  };

  return (
    <button
      type="button"
      title={`${node.path} · +${node.added}/-${node.removed} · ${node.views} views`}
      aria-pressed={selected}
      data-selected={selected ? "true" : undefined}
      style={style}
      className={cn(
        "relative min-w-20 flex-1 self-stretch rounded-md border-2 p-2 text-left text-ui-base transition-colors duration-150 hover:border-primary/60 focus-visible:border-primary focus-visible:outline-none",
        "animate-in fade-in zoom-in-95",
        getFileTone(node.kind),
        // 最近触达高亮之前使用 ring（box-shadow），点击后的 focus reset 会把它清掉；
        // 改为边框色后，近期触达、hover、选中都走同一种视觉语言。
        recentlyTouched && !selected && "border-primary/60",
        // 点击后文件块本身会获得 focus，而全局 focus reset 会用 !important 清掉
        // outline/box-shadow；Tailwind ring 也是 box-shadow，所以选中态不能继续依赖 ring。
        selected && "!border-primary",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.path);
      }}
    >
      {node.pendingToolCallIds.length > 0 ? (
        <span className="absolute right-2 top-2 size-2 animate-pulse rounded-full bg-current opacity-80" />
      ) : null}
      <span className="flex h-full min-h-0 flex-col justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-0.5 pr-3 leading-5">
          <span className="flex min-w-0 items-center gap-1.5">
            <FileDisplayIcon
              src={descriptor.fileIconSrc}
              size={14}
              className="size-3.5 shrink-0 opacity-90"
            />
            <span
              className={cn(
                "truncate font-mono font-medium",
                node.kind === "deleted" && "line-through",
              )}
            >
              {descriptor.fileName}
            </span>
          </span>
          {descriptor.filePath ? (
            <span className="truncate font-mono text-ui-base text-foreground-subtle opacity-90">
              {descriptor.filePath}
            </span>
          ) : null}
        </span>
        <span className="space-y-0.5 leading-5">
          <span className="block truncate">{getChangeLabel(node.kind, formatMessage)}</span>
          <span className="block truncate opacity-85">
            {diffCount > 0 ? (
              <DiffCount added={node.added} removed={node.removed} />
            ) : (
              <span className="font-mono">{node.views} views</span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
