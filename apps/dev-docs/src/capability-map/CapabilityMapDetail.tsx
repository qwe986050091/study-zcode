// INV-01 守住位置：本组件是详情面板的纯展示层，选择态由父级唯一持有；改错故障：若在此新增选择态，画布高亮与面板内容会分叉，出现两个真相源。
// INV-02 守住位置：filteredEdges 在分支之前基于 enabledRelations 与 edgeScope 一次性算出，群与节点两条分支共用同一份；改错故障：两处各自过滤会产生口径漂移，同一关系在画布可见而详情列表缺失。
// INV-03 守住位置：关系过滤先判关系类型再判跨群，两者是逻辑与；改错故障：改成逻辑或会让被取消勾选的关系重新出现，或在仅跨群口径下混入同群边。
// INV-04 守住位置：edgeScope 为 all 时直接放行，否则要求 source 与 target 的所属 groupId 不同；改错故障：比较节点 id 而非 groupId 会把同群内部边误判为跨群边。
// INV-05 守住位置：selection 为假值时走无选择分支，只渲染图例与操作提示；改错故障：在该分支提前读取 selection.kind 会抛空引用，面板整块白屏。
// INV-06 守住位置：图例遍历 relationTypes 常量而不是当前边集合，保证未出现的关系类型也有配色说明；改错故障：从数据反推图例会随数据漂移，新增类型时图例静默缺失。
// INV-07 守住位置：群分支必须先用 groupById 取群并处理缺失；改错故障：跳过存在性判断直接读 group.id 会在数据热更新后崩溃。
// INV-08 守住位置：群成员由 capabilityNodes 按 groupId 过滤得到，保持数据源顺序而非额外排序；改错故障：引入排序会让同一群在画布与详情里的成员次序不同，用户难以对齐。
// INV-09 守住位置：跨群入度与出度统一走 getCapabilityGroupComplexity，不在面板内重算；改错故障：面板内自行统计会与画布权重口径不一致，度量数字互相矛盾。
// INV-10 守住位置：节点分支先取 node 再取 group 再取 system，任一层缺失都以可选链降级；改错故障：假设 group 必然存在会在孤儿节点上抛错。
// INV-11 守住位置：一阶关系同时匹配 source 与 target，双向都算；改错故障：只匹配出边会漏掉入边，用户看到的关系数少于画布。
// INV-12 守住位置：对端节点缺失时该行渲染 null 而不是占位按钮；改错故障：渲染空链接会让点击跳到 undefined，选择态被写成非法 id。
// INV-13 守住位置：方向前缀由 edge.source 是否等于当前节点决定，出边用 →、入边用 ←；改错故障：前缀与真实方向相反会误导依赖阅读。
// INV-14 守住位置：跳转一律通过 onSelectGroup 与 onSelectNode 回调上抛，本组件不直接改动路由或选择态；改错故障：内部直接写选择态会绕过父级联动，画布不跟随。
// INV-15 守住位置：找不到群或节点时返回 null 表示面板收起，不回退到默认图例态；改错故障：回退会让用户以为选择已被清除，实际选择仍指向失效 id。
// INV-16 守住位置：DetailFact 的 value 约定为已格式化字符串，格式化在调用方完成；改错故障：在 Fact 内再格式化会重复处理，数字与置信度文案出现两套规则。
// INV-17 守住位置：DetailShell 只负责 sticky 外壳与标题结构，不感知选择态；改错故障：把分支判断下沉到外壳会让三个调用点行为不再一致。
// INV-18 守住位置：DetailButton 固定 type 为 button 且 relationType 可缺省；改错故障：省略 type 会在表单上下文触发提交，缺省色点会渲染出错误的关系配色。
//
// 模块职责：把 CapabilitySelection 映射为右侧只读详情，包含无选择图例、能力群详情与能力节点详情三种形态。
// 状态所有权：选择态与过滤条件由父级持有，本文件只派生 filteredEdges、connections 等渲染期中间量。
// 阅读顺序：先看 CapabilityMapDetail 的两个早返回分支，再看 DetailShell、DetailFact、DetailButton 三个纯展示子组件。
import type { ReactNode } from "react";
import { Focus, Network } from "lucide-react";
import {
  capabilityEdges,
  capabilityNodes,
  capabilityRelationNames,
  type CapabilityRelationType,
} from "@/data/productCapabilityMap.js";
import {
  capabilityCodeEstimateConfidenceNames,
  formatCapabilityCodeEstimateFull,
  getCapabilityGroupComplexity,
  groupById,
  nodeById,
  relationTypes,
  systemById,
  type CapabilitySelection,
  type EdgeScope,
} from "@/capability-map/capabilityMapTypes.js";

// 右侧详情面板：根据选择态展示不同内容——未选中时展示图例与操作提示，选中群展示群信息与成员，
// 选中节点展示节点信息与一阶关系（关系列表复用与画布一致的 enabledRelations/edgeScope 过滤口径）。
// 入参 selection 与状态无关，仅作只读判断；所有跳转通过 onSelectGroup/onSelectNode 回调，本组件不改选择态。
// 找不到对应 group/node 时返回 null（数据已被删除的容错），不抛出。
// 入参契约：edgeScope 与 enabledRelations 决定关系可见性，selection 只读，两个 onSelect 回调是唯一出口。
// 本组件不引入任何状态或副作用，渲染结果完全由这四个输入决定，便于父级做受控切换。
// selection 的三种形态对应三个渲染分支，新增形态必须同步补分支，否则会落到节点分支并读到未定义字段。
// 回调参数只传 id 而非整对象，父级可据此做幂等比较；改成传对象会让引用变化触发多余重渲染。
// 类型来自 capabilityMapTypes，字段口径与本文件一致；改类型前先确认画布侧是同源消费方。
export function CapabilityMapDetail({
  edgeScope,
  enabledRelations,
  onSelectGroup,
  onSelectNode,
  selection,
}: {
  edgeScope: EdgeScope;
  enabledRelations: Set<CapabilityRelationType>;
  onSelectGroup: (groupId: string) => void;
  onSelectNode: (nodeId: string) => void;
  selection: CapabilitySelection;
}) {
  // 先按关系类型过滤，再按跨群口径过滤，顺序不可交换：类型过滤是廉价的集合判断，跨群判断需要两次 map 查询。
  // enabledRelations 为空集时结果必然为空，详情里的关系计数随之归零，这是正确行为而不是需要兜底的异常。
  // 此处每次渲染都会重算，属于当前规模可接受的开销；若改为缓存，必须把 enabledRelations 的变更纳入依赖。
  // 过滤结果在无选择分支里也被计算但未被使用，属已知浪费；提前到分支之后会破坏群与节点共用同一份的口径。
  // 该变量只描述全图可见边，不要让它承载选择相关逻辑，选择过滤由 connections 单独完成。
  const filteredEdges = capabilityEdges.filter((edge) => {
    if (!enabledRelations.has(edge.type)) {
      return false;
    }
    return (
      edgeScope === "all" ||
      nodeById.get(edge.source)?.groupId !== nodeById.get(edge.target)?.groupId
    );
  });

  // 早返回：无选择时只渲染图例，不渲染任何详情字段，避免面板出现空标题与空计数。
  // 图例用 relationTypes 的顺序保证配色说明稳定，颜色类名由 capability-map-edge-- 前缀加类型名提供，与画布共用同一套样式。
  // 外壳沿用 self-start 与 xl:sticky，xl:top-20 与顶部栏高度对齐；调整顶部栏高度时必须同步这个偏移。
  // 本分支不提供重置按钮，重置由画布空白点击负责，面板只做提示，避免出现两条清空路径。
  if (!selection) {
    // 无选择时保留图例说明；这里不主动清空画布视口，用户仍可平移查看全图。
    return (
      <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
        <div className="flex items-center gap-2 text-brand">
          <Network className="size-4" />
          <span className="text-ui-sm font-medium">能力地图</span>
        </div>
        <h2 className="mt-2 text-ui-lg font-medium">选择一个群或节点</h2>
        <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          地图按 Renderer、Host、ZCode CLI
          三层运行时和底部工程基础设施组织。选择后保留当前视角并突出一阶关系，点击空白区域可重置。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {relationTypes.map((type) => (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-ui-sm text-foreground-subtle"
              key={type}
            >
              <i
                aria-hidden="true"
                className={`capability-relation-swatch capability-map-edge--${type}`}
              />
              {capabilityRelationNames[type]}
            </span>
          ))}
        </div>
      </aside>
    );
  }

  if (selection.kind === "group") {
    const group = groupById.get(selection.id);
    // 群 id 可能来自旧链接或热更新前的数据，取不到时静默返回 null，由父级决定是否清理 selection。
    // 这里不回退成无选择图例，否则用户会误判为点击未生效，而实际上选择仍指向已失效的 id。
    // group 存在才继续读取 systemId 与成员，后续字段访问依赖这一判断，删掉它会让可选链失去意义。
    // 不要把清理 selection 的副作用写进渲染函数，渲染期写状态会触发父级重渲染循环。
    if (!group) {
      // 选择指向已不存在的群（数据热更新或旧链接）：静默收起面板，不回退到默认态。
      return null;
    }
    // 成员列表直接复用全局节点数组的顺序，不做二次排序，保证同一群在画布与详情里的次序一致。
    // 复杂度由 getCapabilityGroupComplexity 统一计算，面板只展示入度与出度，不重复统计边。
    // 成员点击走 onSelectNode，不在此处展开节点详情，避免面板嵌套出第二层选择态。
    const nodes = capabilityNodes.filter((node) => node.groupId === group.id);
    const system = systemById.get(group.systemId);
    const complexity = getCapabilityGroupComplexity(group.id);
    return (
      <DetailShell
        description={group.description}
        kicker="能力群"
        title={group.name}
      >
        <DetailFact label="顶层区域" value={system?.name ?? "未分配"} />
        <DetailFact label="建议主要 owner" value={group.owner} />
        <DetailFact
          label="主责代码估算（Estimated Owned LOC）"
          value={formatCapabilityCodeEstimateFull(
            group.codeEstimate.productionLines,
          )}
        />
        <DetailFact
          label="估算置信度（Confidence）"
          value={
            capabilityCodeEstimateConfidenceNames[group.codeEstimate.confidence]
          }
        />
        <DetailFact label="能力节点" value={`${nodes.length} 个`} />
        <DetailFact
          label="跨群入度（Cross-group In-degree）"
          value={`${complexity.inDegree} 条`}
        />
        <DetailFact
          label="跨群出度（Cross-group Out-degree）"
          value={`${complexity.outDegree} 条`}
        />
        <div className="mt-4 grid gap-1.5">
          {nodes.map((node) => (
            <DetailButton
              key={node.id}
              label={node.label}
              metadata={node.authority}
              onClick={() => onSelectNode(node.id)}
            />
          ))}
        </div>
      </DetailShell>
    );
  }

  const node = nodeById.get(selection.id);
  // 节点缺失时返回 null，且必须早于读取 node.groupId，否则会访问 undefined 的属性。
  // group 与 system 都允许缺失：节点存在但所属群被删时，标题里的群名与 owner 降级为未分配。
  // 降级用可选链加空值合并完成，不伪造默认群对象，否则会把脏数据洗成看似合法的详情。
  // 该分支与群分支的缺失语义一致，都是收起面板而不是报错，保证数据热更新时页面不崩。
  if (!node) {
    // 节点被移除时同样返回 null，避免访问 undefined 的 groupId。
    return null;
  }
  const group = groupById.get(node.groupId);
  const system = group ? systemById.get(group.systemId) : undefined;
  // 一阶关系按与画布相同的规则过滤：只保留勾选的关系类型，且"仅跨群"时排除同群边。
  // 一阶关系取 source 或 target 命中当前节点，双向都算，因此同一对节点的两条反向边会各占一行。
  // 复用 filteredEdges 保证关系类型与跨群口径和画布完全一致，不在此处另写过滤条件。
  // 结果顺序继承 capabilityEdges 的声明顺序，不排序，便于与画布边渲染顺序对照排查。
  // 计数直接取 connections 的长度，与下方列表同源，避免标题数字与列表条数对不上。
  // 若后续引入自环边，当前条件仍只产生一行，方向前缀会判为出边，需要在数据层先明确语义。
  const connections = filteredEdges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  );
  return (
    <DetailShell
      description={node.scope}
      kicker={
        <button
          className="inline-flex items-center gap-1 text-brand hover:underline"
          onClick={() => onSelectGroup(node.groupId)}
          type="button"
        >
          <Focus className="size-3.5" />
          {group?.name}
        </button>
      }
      title={node.label}
    >
      <DetailFact label="顶层区域" value={system?.name ?? "未分配"} />
      <DetailFact label="建议主要 owner" value={group?.owner ?? "未分配"} />
      <DetailFact label="权威状态 / 提交落点" value={node.authority} />
      <DetailFact label="一阶关系" value={`${connections.length} 条`} />
      <div className="mt-4 grid gap-1.5">
        {connections.map((edge) => {
          const outbound = edge.source === node.id;
          const otherNode = nodeById.get(outbound ? edge.target : edge.source);
          if (!otherNode) {
            // 对端节点缺失（脏数据）时跳过该行，保证列表里不出现可点击的空链接。
            return null;
          }
          return (
            <DetailButton
              key={edge.id}
              label={`${outbound ? "→" : "←"} ${otherNode.label}`}
              metadata={`${capabilityRelationNames[edge.type]} · ${edge.label}`}
              onClick={() => onSelectNode(otherNode.id)}
              relationType={edge.type}
            />
          );
        })}
      </div>
    </DetailShell>
  );
}

// 详情面板的统一外壳：sticky 侧栏 + 标题/描述/内容槽，仅负责布局，不判断选择态。
// kicker 可为普通文本或可点击按钮（节点详情里用于跳回所属群）。
// 外壳只负责 sticky 布局与标题、描述、内容槽三段结构，不感知选择态，三个调用点共用同一套间距。
// kicker 声明为 ReactNode，因此既能放纯文本也能放可点击按钮；收窄成 string 会破坏节点详情里跳回群的能力。
// description 与 title 由调用方保证非空，外壳不做空值兜底，缺内容时应在数据层修复。
function DetailShell({
  children,
  description,
  kicker,
  title,
}: {
  children: ReactNode;
  description: string;
  kicker: ReactNode;
  title: string;
}) {
  return (
    <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
      <div className="text-ui-sm font-medium text-brand">{kicker}</div>
      <h2 className="mt-2 text-ui-lg font-medium text-foreground">{title}</h2>
      <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
        {description}
      </p>
      <div className="mt-4 grid gap-3">{children}</div>
    </aside>
  );
}

// 详情中的单条事实行（标签 + 值），值一律为已格式化好的字符串，不做空值兜底。
// value 约定为已格式化字符串，数字、百分比与文案格式化全部在调用方完成，此组件只负责排版。
// 不做空值兜底是刻意选择：缺失值应在数据层暴露，静默显示占位符会掩盖数据缺口。
// 上边框与内边距构成事实行之间的分隔，改动间距需同步群详情与节点详情两处的视觉预期。
function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-ui-sm text-foreground-subtlest">{label}</p>
      <p className="mt-1 text-ui-base text-foreground">{value}</p>
    </div>
  );
}

// 可点击的详情条目：用于能力群成员 / 一阶关系跳转；relationType 缺省时显示中性灰点。
// 显式声明 type 为 button，避免在表单上下文中被当作提交按钮触发意外提交。
// relationType 缺省表示中性条目，色点退回 foreground-subtlest，用于群成员这类无关系语义的行。
// label 与 metadata 均为已拼好的文本，组件不解析方向前缀，方向语义由调用方写入 label。
function DetailButton({
  label,
  metadata,
  onClick,
  relationType,
}: {
  label: string;
  metadata: string;
  onClick: () => void;
  relationType?: CapabilityRelationType;
}) {
  return (
    <button
      className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-2 rounded-md px-1 py-1.5 text-left hover:bg-menu-hover"
      onClick={onClick}
      type="button"
    >
      <i
        aria-hidden="true"
        className={`mt-1 size-2.5 rounded-full ${
          relationType
            ? `capability-relation-dot--${relationType}`
            : "bg-foreground-subtlest"
        }`}
      />
      <span className="min-w-0">
        <span className="block text-ui-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block break-words font-mono text-ui-xs text-foreground-subtlest">
          {metadata}
        </span>
      </span>
    </button>
  );
}
