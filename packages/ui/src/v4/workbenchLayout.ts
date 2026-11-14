// INV-01 纯计算：守住位置 全部导出函数；改错故障 布局阶段读取 DOM 尺寸或写 store。
// INV-02 叶子扁平化：守住位置 collectWorkbenchLayout 返回结构；改错故障 递归嵌套导致存活 pane 重挂。
// INV-03 占比只走 CSS 变量：守住位置 ratioVar 的 var() 写法；改错故障 拖拽时逐帧触发 React 渲染。
// INV-04 变量按节点命名：守住位置 SPLIT_VAR_PREFIX + node.id；改错故障 多个分割节点互相覆盖占比。
// INV-05 第二子树首尾相接：守住位置 left/boundary 复用；改错故障 分割线两侧出现缝隙或重叠。
// INV-06 row 与 column 轴向对称：守住位置 两条分支的宽高交换；改错故障 竖向分割按横向算。
// INV-07 表达式不带 calc：守住位置 RectExpr 只存裸表达式；改错故障 嵌套 calc 拼接出错。
// INV-08 calc 统一在样式层包：守住位置 rectStyle / dividerStyle；改错故障 表达式混入单位后失效。
// INV-09 祖先占比取数值：守住位置 regionFraction 传 store ratio；改错故障 拖拽像素换算比例失真。
// INV-10 分割条宽度常量：守住位置 9px；改错故障 命中区与视觉线错位。
// INV-11 分割条居中偏移：守住位置 translateX/Y(-50%)；改错故障 线偏到一侧。
// INV-12 交叉轴沿父矩形：守住位置 crossStart / crossLength；改错故障 分割线长度不随父区域收缩。
// INV-13 根矩形满幅：守住位置 FULL_WORKBENCH_RECT；改错故障 初始布局留白或溢出。
// INV-14 占比可缺省：守住位置 var() 第二参 node.ratio；改错故障 变量未写入时布局塌陷。
//
// 模块职责：把分屏树编译成叶子与分割条的绝对定位表达式。
// 阅读顺序：先看 collectNode 的轴向分支，再看扁平输出，最后看样式包装。
// 分屏布局计算（纯函数）：分割树 → 每个叶子/分隔条的绝对定位表达式。
// 叶子扁平渲染为容器直接子元素（key = paneId 稳定）——拆分/关闭只是换 rect，
// React 不重挂任何存活 pane（virtualizer 测高、滚动位置、composer 草稿全保留）；
// 若按树递归嵌套渲染，叶子被替换成分割容器时会整棵重挂。
// rect 表达式引用分割占比 CSS 变量：拖动中改一个变量，受影响的 pane/分隔条全部
// 由 CSS 重排，零 React 渲染（「容器 CSS 变量」方案按分割节点泛化）。
import type { CSSProperties } from "react";
import type { PaneLayoutNode, SplitDirection } from "@/v4/paneLayoutTree.js";

/** 分割占比 CSS 变量前缀（每个分割节点一个 `--v4-split-<nodeId>`）。 */
// CSS 变量前缀 --v4-split- 是拖拽零渲染的契约。
export const SPLIT_VAR_PREFIX = "--v4-split-";

/** 绝对定位表达式（不含 calc() 包裹；style 侧统一 `calc(${expr})`）。 */
// Rect 用 left/top/width/height 四个 CSS 表达式描述，不写像素。
export interface RectExpr {
  left: string;
  top: string;
  width: string;
  height: string;
}

// 叶子携带 paneId 与最终矩形。
export interface LeafLayout {
  paneId: string;
  rect: RectExpr;
}

// Splitter 同时记录 ratio 与 dragRect，拖动只改 ratio。
export interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /** store 当前占比（拖拽起点 + 容器 CSS 变量初值）。 */
  ratio: number;
  /** 该分割节点区域占容器主轴的数值比例（拖拽像素→占比换算；祖先占比取 store 数值）。 */
  regionFraction: number;
  /** 分割线（主轴位置）表达式。 */
  boundary: string;
  /** 交叉轴起点/长度表达式。 */
  crossStart: string;
  crossLength: string;
}

// 根节点铺满容器。
export const FULL_WORKBENCH_RECT: RectExpr = {
  left: "0%",
  top: "0%",
  width: "100%",
  height: "100%",
};

function collectNode(
  node: PaneLayoutNode,
  rect: RectExpr,
  widthFraction: number,
  heightFraction: number,
  leaves: LeafLayout[],
  dividers: DividerLayout[],
// 递归只写两个输出数组，无返回值。
): void {
  // leaf 节点直接产出 Rect 并终止递归。
  if (node.type === "leaf") {
    leaves.push({ paneId: node.paneId, rect });
    return;
  }
  // 占比优先读 CSS 变量，缺省回落 store。
  const ratioVar = `var(${SPLIT_VAR_PREFIX}${node.id}, ${node.ratio})`;
  // horizontal 分割切 width，vertical 切 height。
  if (node.direction === "row") {
    const boundary = `(${rect.left}) + (${rect.width}) * ${ratioVar}`;
    dividers.push({
      splitId: node.id,
      direction: "row",
      ratio: node.ratio,
      regionFraction: widthFraction,
      boundary,
      crossStart: rect.top,
      crossLength: rect.height,
    });
    collectNode(
      node.first,
      { ...rect, width: `(${rect.width}) * ${ratioVar}` },
      widthFraction * node.ratio,
      heightFraction,
      leaves,
      dividers,
    );
    collectNode(
      node.second,
      { ...rect, left: boundary, width: `(${rect.width}) * (1 - ${ratioVar})` },
      widthFraction * (1 - node.ratio),
      heightFraction,
      leaves,
      dividers,
    );
    return;
  }
  const boundary = `(${rect.top}) + (${rect.height}) * ${ratioVar}`;
  dividers.push({
    splitId: node.id,
    direction: "column",
    ratio: node.ratio,
    regionFraction: heightFraction,
    boundary,
    crossStart: rect.left,
    crossLength: rect.width,
  });
  collectNode(
    node.first,
    { ...rect, height: `(${rect.height}) * ${ratioVar}` },
    widthFraction,
    heightFraction * node.ratio,
    leaves,
    dividers,
  );
  collectNode(
    node.second,
    { ...rect, top: boundary, height: `(${rect.height}) * (1 - ${ratioVar})` },
    widthFraction,
    heightFraction * (1 - node.ratio),
    leaves,
    dividers,
  );
}

export interface WorkbenchLayout {
  leaves: LeafLayout[];
  dividers: DividerLayout[];
}

// 对外只暴露 flatten 后的 Rect 列表，不暴露树。
export function collectWorkbenchLayout(root: PaneLayoutNode): WorkbenchLayout {
  const leaves: LeafLayout[] = [];
  const dividers: DividerLayout[] = [];
  collectNode(root, FULL_WORKBENCH_RECT, 1, 1, leaves, dividers);
  return { leaves, dividers };
}

// 矩形表达式在此统一包 calc。
export function rectStyle(rect: RectExpr): CSSProperties {
  return {
    left: `calc(${rect.left})`,
    top: `calc(${rect.top})`,
    width: `calc(${rect.width})`,
    height: `calc(${rect.height})`,
  };
}

// splitterStyle 按 orientation 分支返回 cursor 与尺寸。
export function dividerStyle(divider: DividerLayout): CSSProperties {
  // 竖向线定 left，横向线定 top。
  if (divider.direction === "row") {
    return {
      left: `calc(${divider.boundary})`,
      top: `calc(${divider.crossStart})`,
      height: `calc(${divider.crossLength})`,
      width: "9px",
      transform: "translateX(-50%)",
    };
  }
  return {
    top: `calc(${divider.boundary})`,
    left: `calc(${divider.crossStart})`,
    width: `calc(${divider.crossLength})`,
    height: "9px",
    transform: "translateY(-50%)",
  };
}
