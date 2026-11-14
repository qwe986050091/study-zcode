/**
 * ============================================================================
 * workflow/expert/runtime.ts —— expert workflow 的命令层门面
 * ============================================================================
 *
 * 【定位】对外只暴露"命令"而不是调度细节：start/startBackground/resume/status/
 * retry/cancel/list/events。每个方法自行解析 run、注册取消信号，并把结果统一
 * 包装成 ExpertWorkflowCommandResult（response + snapshot + status）。
 *
 * 【生命周期口径】
 *   - start/startBackground 都先落盘初始快照与图记录，再进入 continueRun；
 *     start 同步等待结束，startBackground 返回 running 快照后由后台继续。
 *   - resume 只推进非 terminal run；terminal 状态原样返回（幂等）。
 *   - retry 只接受 failed/paused；completed/cancelled 不可重试（会改写已定稿事实）。
 *   - cancel 对 terminal run 是 no-op；否则先落盘 cancelled 再 abort 正在跑的子会话。
 *
 * 【取消不变量】每个 run 用独立 AbortController，且 finally 里 dispose：
 * 不 dispose 会让 Map 泄漏，后续 cancel 可能命中已经结束的 controller。
 * ============================================================================
 */

import { cancelWorkflowSnapshot, reconcileWorkflowSnapshotForResume } from "../lifecycle.js";
import { formatExpertWorkflowStatus } from "./formatters.js";
import { isTerminalStatus } from "./ids.js";
import { ExpertWorkflowRuntimeContext, lifecyclePayload } from "./runtime-context.js";
import { prepareSnapshotForRetry } from "./retry-state.js";
import { continueRun } from "./run-loop.js";
import type {
  ExpertWorkflowCommandResult,
  ExpertWorkflowEventsOptions,
  ExpertWorkflowListOptions,
  ExpertWorkflowLookupOptions,
  ExpertWorkflowRetryOptions,
  ExpertWorkflowRunOptions,
  ExpertWorkflowRuntimeDeps,
} from "./types.js";
import type {
  SessionEvent,
  TraceContext,
  WorkflowEvent,
  WorkflowRunListItem,
} from "@zcode/contracts";

/**
 * 命令门面实现。
 *
 * 内部每个方法都 new 一次 ExpertWorkflowRuntimeContext（不跨命令共享），只复用
 * deps 里的 agentRunner/store/definition 等不可变依赖。这样状态全部来自 store，
 * 进程重启后行为一致。
 */
export class ExpertWorkflowRuntime {
  private readonly ctx: ExpertWorkflowRuntimeContext;

  // 构造即校验定义（schema parse）；非法定义在装配期失败，不会拖到首个阶段。
  constructor(deps: ExpertWorkflowRuntimeDeps) {
    this.ctx = new ExpertWorkflowRuntimeContext(deps);
  }

  /**
   * 同步启动一个新 run，直到完成/暂停/取消才返回。
   *
   * 步骤：初始快照 → 落盘 → 写初始图记录 → 发 run_started → continueRun。
   * 返回结果携带最终快照与格式化文案；失败不会 throw（continueRun 已归并为
   * paused/cancelled），因此调用方需要看 status 判断结局。
   * 副作用：大量落盘与事件；abortSignal 贯穿全程。finally 必须 dispose。
   */
  async start(options: ExpertWorkflowRunOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = this.ctx.createInitialSnapshot(options);
    await this.ctx.store.writeSnapshot(snapshot, { signal: options.abortSignal });
    await this.ctx.writeInitialGraph(snapshot, options.abortSignal);
    await this.ctx.appendEvent(snapshot.runId, "run_started", {
      message: `${this.ctx.definition.title} started.`,
      signal: options.abortSignal,
    });

    const runAbort = this.ctx.registerRunAbortSignal(snapshot.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, snapshot, {
        ...options,
        abortSignal: runAbort.signal,
      });
    } finally {
      runAbort.dispose();
    }
  }

  /**
   * 后台启动：立即返回 running 快照，run 在后台继续推进。
   *
   * 关键：返回前必须把 status=running 落盘。否则调用方立刻 status 会读到 pending，
   * 误以为 run 尚未开始，甚至可能再次 start。
   * 失败语义：后台异常不会被调用方感知——已 abort 时静默（取消由 cancel() 撞库），
   * 其他错误补发 run_failed 事件（不再写快照，快照由 continueRun 的 catch 处理）。
   */
  async startBackground(options: ExpertWorkflowRunOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = this.ctx.createInitialSnapshot(options);
    await this.ctx.store.writeSnapshot(snapshot, { signal: options.abortSignal });
    await this.ctx.writeInitialGraph(snapshot, options.abortSignal);
    await this.ctx.appendEvent(snapshot.runId, "run_started", {
      message: `${this.ctx.definition.title} started.`,
      signal: options.abortSignal,
    });

    const running = this.ctx.updateSnapshot(snapshot, {
      startedAt: snapshot.startedAt ?? this.ctx.timestamp(),
      status: "running",
    });
    await this.ctx.store.writeSnapshot(running, { signal: options.abortSignal });

    const runAbort = this.ctx.registerRunAbortSignal(snapshot.runId, options.abortSignal);
    void continueRun(this.ctx, running, {
      ...options,
      abortSignal: runAbort.signal,
    })
      .catch(async (error) => {
        if (runAbort.signal.aborted) return;
        await this.ctx.appendEvent(snapshot.runId, "run_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        runAbort.dispose();
      });

    return {
      response: formatExpertWorkflowStatus(running),
      runId: running.runId,
      snapshot: running,
      status: running.status,
      traceId: running.traceId,
    };
  }

  /**
   * 恢复一个未完成 run。
   *
   * terminal（completed/failed/cancelled）直接返回现状，一个字节都不写；否则：
   * reconcile 修复旧进程遗留的 active → 置 running → 落盘 → 追加修复图记录 →
   * changed 时才发 graph_updated（无修复则不发，避免事件噪声）→ continueRun。
   * 返回最终命令结果；异常由 continueRun 收敛为 paused，不会向上抛。
   */
  async resume(
    options: ExpertWorkflowLookupOptions & {
      onEvent?: (event: SessionEvent) => void | Promise<void>;
      traceContext?: TraceContext;
    },
  ): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (isTerminalStatus(snapshot.status)) {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }

    const resumeRepair = reconcileWorkflowSnapshotForResume(snapshot, {
      timestamp: this.ctx.timestamp(),
    });
    const resumed = {
      ...resumeRepair.snapshot,
      status: "running" as const,
      updatedAt: this.ctx.timestamp(),
    };
    await this.ctx.store.writeSnapshot(resumed, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      resumed,
      resumeRepair.nodeChanges,
      options.abortSignal,
    );
    if (resumeRepair.changed) {
      await this.ctx.appendEvent(resumed.runId, "graph_updated", {
        message: "Workflow resume repaired stale active work.",
        payload: lifecyclePayload(resumeRepair),
        signal: options.abortSignal,
      });
    }

    const runAbort = this.ctx.registerRunAbortSignal(resumed.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, resumed, {
        abortSignal: runAbort.signal,
        cwd: resumed.cwd,
        onEvent: options.onEvent,
        sessionId: resumed.sessionId,
        task: resumed.task,
        traceContext: options.traceContext,
      });
    } finally {
      runAbort.dispose();
    }
  }

  /**
   * 只读查询 run 状态。
   *
   * 找不到时返回 { response: "No expert workflow found." }（无 runId/snapshot）；
   * 命中时 response 是 formatExpertWorkflowStatus 的多行视图。
   * 不注册取消信号、不写任何东西；abortSignal 只作用于 store 读取。
   */
  async status(options: ExpertWorkflowLookupOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    return {
      reportPath: snapshot.reportPath,
      response: formatExpertWorkflowStatus(snapshot),
      runId: snapshot.runId,
      snapshot,
      status: snapshot.status,
      traceId: snapshot.traceId,
    };
  }

  /**
   * 从指定范围重试失败/暂停的 run。
   *
   * 允许的状态只有 failed/paused：completed 已定稿、cancelled 是用户主动终止，
   * 两者都直接返回现状（不 mutate）。
   * 流程：prepareSnapshotForRetry（重置范围节点/阶段、清 failure）→ 落盘 →
   * 写修复/重置图记录 → 发 workflow_retry_started（payload 带 resetNodeIds）→
   * continueRun。
   * 副作用：写快照/图记录/事件；子会话由 continueRun 重新拉起。
   */
  async retry(options: ExpertWorkflowRetryOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (snapshot.status === "completed" || snapshot.status === "cancelled") {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }

    const prepared = prepareSnapshotForRetry(this.ctx, snapshot, options);
    await this.ctx.store.writeSnapshot(prepared.snapshot, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      prepared.snapshot,
      prepared.nodeChanges,
      options.abortSignal,
    );
    await this.ctx.appendEvent(prepared.snapshot.runId, "workflow_retry_started", {
      message: `${this.ctx.definition.title} retry started.`,
      payload: {
        activityId: options.activityId,
        nodeId: options.nodeId,
        phase: options.phase ?? prepared.snapshot.currentPhase,
        resetNodeIds: prepared.nodeChanges.map((change) => change.nodeId),
      },
      phase: options.phase ?? prepared.snapshot.currentPhase,
      signal: options.abortSignal,
    });

    const runAbort = this.ctx.registerRunAbortSignal(prepared.snapshot.runId, options.abortSignal);
    try {
      return await continueRun(this.ctx, prepared.snapshot, {
        abortSignal: runAbort.signal,
        cwd: prepared.snapshot.cwd,
        onEvent: options.onEvent,
        sessionId: prepared.snapshot.sessionId,
        task: prepared.snapshot.task,
        traceContext: options.traceContext,
      });
    } finally {
      runAbort.dispose();
    }
  }

  /**
   * 取消一个 run。
   *
   * terminal → 原样返回（不重复写 cancelled）；否则 cancelWorkflowSnapshot 生成
   * 取消后的快照（activity/node/phase 一并收敛）→ 落盘 → 追加图记录 → 发
   * run_cancelled → 最后 abort 内部 controller：顺序很关键，先落盘再 abort，
   * 保证子会话被中断时 run 已经是 cancelled 事实，不会被 continueRun 再写成 paused。
   */
  async cancel(options: ExpertWorkflowLookupOptions): Promise<ExpertWorkflowCommandResult> {
    const snapshot = await this.ctx.resolveSnapshot(options);
    if (!snapshot) {
      return {
        response: "No expert workflow found.",
      };
    }
    if (isTerminalStatus(snapshot.status)) {
      return {
        response: formatExpertWorkflowStatus(snapshot),
        runId: snapshot.runId,
        snapshot,
        status: snapshot.status,
        traceId: snapshot.traceId,
      };
    }
    const cancelRepair = cancelWorkflowSnapshot(snapshot, {
      timestamp: this.ctx.timestamp(),
    });
    const cancelled = cancelRepair.snapshot;
    await this.ctx.store.writeSnapshot(cancelled, { signal: options.abortSignal });
    await this.ctx.appendLifecycleGraphChanges(
      cancelled,
      cancelRepair.nodeChanges,
      options.abortSignal,
    );
    await this.ctx.appendEvent(cancelled.runId, "run_cancelled", {
      message: `${this.ctx.definition.title} cancelled.`,
      payload: lifecyclePayload(cancelRepair),
      signal: options.abortSignal,
    });
    this.ctx.activeRunAbortControllers.get(snapshot.runId)?.abort(new Error("Workflow cancelled"));
    return {
      response: formatExpertWorkflowStatus(cancelled),
      runId: cancelled.runId,
      snapshot: cancelled,
      status: cancelled.status,
      traceId: cancelled.traceId,
    };
  }

  /**
   * 列出该 cwd 下的历史 run（按 store 的排序，通常新→旧）。
   *
   * kind 强制取 definition.kind（调用方不能跨 kind 混查）；limit 透传 store，
   * 语义由 store 决定。纯读，无副作用。
   */
  async list(options: ExpertWorkflowListOptions): Promise<WorkflowRunListItem[]> {
    return await this.ctx.store.listRuns(
      {
        cwd: options.cwd,
        kind: this.ctx.definition.kind,
        limit: options.limit,
      },
      { signal: options.abortSignal },
    );
  }

  /**
   * 读取 run 的事件账本（按写入顺序返回）。
   *
   * limit 缺省返回全量；给出时取最后 N 条（slice 负索引）。边界注意：limit=0
   * 或负数经 Math.max(0, limit) → 0，slice(-0) 等价于 slice(0)，结果是"全量"而
   * 不是空数组——调用方若想"不返回"必须自己短路。
   * 纯读，无副作用。
   */
  async events(options: ExpertWorkflowEventsOptions): Promise<WorkflowEvent[]> {
    const events = await this.ctx.store.readEvents(options.runId, {
      signal: options.abortSignal,
    });
    return options.limit === undefined ? events : events.slice(-Math.max(0, options.limit));
  }
}

// 历史命名兼容：旧调用方使用 WorkflowRuntime，与 ExpertWorkflowRuntime 是同一个类。
export { ExpertWorkflowRuntime as WorkflowRuntime };
