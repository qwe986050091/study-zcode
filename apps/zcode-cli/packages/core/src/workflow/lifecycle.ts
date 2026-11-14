/**
 * ============================================================================
 * workflow/lifecycle.ts —— 工作流快照的生命周期变换（纯函数）
 * ============================================================================
 *
 * 【定位】只在"进程重启/恢复/取消/重开节点/注入图/更新节点 prompt"这些
 * 状态转换处修改快照；不涉及 I/O，也不启动子会话。调度器与运行时都调用它，
 * 保证同一转换只有一份实现。
 *
 * 【恢复语义（reconcileWorkflowSnapshotForResume）】
 *   进程停止时仍在 active 的节点并不代表"真的在跑"——旧进程已经没了。
 *   恢复时把这些节点重置为 pending（可重放），并清掉对应的 activity/phase，
 *   否则新进程会以为它们还在执行，永远等不到结果。
 *   只重置 nodeIds 范围内的节点：脚本恢复时可能只重放部分子图。
 *
 * 【取消语义】只有 active/pending 可取消；已 completed/failed/skipped 的节点
 *   保持终态（取消不是"抹掉历史"）。
 *
 * 【重开语义】只有 completed/failed/skipped 可重开（critic 打回重做），
 *   且受 maxReopens 限制；active/pending 不需要"重开"，它们本来就会再跑。
 * ============================================================================
 */

// 【职责】工作流快照的生命周期变换集合：恢复修复、取消、重开、图种子合并、节点 prompt 改写，全部是纯函数。
// 【边界】不读写盘、不起子会话、不发事件；只算出新快照与变化集，持久化与事件由调用方按 changed 决定。
// 【原则】任何不满足前置条件的请求都抛错而不是静默降级，静默降级会让上层误以为变更已生效。
// INV-01 恢复只把 active 降级为 pending，pending 与四种终态一律不动；守住位置：reconcileWorkflowSnapshotForResume 的 status 守卫；改错故障：已死的 active 不被重置，新进程永久等待永远不会完成的任务。
// INV-02 phase 与 activity 的恢复清理必须晚于节点重置且只针对命中范围；守住位置：shouldRepairPhase 与 shouldRepairActivity；改错故障：并行兄弟分支被一起打回，已完成工作被重复执行。
// INV-03 恢复时 activity 收口为 cancelled 而非 pending；守住位置：reconcile 的 closeActivity 调用处；改错故障：旧活动记录被当成可续跑，审计轨迹里出现两条同 ID 的活动。
// INV-04 changed 为 false 时必须返回入参快照本身；守住位置：每个变换函数末尾的三元表达式；改错故障：调用方按引用比较判断无变更失败，产生空写盘与重复事件。
// INV-05 updatedAt 不参与 changed 判定；守住位置：reconcile 与 cancel 的 changed 表达式；改错故障：每次恢复都被判为有变更，幂等重入退化成无限写盘。
// INV-06 取消只改 active 与 pending，终态节点保留原 error 与 completedAt；守住位置：cancelWorkflowSnapshot 的 CANCELLABLE_STATUSES 守卫；改错故障：已完成节点的结论被取消原因覆盖，历史不可追溯。
// INV-07 取消是幂等的，重复调用不得再次推进 completedAt；守住位置：closePhase 与 closeActivity 的空值合并；改错故障：首次取消时间被刷新，耗时统计与超时判定失真。
// INV-08 run 级 cancelled 与 completedAt 是取消的原子结果；守住位置：cancelWorkflowSnapshot 的 changed 与返回对象；改错故障：节点已取消但 run 仍显示运行中，界面卡在进行中。
// INV-09 重开只接受 completed、failed、skipped 三种终态；守住位置：REOPENABLE_STATUSES 校验分支；改错故障：active 节点被重开导致同节点两份并发执行记录。
// INV-10 reopenAttempts 每次成功重开自增一次且受 maxReopens 硬约束；守住位置：reopenWorkflowGraphNode 的计数分支；改错故障：critic 死循环打回烧空预算，或计数漂移导致提前拒绝合法重做。
// INV-11 重开不得改动其它节点与边，保持其引用不变；守住位置：reopen 的 map 与 graph 重建；改错故障：整图被本地化写出，下游基于引用的缓存全部失效。
// INV-12 图种子必须先通过 schema 再进入图约束校验；守住位置：applyWorkflowGraphSeed 的 parse 首行；改错故障：形状非法的种子让后续集合拿着 undefined 建键，错误推迟到渲染期才暴露。
// INV-13 节点判重必须同时覆盖既有图与种子内部；守住位置：existingNodeIds 与 pendingNodeIds；改错故障：同 ID 节点被静默追加两次，依赖边指向两份不同内容。
// INV-14 新增边必须通过自环、未知端点、重复与成环四道校验；守住位置：validateAddedEdges；改错故障：成环子图让调度器拓扑排序陷入等待，整个 run 永久挂起。
// INV-15 节点与 collection 的合并是纯追加，绝不覆盖既有元素；守住位置：applyWorkflowGraphSeed 的返回对象；改错故障：重跑 planner 时把上一批任务从图里挤掉。
// INV-16 prompt 更新只作用于调用方声明的 phase；守住位置：applyWorkflowNodePromptUpdates 的 phase 校验；改错故障：跨阶段改写覆盖别的阶段已定稿的任务描述。
// INV-17 prompt 更新必须先全量校验未知节点再开始改写；守住位置：nodeIds 预检查与后续 map；改错故障：异常抛出时携带半更新图，被上层误存。
// INV-18 边标识统一为 from 到 to 的字符串；守住位置：edgeId 与其全部调用点；改错故障：去重与成环检测口径不一致，重复边漏进图里把入度算重。
import {
  deriveWorkflowSessionLinks,
  type WorkflowActivitySnapshot,
  type WorkflowGraphCollection,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphSeed,
  WorkflowGraphSeedSchema,
  type WorkflowNodePromptUpdate,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowNodeStatus,
  type WorkflowPhaseSnapshot,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";

/**
 * 单节点状态变化的轻量描述（供调用方发事件），不含完整节点快照。
 */
export interface WorkflowGraphNodeChange {
  nodeId: string;
  phase?: string;
  status: WorkflowNodeStatus;
}

/**
 * 生命周期变换的统一返回：新快照 + 变化集合 + changed 标志。
 * changed=false 表示输入已是目标状态，调用方不应重复写盘/发事件。
 */
export interface WorkflowSnapshotLifecycleResult<TSnapshot extends WorkflowRunSnapshot> {
  activityIds: string[];
  changed: boolean;
  nodeChanges: WorkflowGraphNodeChange[];
  phaseIds: string[];
  snapshot: TSnapshot;
}

export interface ReconcileWorkflowSnapshotForResumeOptions {
  nodeIds?: Iterable<string>;
  reason?: string;
  resetActivities?: boolean;
  resetPhases?: boolean;
  timestamp: string;
}

export interface CancelWorkflowSnapshotOptions {
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeOptions {
  maxReopens?: number;
  nodeId: string;
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  nodeChange: WorkflowGraphNodeChange;
  reopenAttempts: number;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowGraphSeedOptions {
  phase?: string;
  timestamp: string;
}

export interface ApplyWorkflowGraphSeedResult<TSnapshot extends WorkflowRunSnapshot> {
  addedCollections: WorkflowGraphCollection[];
  addedEdges: WorkflowGraphEdge[];
  addedNodes: WorkflowGraphNode[];
  changed: boolean;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowNodePromptUpdatesOptions {
  phase: string;
  timestamp: string;
}

export interface ApplyWorkflowNodePromptUpdatesResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  snapshot: TSnapshot;
  updatedNodes: WorkflowGraphNode[];
}

// [权衡] 默认 reason 抽成常量而不是就地写字面量：这段文本会落进 node.error 并展示给用户，措辞必须稳定，才可按文本聚合进程中断回退。
// 两个状态集合都刻意不含 cancelled：cancelled 是吸收态，既不可再取消也不可重开；漏登记新状态会退化成静默不动而不是报错。
// 查表用 Set 而非数组：取消与恢复按节点逐个判断，数组线性查找在千节点图上会成为可观测开销。
const DEFAULT_RESUME_RESET_REASON =
  "Reset during workflow resume because the previous process stopped before completion.";
const DEFAULT_CANCEL_REASON = "Workflow cancelled.";
const DEFAULT_REOPEN_REASON = "Reopened by workflow critic.";
const CANCELLABLE_STATUSES = new Set<WorkflowNodeStatus>(["active", "pending"]);
const REOPENABLE_STATUSES = new Set<WorkflowNodeStatus>(["completed", "failed", "skipped"]);

/**
 * 恢复时的快照修复：把"上次进程里 active"的节点重置为可重放状态。
 *
 * 返回的 nodeChanges/activityIds/phaseIds 供调用方只针对变化的部分发事件，
 * changed=false 时调用方不应重复写快照（幂等恢复）。
 * 输入 snapshot + 可选 nodeIds/时间戳/是否重置 phase/activity；
 * 输出变化集合与新快照；纯函数，不写盘、不启动子会话。
 * 失败语义：无抛错分支；不可重放状态保持不变。
 * 不变量：只重置 scope 内 active 节点，phase/activity 按节点/phase 关联清理。
 */
export function reconcileWorkflowSnapshotForResume<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReconcileWorkflowSnapshotForResumeOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  // [失败路径] 恢复重置本质是把已死但没写墓碑的 active 降级，reason 会写进 node.error，供用户区分从未执行与中断后重放。
  // [权衡] nodeIds 先物化成 Set：入参可能是只能迭代一次的生成器，逐节点复查会拿到空集；代价是一次分配，换 O(1) 命中。
  // undefined 与空集合语义不同：前者表示不限范围、全量修复，后者表示一个都不修，两者不能合并成同一个判空。
  // resetActivities 与 resetPhases 默认 true 是安全侧默认：留着旧进程的 active 记录会让新进程以为还有任务在跑而挂起等待。
  const reason = options.reason ?? DEFAULT_RESUME_RESET_REASON;
  const nodeScope = options.nodeIds ? new Set(options.nodeIds) : undefined;
  const resetActivities = options.resetActivities ?? true;
  const resetPhases = options.resetPhases ?? true;
  const nodeChanges: WorkflowGraphNodeChange[] = [];
  const resetPhaseIdsFromNodes = new Set<string>();

  // [事务] 全程 map 出新数组、不改入参：快照可能被调用方按引用缓存或做前后对比，原地改会把变更前的视图一并污染。
  // 节点、phase、activity 三段顺序不可交换：phase 的修复判据依赖节点重置时收集到的 phase 名。
  // 命中范围判断统一放在节点侧做，phase 与 activity 侧只做二次推导，避免同一 scope 语义写两遍而走样。
  const nodes = snapshot.graph.nodes.map((node) => {
    // [失败路径] 只认 active：pending 本来就等待执行，重新置位只会产生无意义事件；四种终态属于历史结论，恢复无权改写。
    // [并发] 旧进程留下的 active 是进程已死、状态未收口的中间态，这里是单向降级；纯函数拿到的是不可变快照，无需与写者互斥。
    // node.phase 存在才收集：无 phase 的节点只影响自身，不应牵连任何 phase 级清理。
    if (node.status !== "active" || !isInScope(node.id, nodeScope)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "pending"));
    if (node.phase) {
      resetPhaseIdsFromNodes.add(node.phase);
    }
    return {
      ...node,
      error: reason,
      status: "pending" as const,
    };
  });

  const phaseIds: string[] = [];
  // [失败路径] phase 只有 active 才修：completed 与 failed 的 phase 是已结算结果，回退成 pending 会让下游重复执行整段。
  // 未限定节点时全量修；限定子图时只修确有节点被重置的 phase，否则并行执行的兄弟分支会被一起打回。
  // [事务] 这里产出新 phase 对象而非原地改写，phaseIds 与返回值必须同步产生，供调用方只对变化项发事件。
  const phases = snapshot.phases.map((phase) => {
    if (
      !resetPhases ||
      phase.status !== "active" ||
      !shouldRepairPhase(phase.phase, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return resetPhaseForRetry(phase, reason);
  });

  const activityIds: string[] = [];
  // [资源] activity 收口为 cancelled 而不是 pending：activity 代表一次真实发起的外部调用，重放必须新建记录，旧记录要留下终态与耗时。
  // closeActivity 保留已有的 completedAt 与 error，重复恢复不会覆盖首次结算结果。
  // sessionLinks 在末尾由新 activities 整体重算而不做增量修补，保证链接集合与活动集合恒一致。
  const activities = snapshot.activities.map((activity) => {
    if (
      !resetActivities ||
      activity.status !== "active" ||
      !shouldRepairActivity(activity, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  // [事务] changed 只统计实际改写；三者皆空时返回入参引用，调用方用引用比较就能零成本跳过写盘与事件。
  // 刻意不把 updatedAt 纳入判定：时间戳每次不同，算进去会让幂等恢复永远显示有变更。
  // 返回结构恒定并携带空数组，调用方无需判空即可直接遍历变化集。
  const changed = nodeChanges.length > 0 || phaseIds.length > 0 || activityIds.length > 0;
  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

/**
 * 取消快照：只把 active/pending 的节点/阶段/活动关闭为 cancelled；
 * 已终态节点保持原样（取消不是抹掉历史）。
 * 输入快照与 timestamp/reason；输出变化集合与新快照。
 * changed 口径包含 run 状态/completedAt 本身；纯函数，无副作用。
 */
export function cancelWorkflowSnapshot<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: CancelWorkflowSnapshotOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_CANCEL_REASON;
  const nodeChanges: WorkflowGraphNodeChange[] = [];

  const nodes = snapshot.graph.nodes.map((node) => {
    // [失败路径] 非可取消状态原样返回：终态节点若被再写一次，error 与 completedAt 会被本次取消原因覆盖，历史结论被抹掉。
    // [权衡] 重复取消不抛错：取消是用户主动且可能重试的动作，幂等成功比报错更符合预期，是否发事件交给 changed。
    // 节点、phase、activity 三条链路的可取消判据共用同一个集合，避免三处口径漂移。
    if (!CANCELLABLE_STATUSES.has(node.status)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "cancelled"));
    return {
      ...node,
      error: reason,
      status: "cancelled" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (!CANCELLABLE_STATUSES.has(phase.status)) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return closePhase(phase, "cancelled", options.timestamp, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (!CANCELLABLE_STATUSES.has(activity.status)) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  // [事务] run 级 status 与 completedAt 也参与 changed：即使节点早已终态，取消动作本身仍要把 run 收口并落取消时间。
  // completedAt 用严格不等比较：同一时间戳重复调用视为无变化，恢复流程可以安全重入。
  const changed =
    snapshot.status !== "cancelled" ||
    snapshot.completedAt !== options.timestamp ||
    nodeChanges.length > 0 ||
    phaseIds.length > 0 ||
    activityIds.length > 0;

  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          completedAt: options.timestamp,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          status: "cancelled",
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

/**
 * 重开一个已终态节点（completed/failed/skipped）为 pending，受 maxReopens 限制。
 * 输入 nodeId/maxReopens/timestamp；输出新快照、节点变化与累计重开次数。
 * 失败语义：节点不存在、状态不可重开、超过重开上限时抛错。
 * 不变量：reopenAttempts 随每次成功重开递增，不能绕过上限。
 */
export function reopenWorkflowGraphNode<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReopenWorkflowGraphNodeOptions,
): ReopenWorkflowGraphNodeResult<TSnapshot> {
  // [失败路径] 未知 nodeId 直接抛错：重开由 critic 异步驱动，静默忽略会让上游以为重做已排期，节点实际永远停在终态。
  // 错误文案同时给出当前状态与允许集合，便于从日志直接区分调用方用错与状态机走错。
  // 只按 id 线性查找：planner 场景的图规模在百级，建索引反而多一次全量遍历。
  const node = snapshot.graph.nodes.find((item) => item.id === options.nodeId);
  if (!node) {
    throw new Error(`Workflow graph node not found: ${options.nodeId}`);
  }
  if (!REOPENABLE_STATUSES.has(node.status)) {
    throw new Error(
      `Cannot reopen workflow node "${options.nodeId}": status is "${node.status}", expected completed, failed, or skipped`,
    );
  }

  // [权衡] 默认上限 2 次：一次重开的代价是整条下游重算，无上限在死循环缺陷下会把预算烧空。
  // [失败路径] reopenAttempts 缺失按 0 处理，兼容该字段引入前的旧快照。
  // 上限判断用大于等于：等于上限时不再放行，计数只在真正重开时自增，两者必须成对维护。
  const maxReopens = options.maxReopens ?? 2;
  const reopenAttempts = node.reopenAttempts ?? 0;
  if (reopenAttempts >= maxReopens) {
    throw new Error(
      `Workflow node "${options.nodeId}" already reopened ${reopenAttempts}x (max=${maxReopens})`,
    );
  }

  const nextAttempts = reopenAttempts + 1;
  const reason = options.reason ?? DEFAULT_REOPEN_REASON;
  // [事务] 只改目标节点的 status、error、reopenAttempts，其余节点仍取原引用，避免整图本地化导致下游缓存全失效。
  // 自增结果在同一处回写并作为返回值上报，保证快照里的计数与调用方看到的计数不会分叉。
  const nodes = snapshot.graph.nodes.map((item) =>
    item.id === options.nodeId
      ? {
          ...item,
          error: reason,
          reopenAttempts: nextAttempts,
          status: "pending" as const,
        }
      : item,
  );

  return {
    changed: true,
    nodeChange: nodeChange(node, "pending"),
    reopenAttempts: nextAttempts,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
  };
}

/**
 * 把 planner 产出的图种子合并进快照。
 * 输入 seed（节点/边/collection）与 phase/timestamp；
 * 先 schema 校验，再拒绝重复节点/边/collection、未知引用、自环与成环。
 * 输出新增元素与是否变化；changed=false 时不写快照。
 * 新节点固定 pending，collection 的 nodeIds 会并入节点自身 collectionId。
 */
export function applyWorkflowGraphSeed<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  seed: WorkflowGraphSeed,
  options: ApplyWorkflowGraphSeedOptions,
): ApplyWorkflowGraphSeedResult<TSnapshot> {
  // [失败路径] 先过 schema 再谈图约束：planner 输出是不可信外部数据，形状不合法时越早拒绝越好，否则后续会拿着 undefined 键静默推理。
  // 校验失败直接抛 ZodError，不做部分采纳：半张图比没有图更难诊断，也会让重跑产生不同结果。
  // 解析结果只读使用，不回写 seed，避免改到调用方持有对象的引用。
  const parsedSeed = WorkflowGraphSeedSchema.parse(seed);
  const existingNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  const addedNodes: WorkflowGraphNode[] = [];
  const pendingNodeIds = new Set<string>();

  // [事务] 判重需要两个集合：existingNodeIds 防与既有图冲突，pendingNodeIds 防种子内部自重复；只看其一会让同 ID 节点被静默追加两份。
  // 新节点固定 pending 且保留 collectionId，phase 缺省时继承本次调用的默认 phase。
  // dependsOn 去空后去重并保持首次出现顺序，供后续推导边的顺序稳定可复现。
  for (const node of parsedSeed.nodes) {
    if (existingNodeIds.has(node.id) || pendingNodeIds.has(node.id)) {
      throw new Error(`Workflow graph seed returned duplicate node: ${node.id}`);
    }
    pendingNodeIds.add(node.id);
    addedNodes.push({
      collectionId: node.collectionId,
      dependsOn: uniqueStrings(node.dependsOn ?? []),
      description: node.description,
      id: node.id,
      kind: node.kind ?? "task",
      phase: node.phase ?? options.phase,
      prompt: node.prompt,
      status: "pending",
      title: node.title,
    });
  }

  // [权衡] 显式边先入、dependsOn 推导边后补，并按 from 到 to 去重：两处来源可能表达同一条依赖，重复边会让入度算重、节点永不就绪。
  // 推导边允许指向既有节点，这是跨批次追加子图的前提，不能因为端点不在本次新增集合里就丢弃。
  // [事务] 先归一化边再做整图校验，顺序颠倒会让重复边在校验阶段被误判为新边。
  const addedEdges = normalizeSeedEdges(snapshot.graph.edges, addedNodes, parsedSeed.edges);
  validateAddedEdges(snapshot.graph.nodes, snapshot.graph.edges, addedNodes, addedEdges);

  const knownNodeIds = new Set([
    ...snapshot.graph.nodes.map((node) => node.id),
    ...addedNodes.map((node) => node.id),
  ]);
  const existingCollectionIds = new Set(
    (snapshot.graph.collections ?? []).map((collection) => collection.collectionId),
  );
  const addedCollections: WorkflowGraphCollection[] = [];
  const pendingCollectionIds = new Set<string>();
  // [事务] collection 同样需要既有集合加待办集合双重判重，漏任一侧都会产生同 ID 分组。
  // 成员列表取显式 nodeIds 与按 collectionId 反推的隐式成员之并集，再统一去重：planner 有时只声明分组而把成员留给节点侧。
  // [失败路径] 每个成员都必须落在既有节点与本次新增节点的并集内，悬空引用会让探索视图渲染出空分组。
  for (const collection of parsedSeed.collections) {
    if (
      existingCollectionIds.has(collection.collectionId) ||
      pendingCollectionIds.has(collection.collectionId)
    ) {
      throw new Error(
        `Workflow graph seed returned duplicate collection: ${collection.collectionId}`,
      );
    }
    pendingCollectionIds.add(collection.collectionId);
    const implicitNodeIds = addedNodes
      .filter((node) => node.collectionId === collection.collectionId)
      .map((node) => node.id);
    const nodeIds = uniqueStrings([...(collection.nodeIds ?? []), ...implicitNodeIds]);
    for (const nodeId of nodeIds) {
      if (!knownNodeIds.has(nodeId)) {
        throw new Error(
          `Workflow graph seed collection "${collection.collectionId}" references unknown node: ${nodeId}`,
        );
      }
    }
    addedCollections.push({
      collectionId: collection.collectionId,
      explorable: collection.explorable,
      frontierTarget: collection.frontierTarget,
      goal: collection.goal,
      metric: collection.metric,
      nodeIds,
      phase: collection.phase ?? options.phase,
      title: collection.title,
    });
  }

  // [事务] 三者全空时返回原快照：种子可能只含已存在元素，此时写盘只会刷新 updatedAt 并触发下游重算。
  // 合并采用纯追加语义，绝不覆盖既有节点、边与 collection。
  const changed = addedNodes.length > 0 || addedEdges.length > 0 || addedCollections.length > 0;
  return {
    addedCollections,
    addedEdges,
    addedNodes,
    changed,
    snapshot: changed
      ? ({
          ...snapshot,
          graph: {
            collections: [...(snapshot.graph.collections ?? []), ...addedCollections],
            edges: [...snapshot.graph.edges, ...addedEdges],
            nodes: [...snapshot.graph.nodes, ...addedNodes],
          },
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

/**
 * 应用节点 prompt/description/title 更新（planner 在固定阶段改写下游任务）。
 * 输入更新列表 + 目标 phase；输出更新后的节点与是否变化。
 * 失败语义：重复节点、未知节点、节点属于其它 phase 时抛错。
 * 无变化时返回 changed=false 与原快照（幂等）。
 */
export function applyWorkflowNodePromptUpdates<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  updates: readonly WorkflowNodePromptUpdate[],
  options: ApplyWorkflowNodePromptUpdatesOptions,
): ApplyWorkflowNodePromptUpdatesResult<TSnapshot> {
  // [失败路径] 整批过一次 schema：逐条校验会在中途抛错，且很难保证全成功或全失败。
  // schema 之外的语义校验随后逐条做：重复、未知节点、跨 phase，顺序固定为先结构后语义。
  // 重复 id 直接抛错而不是后者覆盖前者：planner 输出重复键说明它自身状态已不一致。
  const parsedUpdates = WorkflowNodePromptUpdateSetSchema.parse({ nodes: updates }).nodes;
  const updatesByNodeId = new Map<string, WorkflowNodePromptUpdate>();
  for (const update of parsedUpdates) {
    if (updatesByNodeId.has(update.id)) {
      throw new Error(`Workflow node prompt update returned duplicate node: ${update.id}`);
    }
    updatesByNodeId.set(update.id, update);
  }
  // [权衡] 空更新提前返回入参引用：planner 在无改写时仍会调用一次，这里保证不产生 updatedAt 抖动与空事件。
  // 此时 updatedNodes 返回空数组而不是省略字段，调用方的遍历逻辑无需分支。
  if (updatesByNodeId.size === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  // [失败路径] 未知节点在改写之前全量拒绝：map 里边改边抛会留下半更新的数组，虽未落盘，但异常对象可能被上层误存。
  // 预检用 Set 承载全部 id：节点数不大，但可以避免对每条更新各扫一遍图。
  const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  for (const nodeId of updatesByNodeId.keys()) {
    if (!nodeIds.has(nodeId)) {
      throw new Error(`Workflow node prompt update references unknown node: ${nodeId}`);
    }
  }

  const updatedNodes: WorkflowGraphNode[] = [];
  const nodes = snapshot.graph.nodes.map((node) => {
    const update = updatesByNodeId.get(node.id);
    if (!update) return node;
    // [失败路径] phase 不符即抛错：改 prompt 只允许作用于 planner 当前阶段，跨阶段会覆盖别的 planner 已定稿的描述。
    // node.phase 未定义视为无归属而允许更新，兼容早期未打 phase 标签的节点。
    if (node.phase !== undefined && node.phase !== options.phase) {
      throw new Error(
        `Workflow node prompt update for "${node.id}" targets phase "${options.phase}" but node belongs to "${node.phase}"`,
      );
    }

    const nextNode: WorkflowGraphNode = {
      ...node,
      description: update.description ?? node.description,
      prompt: update.prompt ?? node.prompt,
      title: update.title ?? node.title,
    };
    if (
      // [权衡] 三字段全等时返回原节点引用：保持引用稳定让上层可用浅比较，也避免无意义的时间戳变更。
      // updatedNodes 只收集真正变化的节点，事件量与原图规模解耦。
      nextNode.description === node.description &&
      nextNode.prompt === node.prompt &&
      nextNode.title === node.title
    ) {
      return node;
    }
    updatedNodes.push(nextNode);
    return nextNode;
  });

  if (updatedNodes.length === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  return {
    changed: true,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
    updatedNodes,
  };
}

/** scope 为 undefined 表示不限节点；否则按集合命中。 */
// [权衡] 修复范围用一个可空集合表达：undefined 表示全量，空集合表示全不修，二者语义不同，绝不能折叠成同一个无命中。
// shouldRepairPhase 在限定范围时只认确有节点被重置的 phase，防止把同 phase 下仍在运行的兄弟分支一起打回。
// shouldRepairActivity 取并集口径：节点命中或所属 phase 命中都修，覆盖没有 nodeId 的 phase 级活动。
// 三个判据都只读不写，可在 map 内反复调用而不改变输入。
function isInScope(value: string, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(value);
}

/** 未限定节点时全部修复；限定节点时只修复有节点被重置的 phase。 */
function shouldRepairPhase(
  phase: string,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  return resetPhaseIdsFromNodes.has(phase);
}

/** 活动修复口径：nodeId 在 scope 内，或所属 phase 有节点被重置。 */
function shouldRepairActivity(
  activity: WorkflowActivitySnapshot,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  if (activity.nodeId && nodeScope.has(activity.nodeId)) return true;
  return resetPhaseIdsFromNodes.has(activity.phase);
}

/** 构造节点变更事件；phase 为空时不携带字段。 */
function nodeChange(node: WorkflowGraphNode, status: WorkflowNodeStatus): WorkflowGraphNodeChange {
  return {
    nodeId: node.id,
    ...(node.phase ? { phase: node.phase } : {}),
    status,
  };
}

/** 把 phase 重置为 pending，仅保留 phase 名与原因。 */
function resetPhaseForRetry(phase: WorkflowPhaseSnapshot, reason: string): WorkflowPhaseSnapshot {
  return {
    error: reason,
    phase: phase.phase,
    status: "pending",
  };
}

/** 关闭 phase：completedAt/error 保留已有值，不覆盖首次终态。 */
// [资源] closePhase 与 closeActivity 都用空值合并保留首次值：重复取消或重复恢复不得改写 completedAt 与 error。
// phase 与 activity 必须与事件上报同序收口，先落状态再发事件，避免消费方读到过期的完成时间。
// cancelled 与 completed 共用同一收口函数，仅以 status 区分，防止两条路径的结算口径分叉。
function closePhase(
  phase: WorkflowPhaseSnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    ...phase,
    completedAt: phase.completedAt ?? timestamp,
    error: phase.error ?? reason,
    status,
  };
}

/** 关闭 activity：completedAt/error 保留已有值，避免重复结算覆盖首次结果。 */
function closeActivity(
  activity: WorkflowActivitySnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowActivitySnapshot {
  return {
    ...activity,
    completedAt: activity.completedAt ?? timestamp,
    error: activity.error ?? reason,
    status,
  };
}

/** 合并显式边与节点 dependsOn 推导边，按 from->to 去重。 */
// [事务] 去重键统一走 edgeId，避免显式边与推导边因对象身份不同而被当成两条。
// 保留显式边的原始顺序，推导边追加在后，保证同一份种子多次合并得到相同边序。
function normalizeSeedEdges(
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  seedEdges: readonly WorkflowGraphEdge[],
): WorkflowGraphEdge[] {
  const edges = seedEdges.map((edge) => ({ from: edge.from, to: edge.to }));
  const knownEdgeIds = new Set([...existingEdges, ...edges].map(edgeId));
  for (const node of addedNodes) {
    for (const dependencyId of node.dependsOn) {
      const edge = { from: dependencyId, to: node.id };
      const id = edgeId(edge);
      if (knownEdgeIds.has(id)) continue;
      edges.push(edge);
      knownEdgeIds.add(id);
    }
  }
  return edges;
}

/** 校验新增边：自环/未知端点/重复/成环全部拒绝（schema 之外的图约束）。 */
// [失败路径] 四类约束逐一 fail-fast：自环、未知端点、重复边、成环；任一成立都必须抛错，不能过滤后继续。
// 成环检测基于既有边与已通过校验的新增边，逐条增量推进，避免每加一条边就重跑整图遍历。
function validateAddedEdges(
  existingNodes: readonly WorkflowGraphNode[],
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  addedEdges: readonly WorkflowGraphEdge[],
): void {
  const nodeIds = new Set([...existingNodes, ...addedNodes].map((node) => node.id));
  const seenEdgeIds = new Set(existingEdges.map(edgeId));
  const pendingEdges = [...existingEdges];
  for (const edge of addedEdges) {
    if (edge.from === edge.to) {
      throw new Error(`Workflow graph seed returned a self-loop edge: ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(
        `Workflow graph seed returned an edge with unknown source node: ${edge.from}`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Workflow graph seed returned an edge with unknown target node: ${edge.to}`);
    }
    const id = edgeId(edge);
    if (seenEdgeIds.has(id)) {
      throw new Error(`Workflow graph seed returned duplicate edge: ${id}`);
    }
    if (wouldFormCycle(pendingEdges, edge)) {
      throw new Error(`Workflow graph seed returned an edge that would create a cycle: ${id}`);
    }
    seenEdgeIds.add(id);
    pendingEdges.push(edge);
  }
}

/** BFS 从新边终点出发，若能回到起点则成环。 */
// [失败路径] 从新边终点做 BFS，只要能回到起点就说明新增边闭合了环，返回 true 由调用方抛错。
// [权衡] 邻接表在每次调用时重建：边集规模小且调用次数有限，换成持久索引会引入与图可变性同步的复杂度。
function wouldFormCycle(edges: readonly WorkflowGraphEdge[], newEdge: WorkflowGraphEdge): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const queue = [newEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newEdge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

/** 边标识口径：from->to。 */
function edgeId(edge: WorkflowGraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

/** 去重并丢弃空串，保持首次出现顺序。 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
