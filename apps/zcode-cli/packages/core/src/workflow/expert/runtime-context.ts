/**
 * ============================================================================
 * workflow/expert/runtime-context.ts —— 单 run 的内存运行时上下文
 * ============================================================================
 *
 * 【定位】把"依赖注入 + 定义解析 + id/时钟 + store 代理 + 事件双写"收敛为一个
 * 对象，供 runtime/run-loop/phase-runner/critic-loop 共用。它不持有 run 的权威
 * 状态：权威状态始终在传入/返回的 snapshot 与 store 里；本类只提供派生与写入
 * 辅助，避免每个调用点各写一份 map/事件拼装。
 *
 * 【事件顺序不变量】appendEvent 必须先 append 到 store，再回调 onWorkflowEvent：
 * UI 看到的事件一定已经落库，冷恢复不会丢事件；回调抛错会中断调用方流程。
 *
 * 【快照更新不变量】updateSnapshot/updatePhase/addArtifact/upsertActivity 都是
 * 纯内存复制，统一刷新 updatedAt；调用方负责 writeSnapshot。这样一次逻辑变更
 * 只落一次盘，且不会出现"内存已改、磁盘未写"的中间态被并发读到。
 * ============================================================================
 */

import { randomUUID } from "node:crypto";
import {
  WorkflowDefinitionSchema,
  deriveWorkflowSessionLinks,
  type ExpertWorkflowRunSnapshot,
  type WorkflowActivitySnapshot,
  type WorkflowArtifact,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowPhaseDefinition,
  type WorkflowPhaseSnapshot,
} from "@zcode/contracts";
import { createExpertWorkflowDefinition, workflowDefinitionPhaseMap } from "../definition.js";
import type { WorkflowGraphNodeChange, WorkflowSnapshotLifecycleResult } from "../lifecycle.js";
import { phaseNodeId, safeRunIdSegment } from "./ids.js";
import { createPhaseGraph, updateGraphNodeStatus } from "./prompts.js";
import type { ExpertWorkflowLookupOptions, ExpertWorkflowRuntimeDeps } from "./types.js";

/**
 * 运行时上下文。
 *
 * 生命周期是"每次命令一个实例"（start/status/retry 各自 new 一次），因此只缓存
 * 定义与依赖；run 级状态不放这里，避免跨命令残留。
 */
export class ExpertWorkflowRuntimeContext {
  // runId → 当前活跃 controller。cancel() 通过它打断正在 await 的子会话；
  // 同一 runId 重复注册会覆盖旧值，旧 controller 由 dispose 负责清理。
  readonly activeRunAbortControllers = new Map<string, AbortController>();
  // 子会话执行端口（外部注入，runtime 不做包装/重试）。
  readonly agentRunner: ExpertWorkflowRuntimeDeps["agentRunner"];
  // activity id 生成器（默认 uuid）；必须全局唯一，重试会不断新增 activity。
  readonly createActivityId: () => string;
  // run id 生成器（默认 wf_<kind>_<uuid>）；run 目录以它命名。
  readonly createRunId: () => string;
  // 经 schema 校验后的定义；phaseOrder/phases/strategy 都从这里读，保证内部一致。
  readonly definition: WorkflowDefinition;
  // 时钟注入；所有 timestamp 统一走它（timestamp() 返回 ISO 字符串）。
  readonly now: () => Date;
  // 事件落库后的回调（UI/投影）；抛错会穿透到当前命令。
  readonly onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  // phase → 定义 的索引；getPhaseDefinition 用它做 O(1) 查找。
  readonly phaseDefinitions: Map<string, WorkflowPhaseDefinition>;
  // 持久化端口；本类所有 I/O 都只经它。
  readonly store: ExpertWorkflowRuntimeDeps["store"];

  /**
   * 装配上下文。
   *
   * 输入依赖里只有 agentRunner 与 store 必填；definition 缺省用内置 expert 定义，
   * 并统一过 WorkflowDefinitionSchema.parse（非法定义在这里就失败，而不是跑到
   * 某个阶段才炸）。
   * 副作用：无 I/O；只构造字段与索引。
   */
  constructor(deps: ExpertWorkflowRuntimeDeps) {
    this.definition = WorkflowDefinitionSchema.parse(
      deps.definition ?? createExpertWorkflowDefinition(),
    );
    this.phaseDefinitions = workflowDefinitionPhaseMap(this.definition);
    this.agentRunner = deps.agentRunner;
    this.createActivityId = deps.createActivityId ?? (() => `act_${randomUUID()}`);
    this.createRunId =
      deps.createRunId ?? (() => `wf_${safeRunIdSegment(this.definition.kind)}_${randomUUID()}`);
    this.now = deps.now ?? (() => new Date());
    this.onWorkflowEvent = deps.onWorkflowEvent;
    this.store = deps.store;
  }

  /**
   * 构造一个全新 run 的初始快照（未落盘）。
   *
   * 口径：所有阶段都是 pending，graph 是 createPhaseGraph 生成的线性阶段链
   * （task 节点要等 arch_decompose 的产物播种才有），activities/artifacts/
   * sessionLinks/recoveryActions 全为空，status 固定 pending（start 会立刻改 running）。
   *
   * 副作用：仅生成 id 与时间戳（createRunId/timestamp）；调用方负责 writeSnapshot
   * 与 writeInitialGraph，保证"快照先于图记录"的写入顺序。
   */
  createInitialSnapshot(options: {
    cwd: string;
    sessionId?: string;
    task: string;
    traceContext?: { traceId: string };
  }): ExpertWorkflowRunSnapshot {
    const runId = this.createRunId();
    const timestamp = this.timestamp();
    // phaseOrder 直接来自定义（已 schema 校验）；phases 按它初始化可保证顺序与定义一致。
    const phaseOrder = this.definition.phaseOrder;
    return {
      activities: [],
      artifacts: [],
      createdAt: timestamp,
      cwd: options.cwd,
      definitionId: this.definition.definitionId,
      definitionVersion: this.definition.definitionVersion,
      // 初始图只有阶段节点与阶段间边；task 节点稍后由图播种写入。
      graph: createPhaseGraph(this.definition),
      kind: this.definition.kind,
      phaseOrder,
      // 阶段状态与 graph 节点状态是两份事实：这里是 phases 侧，graph 侧由 createPhaseGraph 置 pending。
      phases: phaseOrder.map((phase) => ({
        phase,
        status: "pending",
      })),
      recoveryActions: [],
      runId,
      schemaVersion: 1,
      sessionId: options.sessionId,
      // sessionLinks 空表示还没有任何子会话；由 upsertActivity 逐步派生。
      sessionLinks: [],
      status: "pending",
      // strategy 快照化：恢复/重试以这里为准，不受后续代码默认值变化影响。
      strategy: this.definition.strategy,
      task: options.task,
      traceId: options.traceContext?.traceId,
      updatedAt: timestamp,
    };
  }

  /**
   * 把初始图写成 append-only 图记录（meta → node → edge → collection）。
   *
   * 顺序要求：meta 必须最先写，恢复端靠它拿 phaseOrder/strategy/definition 版本；
   * 节点先于边，避免重放时出现指向未知节点的边。逐条 await，保证落盘顺序。
   * 副作用：写 graph 记录，不写快照；失败直接向上抛（调用方会让 start 失败）。
   */
  async writeInitialGraph(
    snapshot: ExpertWorkflowRunSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.store.appendGraphRecord(
      snapshot.runId,
      {
        createdAt: snapshot.createdAt,
        definitionId: snapshot.definitionId,
        definitionVersion: snapshot.definitionVersion,
        phaseOrder: snapshot.phaseOrder,
        recordType: "meta",
        runId: snapshot.runId,
        schemaVersion: 1,
        strategy: snapshot.strategy,
      },
      { signal },
    );
    // 节点必须在边之前落盘：重放时边一旦先出现，恢复端会看到指向未知节点的引用。
    for (const node of snapshot.graph.nodes) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          node,
          recordType: "node",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    for (const edge of snapshot.graph.edges) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          edge,
          recordType: "edge",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    for (const collection of snapshot.graph.collections ?? []) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          collection,
          recordType: "collection",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
  }

  /**
   * 追加"阶段节点"的状态变更（update_status）。
   *
   * 等价于 appendGraphNodeStatus(phaseNodeId(phase))；只写图记录，不改快照
   * （快照由 updatePhase 负责），两条事实分别落盘后才能被恢复端一致回放。
   */
  async appendGraphStatus(
    snapshot: ExpertWorkflowRunSnapshot,
    phase: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphNodeStatus(snapshot, phaseNodeId(phase), status, signal, phase);
  }

  /**
   * 追加任意节点的状态变更。
   *
   * 输入 nodeId 必须是图里真实存在的节点（本方法不校验，调用方通常已从
   * nodeChanges 得来）；phase 只作为记录标签，便于按阶段过滤。
   * 副作用：一条 append-only 图记录；失败向上抛，不吞错。
   */
  async appendGraphNodeStatus(
    snapshot: ExpertWorkflowRunSnapshot,
    nodeId: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
    phase?: string,
  ): Promise<void> {
    await this.store.appendGraphRecord(
      snapshot.runId,
      {
        nodeId,
        phase,
        recordType: "op",
        runId: snapshot.runId,
        status,
        timestamp: this.timestamp(),
        type: "update_status",
      },
      { signal },
    );
  }

  /**
   * 追加一条 workflow 进度事件。
   *
   * 顺序不变量：先 store.appendEvent 落库，成功后再回调 onWorkflowEvent；
   * 回调抛错会向上传播（调用方命令失败），但事件本身已落库，不会丢。
   * kind 取 definition.kind（保证 UI 按工作流种类过滤一致），timestamp 走注入时钟。
   * 可选字段（message/nodeId/payload/phase）原样透传，不做裁剪。
   */
  async appendEvent(
    runId: string,
    type: WorkflowEvent["type"],
    options: {
      message?: string;
      nodeId?: string;
      payload?: Record<string, unknown>;
      phase?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const event: WorkflowEvent = {
      kind: this.definition.kind,
      message: options.message,
      nodeId: options.nodeId,
      payload: options.payload,
      phase: options.phase,
      runId,
      timestamp: this.timestamp(),
      type,
    };
    await this.store.appendEvent(event, { signal: options.signal });
    await this.onWorkflowEvent?.(event);
  }

  /**
   * 批量追加生命周期变换产生的节点状态变更。
   *
   * nodeChanges 来自 lifecycle 的纯函数（resume/cancel/retry），可能含重复 nodeId；
   * 本方法按数组顺序逐条写，不做去重（调用方在 retry 时已 dedupe）。
   * 副作用：N 条图记录；任一写失败即中断，后续变更不落盘。
   */
  async appendLifecycleGraphChanges(
    snapshot: ExpertWorkflowRunSnapshot,
    nodeChanges: readonly WorkflowGraphNodeChange[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const change of nodeChanges) {
      await this.appendGraphNodeStatus(
        snapshot,
        change.nodeId,
        change.status,
        signal,
        change.phase,
      );
    }
  }

  /**
   * 通用快照补丁（浅合并）。
   *
   * 只允许 patch 白名单字段（生命周期与收尾相关），刻意不开放 activities/graph/
   * phases：这些必须走 updatePhase/upsertActivity/addArtifact，避免绕过各自的不变量
   * （例如忘记同步 sessionLinks 或 graph 节点状态）。返回新对象并刷新 updatedAt。
   */
  updateSnapshot(
    snapshot: ExpertWorkflowRunSnapshot,
    patch: Partial<
      Pick<
        ExpertWorkflowRunSnapshot,
        | "completedAt"
        | "currentPhase"
        | "failure"
        | "pauseReason"
        | "recoveryActions"
        | "reportPath"
        | "startedAt"
        | "status"
      >
    >,
  ): ExpertWorkflowRunSnapshot {
    return {
      ...snapshot,
      ...patch,
      updatedAt: this.timestamp(),
    };
  }

  /**
   * 更新某个阶段的口径。
   *
   * 同时做三件事：patch phases 里该阶段条目、用 patch.status 同步 graph 中
   * phase:<phase> 节点的状态、把 currentPhase 指向该阶段。patch 可只含 error/
   * artifactPath/sessionId 等而不含 status（此时图节点状态保持不变）。
   * 纯内存变换，返回新快照；调用方负责 writeSnapshot 与 appendGraphStatus。
   */
  updatePhase(
    snapshot: ExpertWorkflowRunSnapshot,
    phase: string,
    patch: Partial<WorkflowPhaseSnapshot>,
  ): ExpertWorkflowRunSnapshot {
    return this.updateSnapshot(
      {
        ...snapshot,
        currentPhase: phase,
        graph: updateGraphNodeStatus(snapshot.graph, phase, patch.status),
        phases: snapshot.phases.map((item) =>
          item.phase === phase
            ? {
                ...item,
                ...patch,
              }
            : item,
        ),
      },
      {
        currentPhase: phase,
      },
    );
  }

  /**
   * 登记（或覆盖）一个 artifact 引用。
   *
   * 按 path 去重：同路径视为"同一份产物被重写"，新条目替换旧条目而不是追加，
   * 保证 artifacts 列表可作为"磁盘上现存的产物清单"。
   * 不写文件（文件由 store.writeArtifact 负责），纯内存变换。
   */
  addArtifact(
    snapshot: ExpertWorkflowRunSnapshot,
    artifact: WorkflowArtifact,
  ): ExpertWorkflowRunSnapshot {
    const artifacts = [
      ...snapshot.artifacts.filter((item) => item.path !== artifact.path),
      artifact,
    ];
    return {
      ...snapshot,
      artifacts,
      updatedAt: this.timestamp(),
    };
  }

  /**
   * 按 activityId 插入/更新一条 activity，并重算 sessionLinks。
   *
   * 口径：同一 activityId 在一个 run 内只应有一条记录（启动时 active，结束时
   * completed/failed 原地覆盖），因此用 filter+push 实现 upsert，保留原有顺序。
   * sessionLinks 必须随 activities 一起派生：否则重试产生的新 attempt 不会出现
   * 在链接表里，UI 会漏掉子会话。
   * 纯内存变换；调用方负责 writeSnapshot。
   */
  upsertActivity(
    snapshot: ExpertWorkflowRunSnapshot,
    activity: WorkflowActivitySnapshot,
  ): ExpertWorkflowRunSnapshot {
    const activities = [
      ...snapshot.activities.filter((item) => item.activityId !== activity.activityId),
      activity,
    ];
    return {
      ...snapshot,
      activities,
      sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
      updatedAt: this.timestamp(),
    };
  }

  /**
   * 定位一个 run 的当前事实。
   *
   * 口径：runId 存在则精确读取（可能返回 null）；否则按 cwd + kind 取最近一次。
   * 纯读取，无副作用；读失败/不存在都返回 null，由调用方决定回执文案。
   */
  async resolveSnapshot(
    options: ExpertWorkflowLookupOptions,
  ): Promise<ExpertWorkflowRunSnapshot | null> {
    if (options.runId) {
      return await this.store.readRun(options.runId, { signal: options.abortSignal });
    }
    return await this.store.readLatestRun(
      {
        cwd: options.cwd,
        kind: this.definition.kind,
      },
      { signal: options.abortSignal },
    );
  }

  /**
   * 取阶段定义；缺失即抛错。
   *
   * definition 与 phaseOrder 已由 schema 保证一致，走到这里仍缺失说明定义被
   * 手工构造/旧版本数据不兼容——属于装配错误，不能降级跳过（跳过会让后续阶段
   * 执行语义错位）。
   */
  getPhaseDefinition(phase: string): WorkflowPhaseDefinition {
    const definition = this.phaseDefinitions.get(phase);
    if (!definition) {
      throw new Error(`${this.definition.title} definition is missing phase: ${phase}`);
    }
    return definition;
  }

  /**
   * 统一时间戳：注入时钟的 ISO 表示。
   *
   * 所有写入（快照/事件/记录）都用它，保证同一个操作内时间可比较、可排序；
   * 不要直接 new Date()，否则测试无法固定时间、恢复时可能出现乱序。
   */
  timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * 为一次命令注册 run 级取消信号。
   *
   * 内部新建 controller 并登记到 activeRunAbortControllers（cancel 命令据此打断
   * 正在跑的 run）；外部 signal 通过一次性监听转发 abort（保留原始 Error reason）。
   * 返回 { signal, dispose }：signal 交给 continueRun 及其下游；dispose 必须放在
   * finally 里调用，否则监听泄漏且 Map 里留下已结束的 controller。
   *
   * 边界：同一 runId 重复注册会覆盖 Map 中的旧 controller（旧者仍能接收自己的
   * 外部信号，但 cancel 只会命中最新那个）；外部信号已 abort 时立即转发。
   */
  registerRunAbortSignal(
    runId: string,
    externalSignal: AbortSignal | undefined,
  ): { dispose: () => void; signal: AbortSignal } {
    const controller = new AbortController();
    // 转发时优先保留外部 signal 的 Error reason（例如 "Workflow cancelled"），
    // 否则下游只能得到一个无原因的 abort，错误归因会退化成 unknown。
    const forwardAbort = (): void => {
      controller.abort(
        externalSignal?.reason instanceof Error
          ? externalSignal.reason
          : new Error("Workflow aborted"),
      );
    };

    this.activeRunAbortControllers.set(runId, controller);
    if (externalSignal?.aborted) {
      forwardAbort();
    } else {
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    }

    return {
      dispose: () => {
        externalSignal?.removeEventListener("abort", forwardAbort);
        // 只删除仍属于自己的那条：若期间又注册了新 controller，不能把新的一起删掉。
        if (this.activeRunAbortControllers.get(runId) === controller) {
          this.activeRunAbortControllers.delete(runId);
        }
      },
      signal: controller.signal,
    };
  }
}

/**
 * 把 lifecycle 变换结果压成事件 payload。
 *
 * 只保留 id 列表（activityIds/nodeIds/phaseIds），不把整个快照塞进事件——事件账本
 * 是 append-only 的，体积与可读性都需要控制。nodeIds 保持 nodeChanges 原顺序、
 * 不去重，消费方需要唯一集合时自行归并。
 */
export function lifecyclePayload(
  result: WorkflowSnapshotLifecycleResult<ExpertWorkflowRunSnapshot>,
): Record<string, unknown> {
  return {
    activityIds: result.activityIds,
    nodeIds: result.nodeChanges.map((change) => change.nodeId),
    phaseIds: result.phaseIds,
  };
}

// 去掉 undefined 值，避免事件 payload 里出现显式 null 键（消费方按字段存在性判断）。
export function compactWorkflowPayload(
  value: Record<string, unknown | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Record<string, unknown>;
}

/**
 * 按 nodeId 去重图变更，保留"最后一次"变更。
 *
 * retry 里同一节点可能被 reconcile 与本函数重置两次，两次都改成 pending；
 * 取最后一条可保证图记录最终状态与快照一致（顺序来自 Map 插入顺序，即首次出现的
 * 位置，值是最新那次变更）。
 */
export function dedupeWorkflowNodeChanges(
  changes: WorkflowGraphNodeChange[],
): WorkflowGraphNodeChange[] {
  const byNodeId = new Map<string, WorkflowGraphNodeChange>();
  for (const change of changes) {
    byNodeId.set(change.nodeId, change);
  }
  return [...byNodeId.values()];
}
