import type {
  WorkflowEvent,
  WorkflowGraphCollection,
  WorkflowNodeStatus,
  WorkflowRunSnapshot,
} from "@zcode/contracts";
import { edgeId } from "./graph.js";
import type { AppliedPlannerExpansion, WorkflowGraphSchedulerDeps } from "./types.js";

/**
 * ============================================================================
 * workflow/scheduler/events.ts —— 调度器事件与图记录的统一出口
 * ============================================================================
 *
 * 【定位】把调度过程中的状态变化写成两类事实：
 *   - appendEvent：面向 UI/订阅者的 WorkflowEvent（节点开始/完成、集合耗尽等）；
 *   - appendGraphRecord：面向恢复重放的图记录（node/edge/collection/op）。
 *
 * 【顺序不变量】所有 emitEvent 都先 appendEvent 持久化，再回调 onWorkflowEvent；
 * 订阅者看到的必然是已落库事实，恢复时不会出现"事件有、记录无"。
 * 本类只读快照字段（runId/kind），不修改快照。
 * ============================================================================
 */

/**
 * 调度器事件日志门面。构造时注入持久化函数、时钟与可选订阅回调。
 * 时间戳统一由 timestamp() 产生（now().toISOString()），保证事件与记录同源。
 */
export class WorkflowSchedulerEventLog {
  private readonly appendEvent: WorkflowGraphSchedulerDeps["appendEvent"];
  private readonly appendGraphRecord: WorkflowGraphSchedulerDeps["appendGraphRecord"];
  private readonly now: () => Date;
  private readonly onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;

  constructor(deps: WorkflowGraphSchedulerDeps) {
    this.appendEvent = deps.appendEvent;
    this.appendGraphRecord = deps.appendGraphRecord;
    this.now = deps.now;
    this.onWorkflowEvent = deps.onWorkflowEvent;
  }

  /**
   * 返回当前注入时钟的 ISO 字符串。
   * 调度器内所有快照/记录的 timestamp 都取自这里，避免同一动作出现多个时间口径。
   */
  timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * 追加一条节点状态变更的图记录（recordType="op"、type="update_status"）。
   * 用于恢复重放时还原节点状态；不写快照，快照由调用方另行 writeSnapshot。
   * signal 透传，取消时由底层 I/O 抛错。
   */
  async appendGraphStatus(
    snapshot: WorkflowRunSnapshot,
    nodeId: string,
    phase: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphRecord(
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
   * 追加集合的完整快照记录（recordType="collection"）。
   * 记录里带整个 collection 对象而不是增量，重放时可直接覆盖集合状态。
   */
  async appendCollectionRecord(
    snapshot: WorkflowRunSnapshot,
    collection: WorkflowGraphCollection,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphRecord(
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

  /**
   * 批量追加一轮 planner 扩张产生的全部图记录。
   * 顺序固定：先每个新增节点、再每条新增边、再集合快照，最后一条 op
   * graph_expanded（含 nodeIds/edgeIds 与 exhausted/plannerRuns/status）。
   * 顺序即恢复重放顺序：先有节点才能解析引用它们的边。
   * 一路 await 串行写入，任一步失败即中断，不产生"半轮"记录。
   */
  async appendExpansionRecords(
    snapshot: WorkflowRunSnapshot,
    expansion: AppliedPlannerExpansion,
    phase: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const node of expansion.addedNodes) {
      await this.appendGraphRecord(
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
    for (const edge of expansion.addedEdges) {
      await this.appendGraphRecord(
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
    await this.appendCollectionRecord(snapshot, expansion.collection, signal);
    await this.appendGraphRecord(
      snapshot.runId,
      {
        collectionId: expansion.collection.collectionId,
        edgeIds: expansion.addedEdges.map(edgeId),
        nodeIds: expansion.addedNodes.map((node) => node.id),
        payload: {
          exhausted: expansion.collection.exhausted,
          plannerRuns: expansion.collection.plannerRuns,
          status: expansion.collection.status,
        },
        phase,
        recordType: "op",
        runId: snapshot.runId,
        timestamp: this.timestamp(),
        type: "graph_expanded",
      },
      { signal },
    );
  }

  /**
   * 构造并持久化一条 WorkflowEvent，然后通知订阅回调。
   * kind/runId 取自快照，timestamp 取自注入时钟，message/nodeId/payload/phase
   * 由调用方按事件类型提供。
   * 失败语义：appendEvent 抛错则本方法抛错且不触发回调；回调抛错同样向上传播。
   * 消费方：UI 进度展示、恢复与外部观察者（onWorkflowEvent）。
   */
  async emitEvent(
    snapshot: WorkflowRunSnapshot,
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
      kind: snapshot.kind,
      message: options.message,
      nodeId: options.nodeId,
      payload: options.payload,
      phase: options.phase,
      runId: snapshot.runId,
      timestamp: this.timestamp(),
      type,
    };
    await this.appendEvent(event, { signal: options.signal });
    await this.onWorkflowEvent?.(event);
  }
}
