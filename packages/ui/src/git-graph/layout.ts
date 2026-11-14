// 提交图布局：把提交序列折叠为行、车道、边与路径，纯函数且不依赖 React。
// 输入顺序即语义：commits 顺序决定 rowIndex，布局不重排、不排序、不丢项。
// 职责切分：车道算法来自 layoutAlgorithm，本文件只做坐标换算与 SVG 路径拼装。
// 覆盖范围：分行算法、车道分配与回收、合并边、确定性顺序、边界提交。
// INV-01 行序与输入序一一对应，rows[i] 的 commit 恒为 commits[i]；守住位置：layoutGitGraph 的 rows 映射；改错故障：提交行错位，用户点到 A 却打开 B 的详情。
// INV-02 rowIndex 单调递增使 y 随行下移；守住位置：pointToPixels 与 rows 构造的 topPadding + rowIndex * rowHeight；改错故障：相邻提交重叠或反向，图与提交列表对不齐。
// INV-03 每个提交只有一个 laneIndex 且非负；守住位置：rows 构造里对 getLaneIndex 的单次取值；改错故障：同一提交画出两条并行线，用户误以为存在重复提交。
// INV-04 车道可被后续提交复用，laneIndex 不随行数单调增长；守住位置：createGitGraphLayoutModel 的分配与回收；改错故障：长历史无限加宽，横向滚动吃掉提交信息。
// INV-05 laneCount 恒大于等于 1，空提交列表也保留一列；守住位置：laneCount 的 Math.max 下限；改错故障：空仓库时宽度为负或 NaN，容器塌陷出白屏。
// INV-06 laneCount 同时覆盖行车道、宽车道与分支线车道；守住位置：laneCount 的三个候选上界；改错故障：最右侧车道被裁切，分叉线在视口外消失。
// INV-07 每个 parentHash 生成一条边，跨行合并边不省略；守住位置：createEdges 对 commit.parents 的映射；改错故障：合并提交只显示主干，用户看不出分支已并入。
// INV-08 父提交不在当前切片时 toRow 缺失且边标记 truncated；守住位置：createEdges 的 !toRow 判定；改错故障：分页边界被画成实线折返，用户误读为父提交在同一屏。
// INV-09 边终点 y 取父提交行，缺失时退化为当前行 y；守住位置：createEdges 的 toRow?.y ?? fromRow.y；改错故障：合并曲线悬空或穿过无关行，视觉指向错误提交。
// INV-10 车道不同时曲线纵向偏移不小于 14 像素；守住位置：buildEdgePath 的 curveOffset 下限；改错故障：相邻行短距离跨道被画成直线，分支与主线混淆。
// INV-11 lockedFirst 决定三次贝塞尔控制点贴在起点还是终点；守住位置：buildEdgePath 的 lockedFirst 分支；改错故障：曲线向外鼓包并穿过其他车道，造成错误连接暗示。
// INV-12 起止 x 相同时不生成曲线而输出直线；守住位置：buildEdgePath 的 fromX === toX 早返回；改错故障：主干被画成波浪线，密集历史出现抖动噪声。
// INV-13 边 id 由提交 hash 与 parentIndex 拼成，同一输入恒得同一 id；守住位置：createEdges 的 id 模板字符串；改错故障：React 复用错误 key，动画在提交间串位。
// INV-14 分支线 id 追加 lineIndex 以区分同 hash 同行的重复线；守住位置：createGraphPath 与 createLaneSegment 的 id 模板；改错故障：同源多线互相覆盖，渲染丢失一条分支。
// INV-15 布局输出只依赖入参与常量，不含时间戳、随机源与全局状态；守住位置：整文件无副作用调用；改错故障：同一历史每次渲染车道漂移，画面逐帧跳动。
// INV-16 坐标只由 lanePadding、laneGap、topPadding、rowHeight 决定；守住位置：pointToPixels；改错故障：缩放或换主题后行高与线宽脱节，点击命中区偏移。
// INV-17 laneSegments 只收首尾车道相等的线；守住位置：layoutGitGraph 对 verticalLines 的过滤；改错故障：斜线被重复绘制成竖线，分支处出现多余色块。
// INV-18 高度按行数减一计末行留白，宽度按车道数展开；守住位置：layoutGitGraph 的 height 与 width 计算；改错故障：底部被裁或右侧留白过大，滚动条抖动。
// INV-19 像素默认值只在常量处定义，调用方可逐项覆盖；守住位置：DEFAULT_* 常量与 options 解构；改错故障：部分选项失效，密度切换后行高与车道间距不匹配。
import type {
  GitCommitGraphCommit,
  GitCommitGraphRef,
  GitCommitGraphRefKind,
} from "@zcode/shared";
import {
  createGitGraphLayoutModel,
  type BranchLineSeed,
  type GraphPoint,
} from "@/git-graph/layoutAlgorithm.js";

// 【不变量】三个别名只做重导出，不新增结构，保证 UI 与 shared 类型同源。
// 【失败路径】在此加宽字段会让 UI 编译通过而协议校验拒绝，问题延后到运行期。
export type GitGraphRefKind = GitCommitGraphRefKind;
export type GitGraphRef = GitCommitGraphRef;
export type GitGraphCommit = GitCommitGraphCommit;

// 【权衡】`GitGraphLayoutOptions` 的五个像素项全部可选，缺省回落到 `DEFAULT_ROW_HEIGHT` 等常量。
// 【失败路径】把缺省项当作必填会让 undefined 参与乘法，坐标变 NaN 而非报错。
export interface GitGraphLayoutOptions {
  rowHeight?: number;
  laneGap?: number;
  lanePadding?: number;
  topPadding?: number;
  bottomPadding?: number;
}

// 【不变量】行同时携带 rowIndex 与 laneIndex，是像素坐标的唯一来源。
// 【失败路径】调用方自行按下标推坐标会与 rowHeight 覆盖值不一致，命中区错位。
export interface GitGraphLayoutRow {
  commit: GitGraphCommit;
  rowIndex: number;
  laneIndex: number;
  x: number;
  y: number;
}

// 【不变量】边保留 fromHash 与 toHash，上层可按提交反查连接关系。
// 【失败路径】只存像素端点会让缩放后无法重新求解边，必须整图重算。
// 【权衡】truncated 显式标记而不省略边，避免上层把缺失当成无父提交。
export interface GitGraphLayoutEdge {
  id: string;
  fromHash: string;
  toHash: string;
  fromLaneIndex: number;
  toLaneIndex: number;
  path: string;
  truncated: boolean;
}

export interface GitGraphLayoutLaneSegment {
  id: string;
  hash: string;
  laneIndex: number;
  path: string;
}

export interface GitGraphLayoutPath {
  id: string;
  laneIndex: number;
  path: string;
  relatedHashes: string[];
}

// 【不变量】rows 与 edges 同批产出，行序与边端点共享同一套坐标。
// 【失败路径】分批计算会让边引用旧行高，出现半像素错位与错位高亮。
// 【权衡】laneCount 与 width 一并返回，渲染层不再重复推导车道数。
export interface GitGraphLayout {
  rows: GitGraphLayoutRow[];
  edges: GitGraphLayoutEdge[];
  laneSegments: GitGraphLayoutLaneSegment[];
  paths: GitGraphLayoutPath[];
  laneCount: number;
  width: number;
  height: number;
  rowHeight: number;
  laneGap: number;
}

// 【不变量】内部像素上下文只含四项已解析数值，不携带可选字段。
// 【失败路径】把外层 options 直接下传会让 undefined 混入乘法，产出 NaN 路径。
interface PixelOptions {
  lanePadding: number;
  laneGap: number;
  topPadding: number;
  rowHeight: number;
}

// 【不变量】默认行高 42 与设计规范的提交行一致，是命中区基准。
// 【权衡】车道间距 18 小于行高，为分叉曲线留出横向余量。
// 【失败路径】行高调小而间距不改，分支线会挤进提交文本区域。
const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_LANE_GAP = 18;
const DEFAULT_LANE_PADDING = 16;
const DEFAULT_TOP_PADDING = 20;
const DEFAULT_BOTTOM_PADDING = 18;

// 【不变量】边与分支路径共用同一曲线生成器，形状规则只有一份。
// 【失败路径】绕过它手写 path 会与 lockedFirst 语义脱节，交叉处方向相反。
// 【确定性】同一端点组合恒得同一字符串，便于快照比对与 diff 阅读。
// 【权衡】`buildEdgePath` 用三次贝塞尔换平滑曲线，代价是放弃严格正交走线。
function buildEdgePath({
  fromX,
  fromY,
  toX,
  toY,
  lockedFirst,
}: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  lockedFirst?: boolean;
}): string {
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }

  // 【不变量】偏移随纵向距离缩放并夹在 14 以上，短距离不会退化成直线。
  // 【失败路径】去掉下限会让相邻行跨道看起来像斜直线，分支归属难辨。
  // 【确定性】0.38 为固定比例，同一间距下曲线形状逐帧稳定。
  const curveOffset = Math.max(14, Math.abs(toY - fromY) * 0.38);
  if (lockedFirst === false) {
    return [
      `M ${fromX} ${fromY}`,
      `C ${fromX} ${toY - curveOffset}, ${toX} ${toY - curveOffset}, ${toX} ${toY}`,
    ].join(" ");
  }

  return [
    `M ${fromX} ${fromY}`,
    `C ${fromX} ${fromY + curveOffset}, ${toX} ${fromY + curveOffset}, ${toX} ${toY}`,
  ].join(" ");
}

// 【不变量】唯一坐标换算入口，行与车道到像素只在此发生。
// 【确定性】纯算术、无缓存无状态，重复调用结果完全一致。
// 【失败路径】此处漏加边距会让首列贴边，圆点被容器裁掉一半。
function pointToPixels(point: GraphPoint, options: PixelOptions) {
  return {
    x: options.lanePadding + point.laneIndex * options.laneGap,
    y: options.topPadding + point.rowIndex * options.rowHeight,
  };
}

// 【不变量】relatedHashes 在源与目标相同时去重为单项。
// 【失败路径】不去重会让高亮按 hash 计数翻倍，选中一条线却亮两条。
// 【权衡】id 内嵌行列号与序号，牺牲长度换取跨渲染的引用稳定。
function createGraphPath(
  line: BranchLineSeed,
  lineIndex: number,
  pixelOptions: PixelOptions,
): GitGraphLayoutPath {
  const from = pointToPixels(line.from, pixelOptions);
  const to = pointToPixels(line.to, pixelOptions);

  return {
    id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${lineIndex}:path`,
    laneIndex: line.laneIndex,
    path: buildEdgePath({
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      lockedFirst: line.lockedFirst,
    }),
    relatedHashes:
      line.sourceHash === line.targetHash
        ? [line.sourceHash]
        : [line.sourceHash, line.targetHash],
  };
}

// 【不变量】线段取目标车道与目标 hash，落在分支归属的一侧。
// 【失败路径】取源车道会让线段与路径分属两列，同一条线视觉断开。
function createLaneSegment(
  line: BranchLineSeed,
  lineIndex: number,
  pixelOptions: PixelOptions,
): GitGraphLayoutLaneSegment {
  const from = pointToPixels(line.from, pixelOptions);
  const to = pointToPixels(line.to, pixelOptions);

  return {
    id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${lineIndex}:segment`,
    hash: line.targetHash,
    laneIndex: line.to.laneIndex,
    path: buildEdgePath({
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      lockedFirst: line.lockedFirst,
    }),
  };
}

// 【不变量】边按 commits 顺序与 parents 顺序产出，顺序稳定可预期。
// 【确定性】flatMap 保证父边紧邻其子提交，不引入额外排序步骤。
// 【失败路径】改用对象聚合会丢失父子相邻性，绘制层级变得随机。
function createEdges(params: {
  commits: readonly GitGraphCommit[];
  rows: GitGraphLayoutRow[];
  vertexByHash: ReturnType<typeof createGitGraphLayoutModel>["vertexByHash"];
  rowByHash: Map<string, GitGraphLayoutRow>;
  pixelOptions: PixelOptions;
}): GitGraphLayoutEdge[] {
  const { commits, rows, vertexByHash, rowByHash, pixelOptions } = params;

  return commits.flatMap((commit, rowIndex): GitGraphLayoutEdge[] => {
    // 【不变量】子提交顶点必然存在，因模型与 commits 同源生成。
    // 【失败路径】改用可选链会把模型不一致静默成缺边，真实错位被掩盖。
    const fromVertex = vertexByHash.get(commit.hash)!;
    return commit.parents.map((parentHash, parentIndex): GitGraphLayoutEdge => {
      const parentVertex = vertexByHash.get(parentHash) ?? null;
      const fromLaneIndex = fromVertex.getLaneIndex();
      // 【不变量】父提交在切片内时取真实车道，否则按父序号顺延占位。
      // 【失败路径】缺失父时一律用源车道会让多条外向边叠在同一列。
      // 【权衡】顺延占位而非丢弃边，保证跨页连接仍有可见方向。
      const toLaneIndex = parentVertex
        ? parentVertex.getLaneIndex()
        : fromLaneIndex + parentIndex;
      const fromRow = rows[rowIndex]!;
      const toRow = rowByHash.get(parentHash);
      const fromX = pixelOptions.lanePadding + fromLaneIndex * pixelOptions.laneGap;
      const toX = pixelOptions.lanePadding + toLaneIndex * pixelOptions.laneGap;

      return {
        id: `${commit.hash}:${parentHash}:${parentIndex}`,
        fromHash: commit.hash,
        toHash: parentHash,
        fromLaneIndex,
        toLaneIndex,
        path: buildEdgePath({
          fromX,
          fromY: fromRow.y,
          toX,
          toY: toRow?.y ?? fromRow.y,
          // 【不变量】向右跨道时锁起点，使曲线先水平离开始发车道。
          // 【失败路径】方向取反会让曲线先侵入目标车道，交叉点视觉粘连。
          lockedFirst: fromLaneIndex < toLaneIndex,
        }),
        // 【不变量】截断标记严格等价于父提交不在当前行集合。
        // 【失败路径】按 hash 是否存在来判断会误标，因为顶点可能来自完整模型。
        truncated: !toRow,
      };
    });
  });
}

// 【不变量】唯一对外入口，纯函数，同输入得到逐字段相同的输出。
// 【失败路径】在此读写 store 或 ref 会让布局随渲染次数漂移。
// 【权衡】`layoutGitGraph` 一次算完全部结果，换来调用简单但放弃增量布局。
export function layoutGitGraph(
  commits: readonly GitGraphCommit[],
  options: GitGraphLayoutOptions = {},
): GitGraphLayout {
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const laneGap = options.laneGap ?? DEFAULT_LANE_GAP;
  const lanePadding = options.lanePadding ?? DEFAULT_LANE_PADDING;
  const topPadding = options.topPadding ?? DEFAULT_TOP_PADDING;
  const bottomPadding = options.bottomPadding ?? DEFAULT_BOTTOM_PADDING;
  // 【不变量】行、边、分支路径共用同一次模型计算结果。
  // 【失败路径】二次调用模型会得到不同车道分配，行与线整体错位。
  const { vertices, vertexByHash, branchLines } = createGitGraphLayoutModel(commits);

  // 【不变量】顶点顺序即提交顺序，映射下标直接充当 rowIndex。
  // 【失败路径】按 hash 排序会打乱时间线，早提交出现在下方。
  const rows = vertices.map((vertex, rowIndex): GitGraphLayoutRow => {
    const laneIndex = vertex.getLaneIndex();

    return {
      commit: commits[rowIndex]!,
      rowIndex,
      laneIndex,
      x: lanePadding + laneIndex * laneGap,
      y: topPadding + rowIndex * rowHeight,
    };
  });
  const rowByHash = new Map(rows.map((row) => [row.commit.hash, row]));
  const maxRowLaneIndex = rows.reduce((max, row) => Math.max(max, row.laneIndex), 0);
  const maxWidthLaneIndex = vertices.reduce(
    (max, vertex) => Math.max(max, vertex.getWidthLaneIndex() - 1),
    0,
  );
  const maxLineLaneIndex = branchLines.reduce(
    (max, line) => Math.max(max, line.from.laneIndex, line.to.laneIndex),
    0,
  );
  // 【不变量】三处车道上界取最大值再加一，覆盖全部绘制元素。
  // 【失败路径】只取行车道会让纯分支线越界，最右侧线被宽度裁掉。
  const laneCount = Math.max(
    1,
    maxRowLaneIndex + 1,
    maxWidthLaneIndex + 1,
    maxLineLaneIndex + 1,
  );
  const height = topPadding + Math.max(0, commits.length - 1) * rowHeight + bottomPadding;
  const width = lanePadding * 2 + (laneCount - 1) * laneGap;
  const pixelOptions = { lanePadding, laneGap, topPadding, rowHeight };
  const verticalLines = branchLines.filter(
    (line) => line.from.laneIndex === line.to.laneIndex,
  );

  return {
    rows,
    edges: createEdges({ commits, rows, vertexByHash, rowByHash, pixelOptions }),
    laneSegments: verticalLines.map((line, index) =>
      createLaneSegment(line, index, pixelOptions),
    ),
    paths: branchLines.map((line, index) => createGraphPath(line, index, pixelOptions)),
    laneCount,
    width,
    height,
    rowHeight,
    laneGap,
  };
}
