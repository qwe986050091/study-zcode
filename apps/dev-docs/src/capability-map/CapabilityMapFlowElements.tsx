// INV-01 节点类型注册表的键必须与节点字面量完全一致：守住位置 capabilityMapNodeTypes；改错故障 画布遇到未知类型节点整块不渲染。
// INV-02 边类型注册表的键必须与连线字面量一致：守住位置 capabilityMapEdgeTypes；改错故障 所有连线退化成默认样式。
// INV-03 三个节点视图都必须 memo 包裹后再注册：守住位置 三个 memo 赋值；改错故障 每次筛选重建数组时全量重渲染。
// INV-04 dimmed 只改透明度，不卸载节点：守住位置 各视图类名拼接；改错故障 父子尺寸关系断裂，命中区域错位。
// INV-05 系统框与群框头部高度必须取自几何常量：守住位置 两个头部样式常量；改错故障 布局计算与实际渲染高度不一致，连线错位。
// INV-06 群复杂度缺失时抛错，不静默降级：守住位置 群复杂度查询调用；改错故障 徽标显示 0 掩盖数据不一致。
// INV-07 节点卡片尺寸由布局层决定，视图不再设置宽高：守住位置 h-full/w-full 类名；改错故障 与布局引擎结果打架。
// INV-08 每个能力节点必须有左侧入、右侧出两个锚点：守住位置 两个 Handle；改错故障 连线找不到锚点。
// INV-09 边框状态优先级 selected 高于 searchMatch 高于 hover：守住位置 类名三目链；改错故障 搜索结果被悬浮态遮掉。
// INV-10 连线优先用布局给出的正交路径，缺路由时回落贝塞尔：守住位置 path 三目；改错故障 布局未就绪时连线整段消失。
// INV-11 正交路径必须做圆角倒角，半径固定 10px：守住位置 roundedOrthogonalPath；改错故障 直角折线视觉生硬且与设计稿不符。
// INV-12 折线不足两点或出现空洞时返回退化路径而非非法坐标：守住位置 索引判空；改错故障 路径出现非数值导致整条边不渲染。
// INV-13 标签位置优先用布局给出的 labelPosition：守住位置 标签坐标三目；改错故障 标签漂移到线段中点。
// INV-14 标签必须显式声明层级：守住位置 标签层内 span 的 z-10；改错故障 标签被相邻节点盖住。
// INV-15 关系类型缺省为 state，仅在数据缺失时生效：守住位置 空值兜底；改错故障 异常数据渲染成无样式连线。
// INV-16 群内连线判定按两端节点的群标识相等：守住位置 intraGroup 计算；改错故障 群内短连线被当成跨群高亮。
// INV-17 连线箭头由画布注入，视图不得覆盖：守住位置 基础边组件传参；改错故障 箭头样式失效。
// INV-18 视图组件保持纯展示，不读写全局状态：守住位置 三个节点视图与连线视图；改错故障 筛选与渲染耦合，出现循环更新。
//
// 模块职责：把能力地图的节点与连线数据渲染成画布可用的视图组件与类型注册表。
// 状态所有权：选中、搜索、压暗状态都由上游数据传入，本模块只读。
// 阅读顺序：先看三个节点视图与注册表，再看折线几何辅助函数，最后看连线视图与标签。
import { memo, type CSSProperties } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import {
  formatCapabilityCodeEstimateCompact,
  formatCapabilityCodeEstimateFull,
  getCapabilityGroupComplexity,
  nodeById,
  type CapabilityFlowEdge,
  type CapabilityGroupFlowNode,
  type CapabilityItemFlowNode,
  type CapabilitySystemFlowNode,
} from "@/capability-map/capabilityMapTypes.js";
import {
  CAPABILITY_GROUP_HEADER_HEIGHT,
  CAPABILITY_SYSTEM_HEADER_HEIGHT,
} from "@/capability-map/capabilityMapGeometry.js";

// 头部高度直接取布局常量，保证画布坐标系与盒模型一致。
// 用 satisfies 而非断言：保留字面量类型推断，同时接受样式类型约束。
// 两个头部样式都是模块级常量，避免每次渲染新建对象导致 memo 失效。
// 样式对象只承载高度，其余视觉走类名，便于主题切换。
// [权衡] 不抽公共 hook：只有两个消费者，抽象成本高于收益。
const capabilitySystemHeaderStyle = {
  height: CAPABILITY_SYSTEM_HEADER_HEIGHT,
} satisfies CSSProperties;

const capabilityGroupHeaderStyle = {
  height: CAPABILITY_GROUP_HEADER_HEIGHT,
} satisfies CSSProperties;

// 系统区域框：虚线大框，头部显示区域名与描述；dimmed 时整框压暗但不卸载，
// 保证 React Flow 的父子尺寸关系与命中区域在筛选期间保持稳定。
// 系统框是最外层容器，尺寸完全由画布父节点决定。
// 虚线大框加半透明底表达「区域」，不是可点击的 div。
// 筛选压暗时降低不透明度但不卸载，保持子节点测量结果稳定。
// 头部展示系统名与描述，描述限宽避免长文本撑破框体。
function CapabilitySystemFlowNodeView({
  data,
}: NodeProps<CapabilitySystemFlowNode>) {
  return (
    <section
      className={`h-full w-full rounded-2xl border-2 border-dashed border-border bg-background-alt ${
        data.dimmed ? "opacity-20" : ""
      }`}
    >
      <div
        className="overflow-hidden border-b border-dashed border-border px-5 py-4"
        style={capabilitySystemHeaderStyle}
      >
        <h2 className="text-ui-lg font-medium text-foreground">
          {data.system.name}
        </h2>
        <p className="mt-1 max-w-3xl text-ui-sm text-foreground-subtle">
          {data.system.description}
        </p>
      </div>
    </section>
  );
}

// 能力群框：头部展示群名、owner 与"代码估算 + 跨群入/出度"徽标，selected 控制品牌色边框。
// 复杂度按 group.id 查全局快照，缺失时直接抛错（属数据不一致，不静默降级为 0）。
// 群框是系统框的子节点，选中时用品牌色边框强调当前群。
// 复杂度徽标同时给出主责代码估算与跨群入出度，三者拼在一行等宽文本。
// [失败路径] 复杂度查不到直接抛错：数据不一致必须暴露，不能渲染成 0。
// 徽标文本同时写进无障碍标签与悬浮提示，保证读屏与视觉一致。
// 悬浮只改边框与底色，不改变布局尺寸，避免画布抖动。
function CapabilityGroupFlowNodeView({
  data,
}: NodeProps<CapabilityGroupFlowNode>) {
  const complexity = getCapabilityGroupComplexity(data.group.id);
  const fullCodeEstimate = formatCapabilityCodeEstimateFull(
    data.group.codeEstimate.productionLines,
  );
  return (
    <section
      className={`h-full w-full rounded-xl border bg-surface ${
        data.selected
          ? "border-brand"
          : "border-card-border hover:border-border-hover"
      } ${data.dimmed ? "opacity-20" : ""}`}
    >
      <div
        className="overflow-hidden border-b border-border px-4 py-3"
        style={capabilityGroupHeaderStyle}
      >
        <h3 className="text-ui-base font-medium text-foreground">
          {data.group.name}
        </h3>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <p
            className="min-w-0 truncate text-ui-xs text-foreground-subtlest"
            title={data.group.owner}
          >
            {data.group.owner}
          </p>
          <span
            aria-label={`主责代码估算：${fullCodeEstimate}；跨群入度：${complexity.inDegree}；跨群出度：${complexity.outDegree}`}
            className="shrink-0 rounded-full bg-tag px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle"
            title={`主责代码估算：${fullCodeEstimate}；跨群入度：${complexity.inDegree}；跨群出度：${complexity.outDegree}`}
          >
            {formatCapabilityCodeEstimateCompact(
              data.group.codeEstimate.productionLines,
            )}{" "}
            · 入{complexity.inDegree} · 出{complexity.outDegree}
          </span>
        </div>
      </div>
    </section>
  );
}

// 能力节点卡片：固定 264×60 的叶节点，左右各一个 Handle 作为连线的 source/target 锚点。
// 边框状态优先级：selected > searchMatch > hover；dimmed 通过整体透明度表达，不改变可点击性。
// 叶子节点固定尺寸由布局层给出，这里只负责在框内排版两行文本。
// 锚点必须显式声明标识与方向，连线的两端引用与之对应。
// 边框状态按选中、搜索命中、悬浮顺序短路，越靠前优先级越高。
// dimmed 与 selected 可以叠加，opacity 不影响点击命中。
function CapabilityItemFlowNodeView({
  data,
}: NodeProps<CapabilityItemFlowNode>) {
  return (
    <article
      className={`flex h-full w-full items-center rounded-lg border bg-card px-3 ${
        data.selected
          ? "border-brand bg-card-selected"
          : data.searchMatch
            ? "border-brand"
            : "border-card-border hover:border-border-hover hover:bg-card-selected"
      } ${data.dimmed ? "opacity-20" : ""}`}
    >
      <Handle
        className="capability-map-handle"
        id="target"
        position={Position.Left}
        type="target"
      />
      <span className="line-clamp-2 text-ui-sm font-medium leading-4 text-foreground">
        {data.capability.label}
      </span>
      <Handle
        className="capability-map-handle"
        id="source"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

// 用 memo 包裹节点视图：画布每次筛选会重建 flowNodes 数组，但节点 data 未变时跳过重渲染。
const CapabilityGroupNode = memo(CapabilityGroupFlowNodeView);
const CapabilityItemNode = memo(CapabilityItemFlowNodeView);
const CapabilitySystemNode = memo(CapabilitySystemFlowNodeView);

// React Flow 节点类型注册表：键必须与 capabilityMapTypes 中的 Node 字面量完全一致。
export const capabilityMapNodeTypes = {
  "capability-system": CapabilitySystemNode,
  "capability-group": CapabilityGroupNode,
  "capability-item": CapabilityItemNode,
};

// 沿 from→to 方向前进指定距离，返回插值点；距离超过线段长度时直接返回 to，避免越过端点。
// 用于把折线的直角拐点切成"进入弧"和"离开弧"两小段，拐角处半径固定 10px。
// 以起点为原点按比例插值，比值由目标距离除以线段长度得到。
// 线段长度为 0 或短于目标距离时直接返回终点，避免除零与越界。
// 只用于倒角切点计算，不做取整，保持与原始坐标同精度。
// 返回新对象而不修改入参，保证调用方可安全复用折线点。
function moveToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
  distance: number,
) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0 || length <= distance) {
    return to;
  }
  const ratio = distance / length;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

// 把 ELK 输出的正交折线转成带圆角的 SVG path：每个中间点用二次贝塞尔倒角，
// 首尾点保持原始坐标。输入少于 2 个点或点为空时返回空串/退化路径，调用方需保证 points 非空。
// 首点先写 M 指令，再用二次贝塞尔倒角，最后补 L 收尾，生成 SVG path。
// 每个拐点向相邻两点各退回 10px，形成对称的圆角过渡。
// 越界点跳过而不是插值，保证退化输入也能产出合法路径。
function roundedOrthogonalPath(points: { x: number; y: number }[]) {
  const firstPoint = points[0];
  if (!firstPoint) {
    return "";
  }
  let path = `M ${firstPoint.x} ${firstPoint.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!previous || !current || !next) {
      // 索引越界只会发生在长度不足的折线；跳过该拐点而不是生成 NaN 坐标。
      continue;
    }
    const cornerStart = moveToward(current, previous, 10);
    const cornerEnd = moveToward(current, next, 10);
    path += ` L ${cornerStart.x} ${cornerStart.y}`;
    path += ` Q ${current.x} ${current.y} ${cornerEnd.x} ${cornerEnd.y}`;
  }
  const lastPoint = points.at(-1);
  return lastPoint ? `${path} L ${lastPoint.x} ${lastPoint.y}` : path;
}

// 关系连线渲染器：优先使用 ELK 给出的正交路径与标签位置，route 缺失时退回贝塞尔曲线，
// 保证布局未就绪或单条边无 section 时连线仍然可见而不断裂。
// 样式由 data 决定：relationType 决定颜色，highlighted/dimmed 叠加高亮与压暗，
// intraGroup 用于区分群内短连线；标签只在 showLabel 为真时渲染。
// 先算贝塞尔兜底，再在路由存在时改用正交路径与标签坐标。
// className 由 cn 按关系类型等四个维度拼接，全部可选。
// 标签只在开关为真时渲染，避免密集小图上文字互相遮挡。
function CapabilityMapEdge({
  data,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<CapabilityFlowEdge>) {
  const fallback = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const path = data?.route
    ? roundedOrthogonalPath(data.route.points)
    : fallback[0];
  const labelPosition = data?.route
    ? data.route.labelPosition
    : { x: fallback[1], y: fallback[2] };
  // 关系类型缺省为 "state"：仅在边数据缺失（异常渲染路径）时才走兜底，正常数据总是带 type。
  const relationType = data?.capability.type ?? "state";
  const intraGroup =
    data &&
    nodeById.get(data.capability.source)?.groupId ===
      nodeById.get(data.capability.target)?.groupId;

  return (
    <>
      <BaseEdge
        className={`capability-map-edge capability-map-edge--${relationType} ${
          data?.highlighted ? "is-highlighted" : ""
        } ${data?.dimmed ? "is-dimmed" : ""} ${intraGroup ? "is-intra-group" : ""}`}
        markerEnd={markerEnd}
        path={path}
      />
      {data?.showLabel ? (
        <EdgeLabelRenderer>
          {/* Bug 原因：节点自身使用 z-index，标签未声明层级时会被相邻节点盖住。 */}
          <span
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-1.5 py-0.5 text-ui-xs text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px,${labelPosition.y - 12}px)`,
            }}
          >
            {data.capability.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

// 边类型注册表：与 CapabilityFlowEdge 的 type 字面量绑定，memo 避免边数据未变时重复渲染。
export const capabilityMapEdgeTypes = {
  "capability-edge": memo(CapabilityMapEdge),
};
