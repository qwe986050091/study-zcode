/**
 * ============================================================================
 * runtime-task/registry.ts —— 内存中的"运行时任务"注册表
 * ============================================================================
 *
 * 【定位】统一登记所有脱离当前前台 turn 的活动：后台 Bash、子代理、legacy
 * Workflow、动态工作流、MCP Monitor。它不是持久化存储（重启不恢复闲时后台任务），
 * 而是"当前进程里还活着什么"的唯一权威。
 *
 * 【关键字段】
 *   - branchGeneration：任务出生时的对话分支。rewind/fork 后旧分支的完成事件
 *     靠它做 fencing（迟到 completion 必须被丢弃）；
 *   - isBackgrounded：任务是否已转后台。前台被 await 的任务不会阻止 session
 *     回收，只有转后台且 running 的才算"常驻池仍需保留"；
 *   - offPeakExecutionId：off-peak 执行归属，仅内存；
 *   - resultText：动态工作流产物的唯一载体（dwf 不写 outputFile）。
 *
 * 【两类 waiter】
 *   - waitForBackgroundRequest：等"转后台"或"已终结/被移除"；
 *   - waitForTerminal：等终态。
 *   都支持 AbortSignal，取消时必须从 waiter 集合里摘除，避免泄漏。
 *
 * 【任务类型刻意拆分】local_workflow（legacy Workflow，不可取消）与
 * local_dynamic_workflow（workflow run，可 cancel）必须区分，
 * 否则停止分派无法知道该走哪条路。
 * ============================================================================
 */

import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** 内存执行归属；重启不会恢复闲时后台任务。 */
  offPeakExecutionId?: string;
  offPeakCancelled?: boolean;
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export interface RuntimeTaskRegistry {
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

// 终态集合：进入这些状态后不再接受 update 语义上的"复活"，
// 所有 terminal waiter 立即结算。killed/stopped 与 cancelled 并列，
// 因为底层进程终止方式不同但对外都是"不会再跑了"。
const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private offPeakExecutionId: string | undefined;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setOffPeakExecutionId(executionId: string | undefined): void {
    this.offPeakExecutionId = executionId;
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  /**
   * 注册任务。写入时打两个"出生戳"：
   *   - offPeakExecutionId：任务自带优先，否则继承注册表当前 off-peak 执行；
   *   - branchGeneration：任务未显式指定时取当前活跃分支。
   * 打戳发生在 register 而不是 update：分支归属必须在出生时定格，
   * 之后用户 fork 也不应改变这个任务的归属。
   *
   * 注册后立刻检查终态/后台态：有些任务注册时就已经是终态（例如同步失败），
   * 必须马上结算 waiter，否则调用方会永久等待。
   */
  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      ...((task.offPeakExecutionId ?? this.offPeakExecutionId)
        ? { offPeakExecutionId: task.offPeakExecutionId ?? this.offPeakExecutionId }
        : {}),
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    this.changed();
  }

  // 只影响"之后注册的任务"；已注册任务保留出生时的分支，fencing 才有意义。
  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  /**
   * 原子读改写。patcher 是纯函数式更新，调用方必须返回新对象而不是就地改 current
   * （订阅者与 waiter 可能持有旧快照引用）。
   * 未知 id 返回 undefined（更新不是创建）；每次更新后都重新评估终态/后台 waiter。
   */
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    this.changed();
    return next;
  }

  /**
   * 请求"转后台"。
   *
   * 返回 false 的两种情况都不改变状态：任务不存在，或任务已终结
   * （已结束的任务没有"后台"概念）。成功后只改 isBackgrounded 并结算
   * background waiter——终态 waiter 不受影响（任务仍在跑）。
   */
  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    this.changed();
    return true;
  }

  /**
   * 移除任务并结算所有 waiter（传 undefined）。
   *
   * undefined 是一个明确语义："任务已不存在"，而不是"还在跑"。调用方据此
   * 区分"等到终态"与"等丢了"，后者通常会转成 lost 处理。
   */
  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
    this.changed();
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  // 发给运行中任务的消息（coordinator 回复等）先挂在 pendingMessages，
  // 由任务在下一个安全点 drainMessages 取走；未知 id 不创建半截任务。
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    this.changed();
    return messages;
  }

  /**
   * 等任务"转后台"。
   *
   * 四种即时返回：
   *   - 不存在 → undefined（调用方按丢失处理）；
   *   - 已后台 → 当前快照；
   *   - 已终结 → undefined（永远不会再转后台）；
   *   - 其它 → 挂起，直到 requestBackground / 终态 / remove。
   */
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  /**
   * 等终态。
   *
   * 不存在/已终结立即返回当前快照（undefined 与终态快照都要能区分）；
   * 否则挂起，直到 update 进入终态或 remove（resolve undefined）。
   */
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  /**
   * waiter 挂起实现。
   *
   * AbortSignal 必须双向清理：abort 时从集合摘除；正常 resolve 时移除监听。
   * 只做前者会留下已 resolve 的监听器，长会话里会累积泄漏。
   * signal.reason 优先，缺失时退化为通用 Error（旧运行时可能没有 reason）。
   */
  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

// 终态判定只依赖 status，被多处复用（停止分派、回收判定、waitFor）；
// 不要在不同调用点各自维护状态字符串列表。
export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

/**
 * session 常驻池的回收判定：只要还有"已后台且 running"的任务，就不能回收 runtime。
 *
 * 注意条件是两个：isBackgrounded 与 status。前台任务由 abortController 约束，
 * 不在本判定范围内；终态任务即使 isBackgrounded 也不再阻止回收。
 */
export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
