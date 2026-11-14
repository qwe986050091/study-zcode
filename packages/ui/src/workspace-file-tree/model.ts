/* eslint-disable max-lines -- 文件树模型集中维护路径、排序、图片和媒体预览 source 构造。 */
// 工作区文件树的数据模型层：路径归一、Git 状态归并、行合成、搜索过滤、空目录链压平，
// 以及「文件路径 → 查看器 source」的映射。全部是纯函数或纯数据构造，不发起任何 IO。
// 不负责：目录读取与 readdir 顺序、展开与选中的交互状态机、React 渲染及缓存生命周期。
//
// INV-01 断言：路径比较与查找前必须先归一为无尾斜杠的正斜杠形式 —— 守住它的位置：normalizeForRelativePath 及其全部调用点 —— 改错故障：Windows 路径比较失败，选中高亮与 Git 标记整体失效
// INV-02 断言：Git 状态表的写入键与查询键共用同一归一函数 —— 守住它的位置：normalizeForGitStatusPath —— 改错故障：状态写入成功但查询恒为 null，树里的 M/D 字母静默消失
// INV-03 断言：同一路径多条记录按优先级取数值最大者 —— 守住它的位置：buildWorkspaceFileGitStatusByPath 的比较分支 —— 改错故障：后写覆盖前写，已删除或新增被压成修改
// INV-04 断言：目录聚合使用独立的装饰优先级，不复用文件合并优先级 —— 守住它的位置：WORKSPACE_FILE_GIT_DIRECTORY_STATUS_PRIORITY —— 改错故障：目录圆点被未跟踪状态染色，与编辑器其它位置不一致
// INV-05 断言：Git 变更过滤仅在可执行且工作区确属仓库时启用 —— 守住它的位置：isWorkspaceFileTreeGitStatusAvailable —— 改错故障：非仓库工作区把整棵树过滤成空白
// INV-06 断言：软链接目录永不参与空目录链压缩 —— 守住它的位置：isWorkspaceFileTreeAutoFlattenableDirectory —— 改错故障：自引用软链接无限拼接路径并反复触发加载
// INV-07 断言：包含判定是「相等或前缀后紧跟斜杠」 —— 守住它的位置：isWorkspaceFilePathInside —— 改错故障：同名前缀的兄弟目录被算进子树，搜索与展开多带一层
// INV-08 断言：父目录与深度按归一后的相对段数计算，输出沿用入参的分隔符风格 —— 守住它的位置：getWorkspaceFileParentDirectory 与 getWorkspaceFileDirectoryChildDepth —— 改错故障：Windows 下父目录键不匹配，根层节点挂不上
// INV-09 断言：补 deleted 行采用写时复制，未发生变化时返回入参本身 —— 守住它的位置：addDeletedGitStatusRowsToWorkspaceFileTree —— 改错故障：原地改写调用方 Map，出现幽灵行或无变化时整片重绘
// INV-10 断言：补进来的 deleted 行必须与同层既有顺序一致 —— 守住它的位置：addDeletedGitStatusRowsToWorkspaceFileTree 内的排序 —— 改错故障：同一目录出现两种顺序，滚动位置与展开项跳动
// INV-11 断言：搜索只匹配节点 name，命中后保留祖先目录与命中目录的后代 —— 守住它的位置：filterWorkspaceFileTreeRows —— 改错故障：深层文件搜不到，或命中的目录把整棵子树吞进结果
// INV-12 断言：空查询原样返回，无命中返回空数组 —— 守住它的位置：filterWorkspaceFileTreeRows 的两个早返回 —— 改错故障：空查询被当成匹配全部，树意外清空
// INV-13 断言：压缩行的 depth 以当前递归层的偏移为基准回填 —— 守住它的位置：flattenWorkspaceFileTreeRows 的 depth 与 depthOffset —— 改错故障：缩进逐层累积，深层节点被推出可视区
// INV-14 断言：压缩节点的展开态取整条链任意路径命中 —— 守住它的位置：representedPaths 的 some 分支 —— 改错故障：点击链尾目录时整条链无法收起
// INV-15 断言：压缩遇到未加载、加载中或带错误的目录立即停止 —— 守住它的位置：compactDirectoryNode 的循环条件 —— 改错故障：尚未读出的目录被伪装成空目录并吞掉加载态
// INV-16 断言：行序只由 childrenByDirectory 的数组顺序决定，压平不做二次排序 —— 守住它的位置：flattenWorkspaceFileTreeRows —— 改错故障：展开或折叠后同层顺序发生变化
// INV-17 断言：SVG 走 file 分支而不是 image 分支 —— 守住它的位置：createCodeViewerSourceForWorkspaceFile 的类型判断 —— 改错故障：SVG 变成只读预览，失去源码查看与编辑
// INV-18 断言：行对象每次重建，调用方只能按 path 比对，不能依赖对象身份 —— 守住它的位置：flattenWorkspaceFileTreeRows 的行构造 —— 改错故障：memo 失效导致全量重渲染或该更新的行不更新
//
// 阅读顺序：路径归一 → Git 状态表 → 行合成与过滤 → 压平 → 查看器 source 构造。
// 命名约定：入参的 Map/Set 一律按只读使用，写时复制只出现在补 deleted 行的函数里。
import type { FileEntry, GitFileChange, GitRepositorySummary } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { inferImageMediaType, inferMediaPreview, type CodeViewerSource } from "@/lib/codeViewer.js";

export interface WorkspaceFileTreeNode {
  path: string;
  name: string;
  type: FileEntry["type"];
  depth: number;
  isSymbolicLink?: boolean;
}

export interface WorkspaceFileTreeRow extends WorkspaceFileTreeNode {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  compactedPaths?: string[];
}

export type WorkspaceFileGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored";

// 文件级合并优先级：同一路径存在多条 Git 记录时数值大者胜出，数值本身不参与展示
// 未跟踪排在最高，因为从未跟踪变成已暂存后语义完全不同，保留 U 更接近用户预期
// 重排这里的数值等于改变树里显示的字母，测试与圆点样式都依赖当前顺序
const WORKSPACE_FILE_GIT_STATUS_PRIORITY: Record<WorkspaceFileGitStatus, number> = {
  ignored: 0,
  modified: 1,
  renamed: 2,
  deleted: 3,
  added: 4,
  untracked: 5,
};

// 目录聚合是另一套口径：只决定文件夹圆点的颜色，不与上面的文件合并优先级互通
// 数值越大排序越靠前，数组首项即调用方采用的装饰状态，ignored 取最大值以便纯忽略目录稳定显示为灰
// 两套优先级合并过一次就会让未跟踪盖过已修改，这正是历史修复点，不要为「统一」再合回去
const WORKSPACE_FILE_GIT_DIRECTORY_STATUS_PRIORITY: Record<WorkspaceFileGitStatus, number> = {
  added: 1,
  deleted: 1,
  renamed: 1,
  untracked: 1,
  modified: 2,
  ignored: 3,
};

// 只做两件事：反斜杠转正斜杠、去掉尾部斜杠；不折叠大小写、不补盘符、不解析上级引用
// 这是全文件唯一的路径归一口径，父目录键、前缀比较、Git 状态表键都建立在它的输出上
// 若在这里加大小写折叠，大小写敏感的真实路径会被误判为同一个，删除行与选中态互相串台
function normalizeForRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

// Git 侧保留独立包装，便于将来只给状态表加大小写或盘符策略，不影响普通路径比较
// 任何绕过它直接拿变更记录里的原始路径当键的写法，都会造成写入与查询不对称
// 两者当前输出完全一致，改动其中一个必须同步另一个，否则查表静默返回 null
function normalizeForGitStatusPath(path: string): string {
  return normalizeForRelativePath(path);
}

// 未跟踪判定优先于 kind：上游可能同时给出未跟踪与新增两条信息，语义上应展示为未跟踪
// 分组为 untracked 是兜底，只带分组不带布尔标记时仍能归到未跟踪
// 调换顺序后新文件在用户处理前就会显示成已暂存新增，容易被误认为已经入库
function resolveWorkspaceFileGitStatus(
  change: Pick<GitFileChange, "isUntracked" | "kind" | "section">,
): WorkspaceFileGitStatus {
  if (change.isUntracked || change.section === "untracked") {
    return "untracked";
  }

  return change.kind;
}

export function buildWorkspaceFileGitStatusByPath(
  changes: readonly Pick<GitFileChange, "path" | "isUntracked" | "kind" | "section">[],
): Map<string, WorkspaceFileGitStatus> {
  const statusByPath = new Map<string, WorkspaceFileGitStatus>();

  // 逐条写入并按优先级比较，所以结果与遍历顺序无关（同优先级时先到者胜出，属实现细节）
  // 同一文件的已暂存与未暂存记录常常同时存在，这里必须合并成一个状态而不是让后写覆盖
  // 提前 continue 的写法保证幂等：同一份变更列表重复构建得到同一张表
  for (const change of changes) {
    const pathKey = normalizeForGitStatusPath(change.path);
    const nextStatus = resolveWorkspaceFileGitStatus(change);
    const existingStatus = statusByPath.get(pathKey);
    // 修复：文件树之前把 Git 改动统一压成 M/U，导致 staged added/deleted/renamed
    // 在树里丢失真实状态。这里保留优先级更高的状态，兼容同一文件同时存在 staged/unstaged 记录。
    if (
      existingStatus &&
      WORKSPACE_FILE_GIT_STATUS_PRIORITY[existingStatus] >=
        WORKSPACE_FILE_GIT_STATUS_PRIORITY[nextStatus]
    ) {
      continue;
    }

    statusByPath.set(pathKey, nextStatus);
  }

  return statusByPath;
}

// 读取成功不等于可用：非仓库工作区里取变更也会返回空数组，而不是抛错
// 只有 Git 可执行且当前工作区确属仓库时才允许启用变更过滤与状态圆点
// 放宽这里会让「没有变更」与「无法获取」混为一谈，过滤后整棵树为空且没有任何提示
export function isWorkspaceFileTreeGitStatusAvailable(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  // 修复：`getChanges()` 在非 Git workspace 里也会返回空数组，不能把“读取成功”
  // 当成 Git 状态可用。文件树只在 Git 可执行且当前 workspace 属于仓库时展示变更过滤。
  return summary.isGitAvailable && summary.isRepository;
}

export function getWorkspaceFileGitStatus(
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>,
  filePath: string,
): WorkspaceFileGitStatus | null {
  return statusByPath.get(normalizeForGitStatusPath(filePath)) ?? null;
}

// 忽略集合与状态表共用同一归一函数，保证写入键与 has 查询键严格一致
// 调用方应在忽略规则整体变化时重建整表，而不是增量删键
// 增量维护容易残留旧键，表现为文件已不再被忽略，树里却仍显示为灰色
export function buildWorkspaceFileIgnoredPathSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map((path) => normalizeForGitStatusPath(path)));
}

export function isWorkspaceFileGitIgnored(
  ignoredPathSet: ReadonlySet<string>,
  filePath: string,
): boolean {
  return ignoredPathSet.has(normalizeForGitStatusPath(filePath));
}

export function isWorkspaceFileTreeDeletedFile(
  row: Pick<WorkspaceFileTreeRow, "type">,
  gitStatus: WorkspaceFileGitStatus | null | undefined,
): boolean {
  return row.type !== "directory" && gitStatus === "deleted";
}

// 仅「类型为目录且非软链接」可参与空目录链压缩，软链接目录允许展示与手动进入
// 自引用或指回父级的软链接会让路径字符串去重失效，压缩链无限变长并反复触发加载
// 写成类型守卫供压缩侧直接收窄，新增节点类型时默认应保持不可压缩
export function isWorkspaceFileTreeAutoFlattenableDirectory(
  node: Pick<WorkspaceFileTreeNode, "type" | "isSymbolicLink"> | undefined,
): node is WorkspaceFileTreeNode {
  // 软链接目录可以展示并手动进入，但不能参与空目录链自动展开；
  // self/parent symlink 会让路径字符串去重失效，持续加载 linked-dir/linked-dir/...。
  return node?.type === "directory" && node.isSymbolicLink !== true;
}

// 目录前缀必须带结尾斜杠，否则 /src 会命中 /src2 这类同名前缀目录
// 扫描的是已有状态表而非文件系统，成本与改动总数成正比，不要放进逐行渲染循环里反复调用
// 去重后按装饰优先级降序，调用方取首项当圆点状态，空数组表示该目录子树没有变更
export function getWorkspaceDirectoryGitStatuses(
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>,
  directoryPath: string,
): WorkspaceFileGitStatus[] {
  const normalizedDirectoryPath = normalizeForGitStatusPath(directoryPath);
  const directoryPrefix = `${normalizedDirectoryPath}/`;
  const statuses = new Set<WorkspaceFileGitStatus>();

  for (const [path, status] of statusByPath) {
    if (!normalizeForGitStatusPath(path).startsWith(directoryPrefix)) {
      continue;
    }

    statuses.add(status);
  }

  return [...statuses].sort(
    (left, right) =>
      // 修复：目录 descendant 之前沿用了文件状态合并优先级，导致 U/A/D 会盖过 M。
      // VS Code 的 Git resource priority 是 modified 高于新增/删除/重命名/未跟踪，
      // 目录聚合只决定文件夹圆点样式，因此单独使用这套 decoration 优先级。
      WORKSPACE_FILE_GIT_DIRECTORY_STATUS_PRIORITY[right] -
      WORKSPACE_FILE_GIT_DIRECTORY_STATUS_PRIORITY[left],
  );
}

export function addDeletedGitStatusRowsToWorkspaceFileTree(params: {
  rootPath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>;
}): Map<string, WorkspaceFileTreeNode[]> {
  // 写时复制：只有确实需要补 deleted 行时才克隆 Map，否则原样返回入参
  // 没有变更时返回同一引用，React 侧可以按引用相等直接跳过重渲染
  // 改成无条件克隆会让每次刷新都产生新引用，无变化时也整片重绘并丢失滚动锚点
  let nextChildrenByDirectory: Map<string, WorkspaceFileTreeNode[]> | null = null;

  for (const [path, status] of params.statusByPath) {
    if (status !== "deleted") {
      continue;
    }

    const parentDirectory = getWorkspaceFileParentDirectory(params.rootPath, path);
    if (!parentDirectory) {
      continue;
    }

    // 父目录不在 childrenByDirectory 里说明它尚未加载或不在展开链上，直接跳过即可
    // 不要为它创建空数组，否则压平阶段会把未加载目录当成「已加载且为空」
    // 这里只读不写，克隆决策统一留到循环末尾，避免中途产生半成品 Map
    const currentChildren =
      (nextChildrenByDirectory ?? params.childrenByDirectory).get(parentDirectory) ?? null;
    if (!currentChildren) {
      continue;
    }

    if (currentChildren.some((child) => areWorkspaceFilePathsEqual(child.path, path))) {
      continue;
    }

    // 新数组按目录优先、名称比较重排，与 readdir 侧保持同一种排序口径
    // deleted 只是补充行，不能因为追加就落到末尾，否则同一目录出现两种顺序
    // 排序用 name 而不是全路径，跨平台分隔符差异不会影响同层顺序
    const nextChildren = [
      ...currentChildren,
      {
        path,
        name: getPathLeaf(path),
        type: "file" as const,
        depth: getWorkspaceFileDirectoryChildDepth(params.rootPath, parentDirectory),
      },
    ].sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

    // 修复：deleted 文件已不在文件系统里，单靠 readdir 无法生成行，
    // 导致文件树只能在目录上显示聚合点，看不到具体文件的 D 状态。
    // 首次真正插入时才整体克隆，后续复用同一份副本，循环内不再重复克隆
    // 克隆放在所有校验通过之后，被跳过的记录不会产生多余引用
    // 顺序不能前移：提前克隆会让无效记录也产生新引用，引用相等优化失效
    nextChildrenByDirectory ??= new Map(params.childrenByDirectory);
    nextChildrenByDirectory.set(parentDirectory, nextChildren);
  }

  return nextChildrenByDirectory ?? params.childrenByDirectory;
}

// 工作区根自身返回点号，调用方据此识别根行，而不是靠路径字符串特判
// 前缀匹配在归一之后进行，Windows 反斜杠路径也能正确截出相对部分
// 不在工作区内时退化为叶子名，宁可显示重名也不返回空标签
export function getWorkspaceFileRelativePath(workspacePath: string, filePath: string): string {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);

  if (normalizedWorkspacePath === normalizedFilePath) {
    return ".";
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(workspacePrefix)) {
    return normalizedFilePath.slice(workspacePrefix.length);
  }

  return getPathLeaf(filePath);
}

// 只归一再比较字符串，不做大小写折叠，与路径归一函数保持同一口径
// 它是删除行去重与选中态匹配的共同入口，改这里会同时影响两处行为
// 不要改成按 locale 比较等于零的写法，语言相关的等价判断会把不同路径判成相等
export function areWorkspaceFilePathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizeForRelativePath(leftPath) === normalizeForRelativePath(rightPath);
}

// 判定是「相等或以工作区路径加斜杠开头」，专门排除同名前缀目录被当作子项
// 前缀必须带斜杠，直接用普通前缀判断会让同名前缀的兄弟目录被算进子树
// 搜索保留祖先、父目录与深度计算都复用它，放宽一格整棵树的层级就会错位
export function isWorkspaceFilePathInside(workspacePath: string, filePath: string): boolean {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

// 返回从工作区根往下的逐级绝对目录，供调用方一次性把展开态补齐
// 结果只含中间目录，不含文件自身，也不含工作区根
// 分隔符按入参风格推导：全是反斜杠时才用反斜杠，混用时统一用正斜杠
export function getWorkspaceFileAncestorDirectories(
  workspacePath: string,
  filePath: string,
): string[] {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;

  if (
    !isWorkspaceFilePathInside(workspacePath, filePath) ||
    normalizedFilePath === normalizedWorkspacePath
  ) {
    return [];
  }

  const relativePath = normalizedFilePath.slice(workspacePrefix.length);
  const relativeSegments = relativePath.split("/").filter(Boolean);
  if (relativeSegments.length <= 1) {
    return [];
  }

  const separator = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  const basePath = workspacePath.replace(/[\\/]+$/, "");
  const ancestorSegments = relativeSegments.slice(0, -1);
  const ancestors: string[] = [];
  let currentPath = basePath;

  for (const segment of ancestorSegments) {
    currentPath = `${currentPath}${separator}${segment}`;
    ancestors.push(currentPath);
  }

  return ancestors;
}

// 深度等于归一后相对路径的段数：工作区根为 0，其直接子项为 1
// 不要用绝对路径段数或字符串长度推算，盘符与盘根会让结果整体偏大
// 工作区外路径返回 0，调用方据此按根层处理而不是算出负数缩进
export function getWorkspaceFileDirectoryChildDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedDirectoryPath = normalizeForRelativePath(directoryPath);

  if (
    normalizedDirectoryPath === normalizedWorkspacePath ||
    !isWorkspaceFilePathInside(workspacePath, directoryPath)
  ) {
    return 0;
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  return normalizedDirectoryPath.slice(workspacePrefix.length).split("/").filter(Boolean).length;
}

// 只取一级父目录，与返回整条祖先链的函数分工明确，调用方按需选择
// 工作区根的直接子项，父级是工作区根自身（去掉尾斜杠），而不是空值
// 根路径与工作区外路径返回空值，调用方据此停止向上回溯
export function getWorkspaceFileParentDirectory(
  workspacePath: string,
  directoryPath: string,
): string | null {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedDirectoryPath = normalizeForRelativePath(directoryPath);

  if (
    normalizedDirectoryPath === normalizedWorkspacePath ||
    !isWorkspaceFilePathInside(workspacePath, directoryPath)
  ) {
    return null;
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  const relativeSegments = normalizedDirectoryPath
    .slice(workspacePrefix.length)
    .split("/")
    .filter(Boolean);
  const parentSegments = relativeSegments.slice(0, -1);
  if (parentSegments.length === 0) {
    return workspacePath.replace(/[\\/]+$/, "");
  }

  const separator = directoryPath.includes("\\") && !directoryPath.includes("/") ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${parentSegments.join(separator)}`;
}

// 用语言环境相关的小写化做大小写折叠，结果随运行时语言环境变化，这是展示层取舍
// 首尾空白被裁掉，纯空格查询等价于没有查询，会走快速路径
// 匹配对象是节点 name，若改成匹配完整路径，同名前缀目录的判断会变得不可控
function normalizeWorkspaceFileTreeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

// 文件只要存在非忽略状态就算变更，忽略项不计入，避免噪声污染过滤结果
// 目录没有直接状态，靠扫描子树聚合结果的数量判定，与圆点显示保持同一口径
// 聚合为空才算未变更，因此只含被忽略文件的目录不会出现在变更过滤里
function isWorkspaceFileTreeRowChanged(
  row: WorkspaceFileTreeRow,
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>,
): boolean {
  const gitStatus = getWorkspaceFileGitStatus(statusByPath, row.path);
  if (gitStatus && gitStatus !== "ignored") {
    return true;
  }

  return (
    row.type === "directory" && getWorkspaceDirectoryGitStatuses(statusByPath, row.path).length > 0
  );
}

// 先做变更过滤再做搜索，顺序不可交换：祖先保留只能在已过滤的集合内进行
// 返回原数组的子集并保持原有顺序，不重排、不去重、不重建行对象
// 空查询走快速路径，可能直接返回入参数组，调用方不能靠引用相等判断结果是否变化
export function filterWorkspaceFileTreeRows(params: {
  rows: WorkspaceFileTreeRow[];
  searchQuery: string;
  changedOnly: boolean;
  statusByPath: ReadonlyMap<string, WorkspaceFileGitStatus>;
}): WorkspaceFileTreeRow[] {
  const changedFilteredRows = params.changedOnly
    ? params.rows.filter((row) => isWorkspaceFileTreeRowChanged(row, params.statusByPath))
    : params.rows;
  const normalizedSearchQuery = normalizeWorkspaceFileTreeSearchQuery(params.searchQuery);

  if (!normalizedSearchQuery) {
    return changedFilteredRows;
  }

  const matchedRows = changedFilteredRows.filter((row) =>
    row.name.toLocaleLowerCase().includes(normalizedSearchQuery),
  );
  if (matchedRows.length === 0) {
    return [];
  }

  const matchedPathSet = new Set(matchedRows.map((row) => row.path));
  // 命中目录的后代全部保留，用户搜目录名时本就期望直接看到里面的内容
  // 命中文件只保留祖先目录，兄弟节点不进入结果，避免结果集无限膨胀
  // 两条规则在下面的单次过滤中叠加，不产生第二轮遍历，返回顺序因此保持稳定
  const matchedDirectoryPaths = matchedRows
    .filter((row) => row.type === "directory")
    .map((row) => row.path);

  return changedFilteredRows.filter((row) => {
    if (matchedPathSet.has(row.path)) {
      return true;
    }

    if (
      row.type === "directory" &&
      matchedRows.some((matchedRow) => isWorkspaceFilePathInside(row.path, matchedRow.path))
    ) {
      return true;
    }

    return matchedDirectoryPaths.some((directoryPath) =>
      isWorkspaceFilePathInside(directoryPath, row.path),
    );
  });
}

// 纯函数：只读入参与各状态集合，输出行数组，不写回任何外部状态
// 行序完全由各目录的子项数组顺序决定，这里不做任何二次排序
// 未加载的目录不产生子行，展开但尚未加载时只显示目录行本身
export function flattenWorkspaceFileTreeRows(params: {
  rootPath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  expandedPaths: Set<string>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  errorByDirectory: Map<string, Error>;
  flattenEmptyDirectories?: boolean;
}): WorkspaceFileTreeRow[] {
  const rows: WorkspaceFileTreeRow[] = [];

  // 压缩只沿「唯一子目录」链向下，遇到多个子项或非目录立即停止
  // 压缩后 name 用斜杠拼接展示，path 取链尾节点，保证行标识稳定可寻址
  // compactedPaths 记录整条链，展开态与选中态按集合匹配，不依赖拼接出来的名字
  function compactDirectoryNode(node: WorkspaceFileTreeNode): {
    node: WorkspaceFileTreeNode;
    compactedPaths?: string[];
    childDepthOffset: number;
  } {
    if (!params.flattenEmptyDirectories || !isWorkspaceFileTreeAutoFlattenableDirectory(node)) {
      return { node, childDepthOffset: 0 };
    }

    const compactedNodes = [node];
    let currentNode = node;

    // 未加载、加载中、带错误的目录一律不压缩，三者都意味着子项不可信
    // 只有恰好一个子项且子项本身可压缩时才继续，空数组会立刻跳出循环
    // 终止依赖路径层级变化，软链接已在前面被排除，否则可能出现无限纵深
    while (
      params.loadedDirectoryPaths.has(currentNode.path) &&
      !params.loadingDirectoryPaths.has(currentNode.path) &&
      !params.errorByDirectory.has(currentNode.path)
    ) {
      const children = params.childrenByDirectory.get(currentNode.path) ?? [];
      if (children.length !== 1 || !isWorkspaceFileTreeAutoFlattenableDirectory(children[0])) {
        break;
      }

      currentNode = children[0];
      compactedNodes.push(currentNode);
    }

    // 没有可压缩项时原样返回，保持「无变化」语义，调用方无需额外判断
    // 压缩后 depth 回填起始节点深度，行首缩进不会因合并而跳变
    // 链尾节点才是可点击对象：展开的是最内层目录，而不是拼接展示的链首
    if (compactedNodes.length === 1) {
      return { node, childDepthOffset: 0 };
    }

    return {
      node: {
        ...currentNode,
        depth: node.depth,
        name: compactedNodes.map((compactedNode) => compactedNode.name).join("/"),
      },
      compactedPaths: compactedNodes.map((compactedNode) => compactedNode.path),
      childDepthOffset: currentNode.depth - node.depth,
    };
  }

  // depthOffset 表示当前递归层已经吃掉的层数，用来把子项缩进拉回真实层级
  // 每下降一层叠加压缩产生的额外偏移，压缩吃掉的深度在下一层被抵消
  // 只对目录且已展开的行递归，文件永不下降；同一目录重复出现会产生重复行
  function visit(directoryPath: string, depthOffset = 0) {
    const children = params.childrenByDirectory.get(directoryPath) ?? [];
    for (const child of children) {
      const compacted = compactDirectoryNode({
        ...child,
        depth: child.depth - depthOffset,
      });
      const representedPaths = compacted.compactedPaths ?? [compacted.node.path];
      const expanded = representedPaths.some((path) => params.expandedPaths.has(path));
      rows.push({
        ...compacted.node,
        expanded,
        loaded: params.loadedDirectoryPaths.has(compacted.node.path),
        loading: params.loadingDirectoryPaths.has(compacted.node.path),
        error: params.errorByDirectory.get(compacted.node.path) ?? null,
        ...(compacted.compactedPaths ? { compactedPaths: compacted.compactedPaths } : {}),
      });

      if (compacted.node.type === "directory" && expanded) {
        visit(compacted.node.path, depthOffset + compacted.childDepthOffset);
      }
    }
  }

  visit(params.rootPath);
  return rows;
}

// SVG 被刻意排除在图片分支之外：它既是图片也是可编辑文本，应按文件打开
// 其余图片走图片分支，音视频走媒体分支，剩下的统一按文件处理，分支顺序不可交换
// title 取叶子名用于标签展示，path 保留完整路径用于打开，二者不可互相替代
export function createCodeViewerSourceForWorkspaceFile(path: string): CodeViewerSource {
  const title = getPathLeaf(path);
  const mediaType = inferImageMediaType(path);
  if (mediaType && mediaType !== "image/svg+xml") {
    return {
      type: "image",
      title,
      path,
      mediaType,
    };
  }

  const mediaPreview = inferMediaPreview(path);
  if (mediaPreview) {
    return {
      type: "media",
      title,
      path,
      ...mediaPreview,
    };
  }

  return {
    type: "file",
    title,
    path,
  };
}
