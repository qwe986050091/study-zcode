// INV-01 [失败路径] runtime.plannerRunner 缺失时 checkCollectionPlanners 首个分支直接返回空增量与 0；改成抛错会让纯图调度（未装配 planner）整体失败。
// INV-02 [并发] 每个集合循环开头都执行 throwIfAborted，取消才能在 planner 未启动前生效；把检查提到循环外，取消后仍会多跑完一个集合。
// INV-03 [失败路径] 阶段与可探索性由 collection.explorable 和 isCollectionInPhase 联合过滤；删掉任一项都会跨阶段扩张，把别的阶段节点塞进当前图。
// INV-04 [事务] unseenCompletions 由 completedNodeIds 减去 collection.analyzedNodeIds 得到；换成对整集合比较会让已分析的完成节点反复触发扩张。
// INV-05 [事务] 发现未分析完成节点后先 updateGraphCollection 写 lastCompletionAt 再重读集合；漏写这一步，下游按时间戳判断新观测的分支全部失效。
// INV-06 [权衡] latestCollection 必须从 nextSnapshot 重读并以循环变量兜底；直接复用 collection 会读到上一轮已被改写的过期状态。
// INV-07 [失败路径] exhausted 标志与 status 为 exhausted 两个条件同时跳过；只判一个会让手工关闭的集合仍被重新拉起跑 planner。
// INV-08 [并发] shouldDeferInitialExpansion 固定四条件：frontier 大于 0、plannerRuns 为 0、analyzedNodeIds 为空、unseenCompletions 为空；放宽任一条会让零观测的首次扩张提前发生。
// INV-09 [事务] 延迟分支必须先把 status 置 active 再 continue；只 continue 不改状态会让集合长期停在 pending，前端与恢复逻辑看不到它在等待。
// INV-10 [权衡] frontierTarget 先取集合自身的值，缺失才回退 strategy.executor.frontierTarget；顺序反过来会让集合级覆盖永远不生效。
// INV-11 [事务] frontier 达到目标且 unseenCompletions 为空才跳过扩张；丢掉后半条件会在有观测待消化时拒绝补节点，图停止演化。
// INV-12 [资源] plannerRuns 上限判断排在 errorCount 阈值之前，命中即 exhaustCollection；顺序调换会让超轮数的集合再消费一次失败预算。
// INV-13 [失败路径] errorCount 是集合级累计失败数，成功不清零，与节点调度的 consecutiveErrors 口径不同；照抄连续错误语义会让阈值永远达不到。
// INV-14 [资源] addedNodeIds 只累积 runCollectionPlanner 返回的新增节点；把失败分支的空数组之外的 id 也计入会污染调度器的 executable 集合。
// INV-15 [事务] plannerRuns 在启动前加一并写入 activeCollection；改成成功后再加会让失败轮次不计入上限，planner 可无限重试。
// INV-16 [并发] 子会话回调先按 activityId 查活动并判 status 为 active 再 upsert；去掉这道闸会让已结算的活动被迟到的会话事件改回活跃。
// INV-17 [事务] 产物路径由 artifactDirectory 回退 artifacts/exec 再拼 planners 目录；改动层级会让历史产物在恢复时按旧路径找不到文件。
// INV-18 [失败路径] catch 内先判 abortSignal 已中止就原样抛出，其余错误累加 errorCount 并置 draining 或 exhausted；把取消也吞掉会让中断变成静默失败。
//
// 模块职责：每轮调度派发前的可探索集合扩张器，负责筛选集合、决定是否再跑 planner 子会话、落产物与合入图，并在失败时把集合推进到 draining 或 exhausted。
// 状态所有权：集合、活动、产物与事件全部经 runtime 与 eventLog 落到快照，本文件不持有跨轮内存状态，唯一的局部事实是 nextSnapshot 与 addedNodeIds。
// 阅读顺序：先看 checkCollectionPlanners 的过滤与四道收口，再看 runCollectionPlanner 的活动生命周期与 catch 降级，最后看 throwIfAborted 的取消语义。
import {
  createChildTraceContext,
  type WorkflowGraphCollection,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import { emitExpansionEvents, exhaustCollection } from "./collection-events.js";
import type { WorkflowCollectionPlannerRuntime } from "./collection-runtime.js";
import {
  addArtifact,
  collectionFrontier,
  collectionNodeIdsForGraph,
  compactWorkflowPayload,
  graphCollections,
  isCollectionInPhase,
  nodeById,
  normalizeCollection,
  updateGraphCollection,
  upsertActivity,
} from "./graph.js";
import { applyPlannerExpansion } from "./planner-expansion.js";
import { buildDefaultPlannerPrompt, safeArtifactName } from "./prompts.js";
import type { SchedulerCollection, WorkflowGraphSchedulerRunOptions } from "./types.js";

/**
 * ============================================================================
 * workflow/scheduler/collection-planner.ts —— 可探索集合的扩张循环
 * ============================================================================
 *
 * 【定位】每轮调度循环在派发节点前调用：遍历"可探索且属于当前阶段"的集合，
 * 判断是否需要再跑一轮 planner 子会话来补充节点/边。
 *
 * 【调度条件】集合必须 explorable、未 exhausted、phase 匹配；且满足以下之一：
 *   - 已有完成节点但尚未被分析（unseenCompletions > 0）；
 *   - frontier 低于 frontierTarget（待办/在飞节点不足）。
 * 初次扩张（plannerRuns=0 且已有 frontier）会先延迟一轮，避免在没有任何
 * 完成观测时凭空规划。
 *
 * 【终止条件】planner 自报 exhausted；frontier 达到目标且无未分析完成；
 * plannerRuns 达到 maxPlannerRuns；集合累计 errorCount 达到 maxConsecutiveErrors。
 * 注意这里的 errorCount 是集合级累计失败数，成功不会清零，与节点调度的
 * "连续错误"（一次成功即清零）口径不同。
 *
 * 【进度事件】planner_started →（可选 workflow_session_linked）→ planner_completed
 * →（graph_expanded / collection_exhausted）；失败路径 planner_failed，达阈值再发
 * collection_exhausted。事件由 eventLog 先落库再回调 onWorkflowEvent（UI/恢复消费）。
 * ============================================================================
 */

/**
 * 检查全部集合并执行必要的 planner 扩张。
 * 输入：当前快照、可执行节点集合、运行选项、planner 运行时。
 * 输出：新增节点 id 列表、本轮实际运行的 planner 数、更新后的快照。
 * 副作用：写快照、追加集合记录、发事件、写 planner 产物。
 * 失败语义：单个集合的 planner 失败被 catch 吞掉并转成集合 errorCount/draining，
 * 不终止整轮调度；只有 abortSignal 触发时才向上抛错。
 * 不变量：返回的 addedNodeIds 都会同步加入调度器的 executable 集合。
 */
// 每轮调度在派发节点前调用一次，遍历全部集合，只对可探索、处于当前阶段且未关闭的集合尝试扩张。
// [失败路径] 首个分支 plannerRunner 为空时立即返回空增量与 0，纯图模式依赖这条早退，不能改成抛错。
// [事务] nextSnapshot 是唯一可写的快照引用，每个分支都必须把写入结果赋回它，落回局部变量会丢掉整轮变更。
// [资源] addedNodeIds 只收集成功扩张新增的节点 id，调用方据此并入 executable 集合，失败分支必须保持为空。
// [失败路径] 只有 throwIfAborted 会把取消冒泡出本函数，其余单集合异常都在 runCollectionPlanner 内部消化。
// plannersRan 是成功跑完的轮数，不含被跳过的集合，也不能当作尝试次数用于统计或限流。
// 返回三元组里的 snapshot 必须来自最后一次写入结果，直接返回入参会抹掉本轮全部状态推进。
export async function checkCollectionPlanners(
  snapshot: WorkflowRunSnapshot,
  executableNodeIds: Set<string>,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<{ addedNodeIds: string[]; plannersRan: number; snapshot: WorkflowRunSnapshot }> {
  if (!runtime.plannerRunner) {
    return { addedNodeIds: [], plannersRan: 0, snapshot };
  }

  let nextSnapshot = snapshot;
  const addedNodeIds: string[] = [];
  let plannersRan = 0;

  // 循环用 for...of 按图内插入顺序顺序遍历，没有并发，一轮内集合严格串行处理。
  // [并发] 每轮首行的 throwIfAborted 是取消唯一生效点；挪到循环外，剩余集合在取消后仍会各自派发。
  // [失败路径] explorable 与 isCollectionInPhase 任一为假就 continue，两条件必须保持与关系，不能退化成单条件。
  // [事务] collectionNodeIds 先取集合全部节点，再筛出 status 为 completed 的进入 completedNodeIds。
  // [事务] unseenCompletions 是 completedNodeIds 中不在 analyzedNodeIds 里的差集，analyzedNodeIds 缺失时按空数组处理。
  // [权衡] frontier 在过滤之后才计算，表达当前可推进的节点数而不是节点总数，两者混用会让扩张判断整体偏移。
  // 循环体内不就地修改 collection，所有状态推进都通过回写 nextSnapshot 完成。
  for (const collection of graphCollections(nextSnapshot.graph)) {
    throwIfAborted(options.abortSignal);
    if (
      !collection.explorable ||
      !isCollectionInPhase(collection, nextSnapshot.graph, executableNodeIds, options.phase)
    ) {
      continue;
    }

    const collectionNodeIds = collectionNodeIdsForGraph(collection, nextSnapshot.graph);
    const frontier = collectionFrontier(nextSnapshot.graph, collection);
    const completedNodeIds = collectionNodeIds.filter(
      (nodeId) => nodeById(nextSnapshot.graph, nodeId)?.status === "completed",
    );
    const unseenCompletions = completedNodeIds.filter(
      (nodeId) => !(collection.analyzedNodeIds ?? []).includes(nodeId),
    );

    if (unseenCompletions.length > 0) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        collection.collectionId,
        {
          lastCompletionAt: runtime.eventLog.timestamp(),
        },
        runtime.eventLog.timestamp(),
      );
    }

    const latestCollection =
      graphCollections(nextSnapshot.graph).find(
        (item) => item.collectionId === collection.collectionId,
      ) ?? collection;
    if (latestCollection.exhausted || latestCollection.status === "exhausted") {
      continue;
    }

    // 初次扩张延迟：pristine 集合已经有待办/在飞节点（frontier>0）、从未跑过 planner、
    // 也没分析过任何完成节点时，先让现有节点跑出结果，避免 planner 无观测可依据。
    // [契约] shouldDeferInitialExpansion 只决定首轮是否空转一次：frontier>0 与三条零观测条件同时成立才延迟，任一为 false 立刻放行。
    // [并发] frontier 大于 0 是延迟前提，说明已有待办或在飞节点可先跑；去掉它会让空集合永远等不到第一次扩张。
    // [事务] plannerRuns 为 0 且 analyzedNodeIds 为空共同表示集合毫无观测，任一不满足就应正常扩张。
    // [事务] unseenCompletions 为空是第四条约束，一旦存在未分析完成节点就必须立刻扩张去消化观测。
    // [失败路径] 延迟分支要把 status 写成 active 再 continue，否则集合停在原状态，前端与恢复逻辑看不到它在等待。
    // [权衡] 这里只延迟一轮而非等到 frontier 耗尽：代价是可能少一次补节点机会，收益是不在零观测时凭空规划。
    const shouldDeferInitialExpansion =
      frontier > 0 &&
      (latestCollection.plannerRuns ?? 0) === 0 &&
      (latestCollection.analyzedNodeIds ?? []).length === 0 &&
      unseenCompletions.length === 0;
    if (shouldDeferInitialExpansion) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        latestCollection.collectionId,
        { status: "active" },
        runtime.eventLog.timestamp(),
      );
      continue;
    }

    // frontier 已达到目标且没有新完成节点可分析 → 现有工作量足够，无需扩张。
    const frontierTarget =
      latestCollection.frontierTarget ?? nextSnapshot.strategy.executor.frontierTarget;
    // 这条判断是现有工作量已足够的收口，两个条件必须用与连接，缺一不可。
    // [事务] frontierTarget 先在集合自身取，缺失才回退 strategy.executor.frontierTarget，方向不能反。
    // [失败路径] 丢掉 unseenCompletions 判断会在有完成节点待分析时也跳过扩张，观测从此永久积压。
    // 命中后把 status 置 active 并 continue，此处刻意不写 lastCompletionAt，避免污染新观测的判定。
    // [资源] 紧随其后的 plannerRuns 上限分支优先级更高，达到 maxPlannerRuns 直接 exhaustCollection 关闭集合。
    // [权衡] 轮数上限排在错误阈值之前，保证已超轮数的集合不再消耗 maxConsecutiveErrors 的失败预算。
    if (frontier >= frontierTarget && unseenCompletions.length === 0) {
      nextSnapshot = updateGraphCollection(
        nextSnapshot,
        latestCollection.collectionId,
        { status: "active" },
        runtime.eventLog.timestamp(),
      );
      continue;
    }

    // 轮数上限优先于错误阈值：达到即强制关闭集合，防止 planner 无限扩张。
    if ((latestCollection.plannerRuns ?? 0) >= nextSnapshot.strategy.executor.maxPlannerRuns) {
      nextSnapshot = await exhaustCollection(nextSnapshot, latestCollection, options, runtime, {
        reason: "max_planner_runs",
      });
      continue;
    }

    // 错误阈值：errorCount 由 runCollectionPlanner 累加且成功不清零（是集合累计
    // 失败数，不是节点循环里的 consecutiveErrors），达到上限即强制关闭集合。
    if ((latestCollection.errorCount ?? 0) >= nextSnapshot.strategy.executor.maxConsecutiveErrors) {
      nextSnapshot = await exhaustCollection(nextSnapshot, latestCollection, options, runtime, {
        reason: "planner_error_threshold",
      });
      continue;
    }

    const result = await runCollectionPlanner(
      nextSnapshot,
      latestCollection,
      unseenCompletions,
      options,
      runtime,
    );
    nextSnapshot = result.snapshot;
    addedNodeIds.push(...result.addedNodeIds);
    plannersRan++;
  }

  return { addedNodeIds, plannersRan, snapshot: nextSnapshot };
}

/**
 * 执行单轮集合 planner：建立 active 活动 → 跑子会话 → 落产物 → 合入图 → 结算活动。
 * 输入：快照、集合、未分析的完成节点、运行选项、运行时。
 * 输出：新增节点 id 与本轮结束后的快照。
 * 成功路径事件顺序：planner_started → workflow_session_linked（若子会话启动）→
 * planner_completed → graph_expanded（有增量）→ collection_exhausted（若耗尽）。
 * 失败语义：abort 触发时抛错；其余错误累加 errorCount，未达阈值置 draining 并返回
 * 空增量，达到阈值置 exhausted 并补发 collection_exhausted（reason=planner_error_threshold）。
 * 不变量：plannerRuns 在启动前 +1；活动最终一定落到 completed 或 failed。
 */
// 单轮扩张的全部状态机都在这里：建活动、跑子会话、落产物、合入图、结算活动。
// [事务] plannerRuns 在启动前加一，随 activeCollection 一起落库，失败轮次同样计入上限。
// [资源] activityId 与 startedAt 在开头一次生成，成功与失败路径共用，重试不能复用旧 id。
// [事务] activeSnapshot 由集合更新与活动 upsert 叠加而成，两步写入都取 eventLog 的时间戳。
// [事务] 进入子会话前必须先 writeSnapshot 再 appendCollectionRecord，顺序颠倒会让恢复读到没有活动记录的集合。
// [失败路径] 开局再判一次 plannerRunner 缺失并返回空增量，作为调用方前置检查的兜底。
async function runCollectionPlanner(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  unseenCompletions: readonly string[],
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<{ addedNodeIds: string[]; snapshot: WorkflowRunSnapshot }> {
  if (!runtime.plannerRunner) return { addedNodeIds: [], snapshot };

  const activityId = runtime.createActivityId();
  const startedAt = runtime.eventLog.timestamp();
  const plannerRuns = (collection.plannerRuns ?? 0) + 1;
  const inputArtifactPaths = snapshot.artifacts.map((artifact) => artifact.path);
  const traceContext = options.traceContext
    ? createChildTraceContext(options.traceContext, {
        attributes: {
          workflowActivityId: activityId,
          workflowCollectionId: collection.collectionId,
          workflowKind: snapshot.kind,
          workflowPhase: options.phase,
          workflowRunId: snapshot.runId,
        },
        sessionId: options.traceContext.sessionId,
      })
    : undefined;
  const activeCollection: SchedulerCollection = normalizeCollection({
    ...collection,
    plannerRuns,
    status: "active" as const,
  });
  const activeSnapshot = upsertActivity(
    updateGraphCollection(
      snapshot,
      collection.collectionId,
      activeCollection,
      runtime.eventLog.timestamp(),
    ),
    {
      activityId,
      inputArtifactPaths,
      kind: "planner_agent",
      outputArtifactPaths: [],
      parentSessionId: options.parentSessionId,
      phase: options.phase,
      startedAt,
      status: "active",
      traceId: traceContext?.traceId,
    },
    runtime.eventLog.timestamp(),
  );
  await runtime.writeSnapshot(activeSnapshot, { signal: options.abortSignal });
  await runtime.eventLog.appendCollectionRecord(
    activeSnapshot,
    activeCollection,
    options.abortSignal,
  );
  await runtime.eventLog.emitEvent(activeSnapshot, "planner_started", {
    message: `Planner started for collection: ${collection.collectionId}`,
    payload: {
      collectionId: collection.collectionId,
      frontier: collectionFrontier(activeSnapshot.graph, activeCollection),
      plannerRuns,
      unseenCompletions,
    },
    phase: options.phase,
    signal: options.abortSignal,
  });
  let plannerSnapshot = activeSnapshot;

  try {
    // 这里是真正拉起 planner 子会话的调用点，prompt 由 buildDefaultPlannerPrompt 基于当前快照与阶段生成。
    // [并发] 子会话启动回调里先按 activityId 查活动，状态已不是 active 就直接返回，不再改快照。
    // [事务] 回调以当前活动为基线合并 model、sessionId、traceId、turnId，只覆盖事件里实际带到的字段。
    // [事务] 回调每次都会写快照并发 workflow_session_linked，保证子会话 id 在 planner 结束前可被恢复读取。
    // [资源] 产物文件名由 safeArtifactName 处理集合 id 再拼 plannerRuns，去掉它会让含路径字符的 id 写出目录。
    // [事务] 成功后先追加 planner_completed 再交给 emitExpansionEvents，前者只报增量计数，后者负责逐条扩张事件。
    const plannerResult = await runtime.plannerRunner.run({
      abortSignal: options.abortSignal,
      activityId,
      collection: activeCollection,
      cwd: options.cwd,
      graph: activeSnapshot.graph,
      onChildSessionStarted: async (event) => {
        const currentActivity = plannerSnapshot.activities.find(
          (activity) => activity.activityId === activityId,
        );
        if (!currentActivity || currentActivity.status !== "active") return;
        plannerSnapshot = upsertActivity(
          plannerSnapshot,
          {
            ...currentActivity,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          },
          runtime.eventLog.timestamp(),
        );
        await runtime.writeSnapshot(plannerSnapshot, { signal: options.abortSignal });
        await runtime.eventLog.emitEvent(plannerSnapshot, "workflow_session_linked", {
          message: `Workflow session linked: ${event.sessionId}`,
          payload: compactWorkflowPayload({
            activityId,
            collectionId: collection.collectionId,
            model: event.model,
            sessionId: event.sessionId,
            traceId: event.traceId,
            turnId: event.turnId,
          }),
          phase: options.phase,
          signal: options.abortSignal,
        });
      },
      onEvent: options.onEvent,
      parentSessionId: options.parentSessionId,
      phase: options.phase,
      prompt: buildDefaultPlannerPrompt(activeSnapshot, activeCollection, options.phase),
      runId: plannerSnapshot.runId,
      snapshot: plannerSnapshot,
      task: plannerSnapshot.task,
      traceContext,
    });
    const artifact = await runtime.writeArtifact(
      plannerSnapshot.runId,
      `${options.artifactDirectory ?? "artifacts/exec"}/planners/${safeArtifactName(collection.collectionId)}-${plannerRuns}.md`,
      plannerResult.response,
      { signal: options.abortSignal },
    );
    const expanded = applyPlannerExpansion(
      plannerSnapshot,
      activeCollection,
      plannerResult,
      unseenCompletions,
      runtime.eventLog.timestamp(),
    );
    const completedSnapshot = upsertActivity(
      addArtifact(
        expanded.snapshot,
        {
          contentType: "text/markdown",
          createdAt: runtime.eventLog.timestamp(),
          label: `Planner ${collection.collectionId}`,
          path: artifact.relativePath,
          phase: options.phase,
        },
        runtime.eventLog.timestamp(),
      ),
      {
        activityId,
        artifactPath: artifact.relativePath,
        completedAt: runtime.eventLog.timestamp(),
        inputArtifactPaths,
        kind: "planner_agent",
        outputArtifactPaths: [artifact.relativePath],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        ...(plannerResult.model ? { model: plannerResult.model } : {}),
        sessionId: plannerResult.sessionId,
        startedAt,
        status: "completed",
        traceId: plannerResult.traceId ?? traceContext?.traceId,
        turnId: plannerResult.turnId,
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(completedSnapshot, { signal: options.abortSignal });
    await runtime.eventLog.appendExpansionRecords(
      completedSnapshot,
      expanded,
      options.phase,
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(completedSnapshot, "planner_completed", {
      message: `Planner completed for collection: ${collection.collectionId}`,
      payload: {
        collectionId: collection.collectionId,
        edgeCount: expanded.addedEdges.length,
        nodeCount: expanded.addedNodes.length,
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
    await emitExpansionEvents(
      completedSnapshot,
      expanded,
      collection.collectionId,
      options,
      runtime,
    );
    return {
      addedNodeIds: expanded.addedNodes.map((node) => node.id),
      snapshot: completedSnapshot,
    };
  // [失败路径] 首行判 abortSignal 是否已中止，命中即原样抛出，取消不进入任何降级路径。
  // [失败路径] errorCount 在 activeCollection 基准上加一，达到 maxConsecutiveErrors 才把 exhausted 置真。
  // [事务] failedCollection 的 status 在 exhausted 与 draining 间二选一，写入后立即 appendCollectionRecord 留痕。
  // [资源] 活动结算为 failed 并保留 inputArtifactPaths、输出路径置空，避免恢复时误判存在产物。
  // [失败路径] 仅 exhausted 时补发 collection_exhausted，reason 固定 planner_error_threshold；提前发会把未达阈值的集合当成终止。
  } catch (error) {
    if (options.abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCount = (activeCollection.errorCount ?? 0) + 1;
    const currentActivity = plannerSnapshot.activities.find(
      (activity) => activity.activityId === activityId,
    );
    const exhausted = errorCount >= plannerSnapshot.strategy.executor.maxConsecutiveErrors;
    const failedCollection: WorkflowGraphCollection = {
      ...activeCollection,
      errorCount,
      exhausted,
      status: exhausted ? "exhausted" : "draining",
    };
    const failedSnapshot = upsertActivity(
      updateGraphCollection(
        plannerSnapshot,
        collection.collectionId,
        failedCollection,
        runtime.eventLog.timestamp(),
      ),
      {
        activityId,
        completedAt: runtime.eventLog.timestamp(),
        error: errorMessage,
        inputArtifactPaths,
        kind: "planner_agent",
        ...(currentActivity?.model ? { model: currentActivity.model } : {}),
        outputArtifactPaths: [],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
        startedAt,
        status: "failed",
        traceId: currentActivity?.traceId ?? traceContext?.traceId,
        ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(failedSnapshot, { signal: options.abortSignal });
    await runtime.eventLog.appendCollectionRecord(
      failedSnapshot,
      failedCollection,
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(failedSnapshot, "planner_failed", {
      message: errorMessage,
      payload: {
        collectionId: collection.collectionId,
        errorCount,
        exhausted,
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
    if (exhausted) {
      await runtime.eventLog.emitEvent(failedSnapshot, "collection_exhausted", {
        message: `Collection exhausted: ${collection.collectionId}`,
        payload: {
          collectionId: collection.collectionId,
          reason: "planner_error_threshold",
        },
        phase: options.phase,
        signal: options.abortSignal,
      });
    }
    return { addedNodeIds: [], snapshot: failedSnapshot };
  }
}

/**
 * 取消检查：signal 已触发时抛出 signal.reason（非 Error 时包成通用错误）。
 * 放在集合遍历每轮开头，保证取消能及时打断尚未开始的 planner。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow scheduler aborted");
}
