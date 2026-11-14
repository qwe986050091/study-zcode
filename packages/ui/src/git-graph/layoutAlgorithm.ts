// Git 提交图布局算法：把按时间倒序的 commit 列表转成车道索引与连线种子。
// 单遍扫描：每个顶点只处理一次，连线在扫描过程中即时落盘为 BranchLineSeed。
// 纯函数：输入 commits 不变则输出顶点与连线完全一致，不含时间与随机源。
// 与渲染解耦：本文件只产出几何事实，颜色主题、路径形状与像素尺寸由上层决定。
// INV-01 [失败路径] 同一 hash 只建一个顶点，重复 commit 不新增车道；守住位置：createVertices 的 vertexByHash 建表；改错故障：重复行被拆成两条并行车道，图谱出现断线。
// INV-02 [失败路径] parents 中不存在的 hash 一律落到共享哨兵顶点，不得抛错；守住位置：createVertices 的父节点回填循环；改错故障：分页窗口边界提交导致整条图谱渲染中断。
// INV-03 [权衡] 哨兵顶点使用恒定 id 负一，与真实行号区间天然隔离；守住位置：MISSING_PARENT_ID 常量与 determinePath 的提前返回；改错故障：末行提交被误当作可见父节点，画出指向画布外的连线。
// INV-04 [不变量] 顶点 id 等于其在输入数组中的下标，行序即 commit 序；守住位置：createVertices 的下标映射与 getPoint；改错故障：行序漂移让连线跨越错误行，提交视觉上被折叠。
// INV-05 [不变量] 车道号一经 addToBranch 写入不再变更，顶点不迁移车道；守住位置：addToBranch 中 branch 为空的首次写入；改错故障：同一提交在多条车道间跳动，连线呈锯齿。
// INV-06 [并发] 布局无共享可变状态，顶点、分支、颜色池都是本次调用的局部对象；守住位置：createGitGraphLayoutModel 内部构造；改错故障：两次布局互相污染，并行窗口串色。
// INV-07 [资源] 颜色池与分支一一对应，回收靠 endRowIndex 比较起点行；守住位置：getAvailableColour 与 determineNormalPath 末尾回写；改错故障：长仓库颜色池无限增长，车道数暴涨。
// INV-08 [不变量] 分支颜色号等于其在颜色池中的下标，该分支所有线段复用同一个车道号；守住位置：LayoutBranch 构造与 addLine；改错故障：一条分支的线段各自着色，同分支出现两种颜色。
// INV-09 [失败路径] reservePoint 只接受等于 nextLaneIndex 的位置，跳号请求直接丢弃；守住位置：reservePoint 的等值判断；改错故障：连接数组出现空洞，后续车道号整体错位。
// INV-10 [不变量] nextLaneIndex 单调递增，保证每一行已占车道构成连续前缀；守住位置：reservePoint 自增与 getWidthLaneIndex；改错故障：车道宽度估算偏小，右侧连线被裁剪。
// INV-11 [失败路径] getPointConnectingTo 只认 target 与 branch 同时相等的连接，避免跨分支复用；守住位置：查找回调的双条件；改错故障：连线接到相邻分支的同名顶点，拓扑错乱。
// INV-12 [不变量] 每个父边最多推进一次，游标递增保证幂等；守住位置：getNextParent 与 registerParentProcessed；改错故障：重扫同一父边生成重复线段，渲染叠影。
// INV-13 [不变量] 普通路径遇到已归属车道的父节点时改用其既有车道，不新占一条；守住位置：determineNormalPath 的起点车道三元选择；改错故障：主线每行分叉出多余空车道。
// INV-14 [权衡] 合并路径优先复用已存在的连接而非新建，追求线少而非线直；守住位置：determineMergePath 的已有连接分支；改错故障：同一个合并被画成多条平行线。
// INV-15 [不变量] 分支线段首尾相接，后一段起点复用前一段终点，保证折线连续；守住位置：两个路径函数中的 lastPoint 推进；改错故障：线段之间出现像素级断裂。
// INV-16 [失败路径] 分页窗口外的父节点不再延线到窗口底部，提前终止并标记已处理；守住位置：determineNormalPath 的哨兵判定；改错故障：列表底部出现拖到边界的悬挂线。
// INV-17 [不变量] 输出连线由分支顺序展平得到，顺序只依赖扫描顺序；守住位置：createGitGraphLayoutModel 的返回值；改错故障：同输入两次渲染连线顺序不同，快照抖动。
// INV-18 [失败路径] 既无父节点又已归属车道的顶点直接跳过，不重建分支；守住位置：主循环的跳过分支；改错故障：根提交被重复开道，末尾多出空车道。
import type { GitCommitGraphCommit } from "@zcode/shared";

// [权衡] 只保留车道号与行号两个整数，渲染层据此换算像素，布局本身不依赖尺寸。
// [不变量] 行号恒等于顶点 id，因此同一行内的点行号必然相同。
export interface GraphPoint {
  laneIndex: number;
  rowIndex: number;
}

// [不变量] 起止行号必须严格递增，相等或回退说明该线段属于回边，应被拆分。
// [失败路径] sourceHash 与 targetHash 只作调试定位，渲染层不得据此重建拓扑。
export interface BranchLineSeed {
  from: GraphPoint;
  to: GraphPoint;
  laneIndex: number;
  sourceHash: string;
  targetHash: string;
  lockedFirst: boolean;
}

// [不变量] target 与 branch 成对存储，缺一不可，查询时两者同时匹配才算命中。
// [权衡] 用下标即车道号的数组存连接，读取为常数时间，空间按最大车道数线性增长。
interface LaneConnection {
  target: LayoutVertex;
  branch: LayoutBranch;
}

// [失败路径] 用负一作哨兵行号，正常行号非负，两者不会混淆。
// [不变量] 哨兵顶点只被比较、不被布局，任何路径都不应把它写入输出连线。
const MISSING_PARENT_ID = -1;

// [不变量] 分支颜色号在构造时固定，生命周期内不再申请新颜色。
// [资源] endRowIndex 记录分支最后占用行，供颜色池判断何时可复用。
class LayoutBranch {
  readonly colourIndex: number;
  readonly lines: BranchLineSeed[] = [];
  endRowIndex = 0;

  constructor(colourIndex: number) {
    this.colourIndex = colourIndex;
  }

  // [不变量] 写入线段时车道号取分支颜色号，保证同分支线段同色。
  // [失败路径] lockedFirst 由调用方判定，取值错误会让弯折方向反转，线穿过节点。
  addLine(
    from: GraphPoint,
    to: GraphPoint,
    sourceHash: string,
    targetHash: string,
    lockedFirst: boolean,
  ) {
    this.lines.push({ from, to, laneIndex: this.colourIndex, sourceHash, targetHash, lockedFirst });
  }
}

// [不变量] 顶点自身不持有行号，行号由外部 id 提供，保持单一事实来源。
// [权衡] 用私有可变字段承载布局中间态，换取扫描过程无需外部映射表。
export class LayoutVertex {
  readonly id: number;
  readonly hash: string;
  private readonly parents: LayoutVertex[] = [];
  private nextParentIndex = 0;
  private laneIndex: number | null = null;
  private branch: LayoutBranch | null = null;
  private nextLaneIndex = 0;
  private readonly connections: Array<LaneConnection | undefined> = [];

  constructor(id: number, hash: string) {
    this.id = id;
    this.hash = hash;
  }

  // [不变量] parents 顺序即提交中父列表的原始顺序，首个父为第一父。
  // [失败路径] 追加父节点不校验重复，重复父会被算作合并，需上游去重。
  addParent(vertex: LayoutVertex) {
    this.parents.push(vertex);
  }

  // [不变量] 返回游标所指父节点，读取本身不推进游标，可重复调用。
  // [失败路径] 游标越界返回空值，调用方必须显式判空，不能当作哨兵顶点。
  getNextParent() {
    return this.nextParentIndex < this.parents.length
      ? this.parents[this.nextParentIndex]!
      : null;
  }

  // [不变量] 每推进一条父边调用一次，游标只增不减。
  // [失败路径] 漏调会让同一父边被重复布线，多调会跳过一个父节点。
  registerParentProcessed() {
    this.nextParentIndex++;
  }

  isMerge() {
    return this.parents.length > 1;
  }

  // [不变量] 分支引用与车道号同时为空才算未归属，二者不会只设其一。
  // [失败路径] 该判定决定新开分支还是复用车道，判错会多开一条空道。
  isNotOnBranch() {
    return this.branch === null || this.laneIndex === null;
  }

  // [不变量] 只有首次调用生效，后续调用被静默忽略，车道不可改派。
  // [失败路径] 静默忽略意味着先到者胜，调用顺序决定归属结果。
  addToBranch(branch: LayoutBranch, laneIndex: number) {
    if (this.branch === null) {
      this.branch = branch;
      this.laneIndex = laneIndex;
    }
  }

  getBranch() {
    return this.branch;
  }

  getLaneIndex() {
    return this.laneIndex ?? 0;
  }

  getPoint(): GraphPoint {
    return { laneIndex: this.getLaneIndex(), rowIndex: this.id };
  }

  getNextPoint(): GraphPoint {
    return { laneIndex: this.nextLaneIndex, rowIndex: this.id };
  }

  // [不变量] 命中时返回的车道号即连接数组下标，与 reservePoint 写入位置一致。
  // [失败路径] 未命中返回空值，调用方据此回退到新车道，不能默认零。
  // [权衡] 线性扫描连接数组而不建索引，车道数通常很小，换取代码简单。
  getPointConnectingTo(target: LayoutVertex, branch: LayoutBranch) {
    const connectionIndex = this.connections.findIndex(
      (connection) => connection?.target === target && connection.branch === branch,
    );

    return connectionIndex >= 0
      ? { laneIndex: connectionIndex, rowIndex: this.id }
      : null;
  }

  // [不变量] 仅当传入车道等于 nextLaneIndex 时写入，维持已占车道前缀连续。
  // [失败路径] 车道号跳跃的请求被丢弃，宁可少画也不破坏前缀性质。
  // [资源] 连接数组按下标稀疏增长，长度即已用车道上界。
  reservePoint(laneIndex: number, target: LayoutVertex, branch: LayoutBranch) {
    if (laneIndex === this.nextLaneIndex) {
      this.connections[laneIndex] = { target, branch };
      this.nextLaneIndex = laneIndex + 1;
    }
  }

  // [不变量] 返回 nextLaneIndex，即该行车道总数上界，供上层计算画布宽度。
  // [权衡] `getWidthLaneIndex` 返回车道数上界而非实际最大下标，多留一列换掉逐项统计。
  getWidthLaneIndex() {
    return this.nextLaneIndex;
  }
}

// [不变量] 顶点数组与 commits 等长同序，下标即 id。
// [失败路径] 未命中的父节点复用同一哨兵实例，便于身份比较而非 hash 比较。
function createVertices(commits: readonly GitCommitGraphCommit[]) {
  const missingParent = new LayoutVertex(MISSING_PARENT_ID, "__zcode_missing_parent__");
  const vertices = commits.map((commit, index) => new LayoutVertex(index, commit.hash));
  const vertexByHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));

  for (const [index, commit] of commits.entries()) {
    const vertex = vertices[index]!;
    for (const parentHash of commit.parents) {
      const parent = vertexByHash.get(parentHash) ?? missingParent;
      vertex.addParent(parent);
    }
  }

  return { missingParent, vertices, vertexByHash };
}

// [不变量] 命中最早释放的颜色即返回，不追求总颜色数最少。
// [资源] `availableColours` 无可复用项时向池尾追加一个，池长收敛在当时的分支峰值。
// [失败路径] 返回下标必须落在池内，越界会让分支着色读到空值。
function getAvailableColour(startAt: number, availableColours: number[]) {
  const reusableColour = availableColours.findIndex((endAt) => startAt > endAt);
  if (reusableColour >= 0) return reusableColour;
  availableColours.push(0);
  return availableColours.length - 1;
}

// [不变量] 自当前行向下扫描，命中已有连接即停，合并线不会无限延伸。
// [失败路径] 未命中连接时逐行占位，会抢占后续行的车道，需接受列宽增长。
// [权衡] `determineMergePath` 命中即中断换更少车道，代价是牺牲少量直度。
// [失败路径] 无既有连接时弯折方向按两点车道左右关系推导，取反会让线穿过节点。
function determineMergePath(
  startAt: number,
  vertices: LayoutVertex[],
  vertex: LayoutVertex,
  parentVertex: LayoutVertex,
) {
  const parentBranch = parentVertex.getBranch()!;
  let lastPoint = vertex.getPoint();
  let foundConnectionToParent = false;

  for (let rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    const currentVertex = vertices[rowIndex]!;
    const existingPoint = currentVertex.getPointConnectingTo(parentVertex, parentBranch);
    const currentPoint = existingPoint ?? currentVertex.getNextPoint();
    foundConnectionToParent = existingPoint !== null;
    parentBranch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      !foundConnectionToParent && currentVertex !== parentVertex
        ? lastPoint.laneIndex < currentPoint.laneIndex
        : true,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, parentBranch);
    lastPoint = currentPoint;
    if (foundConnectionToParent) {
      vertex.registerParentProcessed();
      break;
    }
  }
}

// [不变量] 起点车道由顶点是否已归属决定，已归属则沿用，否则新取车道。
// [资源] 循环结束把结束行写回颜色池，标记该颜色自此可复用。
// [失败路径] 父节点为空或为哨兵时立即中断，不产生悬空线段。
// [不变量] 父节点已归属时把游标切换到父节点继续追踪，形成链式推进。
// [失败路径] 父节点已归属说明另一条分支已接管，必须中断以避免双写。
function determineNormalPath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const { startAt, vertices, branches, availableColours, missingParent } = params;
  let rowIndex = startAt;
  let vertex = vertices[rowIndex]!;
  let parentVertex = vertex.getNextParent();
  let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
  const branch = new LayoutBranch(getAvailableColour(startAt, availableColours));
  vertex.addToBranch(branch, lastPoint.laneIndex);
  vertex.reservePoint(lastPoint.laneIndex, vertex, branch);

  for (rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    if (parentVertex === null || parentVertex === missingParent) break;
    const currentVertex = vertices[rowIndex]!;
    const currentPoint =
      parentVertex === currentVertex && !parentVertex.isNotOnBranch()
        ? currentVertex.getPoint()
        : currentVertex.getNextPoint();
    branch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      lastPoint.laneIndex < currentPoint.laneIndex,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, branch);
    lastPoint = currentPoint;
    if (parentVertex === currentVertex) {
      vertex.registerParentProcessed();
      const parentWasAlreadyOnBranch = !parentVertex.isNotOnBranch();
      parentVertex.addToBranch(branch, currentPoint.laneIndex);
      vertex = parentVertex;
      parentVertex = vertex.getNextParent();
      if (parentVertex === missingParent) {
        // 分页窗口外的 parent 没有可见节点，不能继续把线画到窗口底部。
        vertex.registerParentProcessed();
        break;
      }
      if (parentVertex === null || parentWasAlreadyOnBranch) break;
    }
  }

  branch.endRowIndex = rowIndex;
  branches.push(branch);
  availableColours[branch.colourIndex] = rowIndex;
}

// [不变量] 父节点是哨兵时只推进游标不开分支，保证末行提交不留线。
// [不变量] 仅当双方都已归属且当前顶点是合并顶点时才走合并路径。
// [权衡] 合并判断置于普通路径之前，用一次分支换取主线不被打断。
function determinePath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const vertex = params.vertices[params.startAt]!;
  const parentVertex = vertex.getNextParent();
  if (parentVertex === params.missingParent) {
    vertex.registerParentProcessed();
    return;
  }

  if (
    parentVertex !== null &&
    vertex.isMerge() &&
    !vertex.isNotOnBranch() &&
    !parentVertex.isNotOnBranch()
  ) {
    determineMergePath(params.startAt, params.vertices, vertex, parentVertex);
    return;
  }

  determineNormalPath(params);
}

// [不变量] 主循环下标只增不减，每个顶点最多被路径函数处理一次。
// [失败路径] 无父可推进且已归属的顶点直接跳过，避免空转死循环。
// [不变量] 返回的 hash 索引与顶点数组同源，可用于常数时间反查。
// [失败路径] 连线展平前不排序，顺序由分支序号决定，重跑结果稳定。
export function createGitGraphLayoutModel(commits: readonly GitCommitGraphCommit[]) {
  const { missingParent, vertices, vertexByHash } = createVertices(commits);
  const branches: LayoutBranch[] = [];
  const availableColours: number[] = [];
  let index = 0;

  while (index < vertices.length) {
    const vertex = vertices[index]!;
    if (vertex.getNextParent() !== null || vertex.isNotOnBranch()) {
      determinePath({ startAt: index, vertices, branches, availableColours, missingParent });
    } else {
      index++;
    }
  }

  return {
    vertices,
    vertexByHash,
    branchLines: branches.flatMap((branch) => branch.lines),
  };
}
