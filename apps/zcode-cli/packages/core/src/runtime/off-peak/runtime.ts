/**
 * ============================================================================
 * runtime/off-peak/runtime.ts —— 闲时执行在 runtime 上的挂载与闸门
 * ============================================================================
 *
 * 【定位】把一个 off-peak execution（executionId/offPeakTaskId + 模型选择 + 票据）挂到
 *   AgentRuntime 实例上，并决定"本轮 turn 到底用普通模型还是闲时模型"。
 *
 * 【三层事实】
 *   - 内存态：controllers（执行控制器）、sinks（事件出口）、temporarySelections（临时选择），
 *     全部用 WeakMap 以 runtime 为 key，随 runtime 回收，不跨实例串扰；
 *   - durable：本文件只发 lifecycle 事件，落库由 sink/调用方决定；
 *   - 投影：pendingInputs 通过 rebuildProjection 异步重读，失败时**不猜测**（保持 true）。
 *
 * 【不变量】
 *   1) 一个 runtime 同时只能有一个活跃（非终态）off-peak execution；换 executionId 必须等旧终态；
 *   2) 终态控制器只保留用于幂等回执，不能继续改写会话持久化的模型选择；
 *   3) 只有"本 execution 拥有的 turn"才注入闲时 modelExecution；其它 turn 用 ordinarySelection。
 * ============================================================================
 */
import type { ModelRequestAuth, ModelSelection, SessionEventSink } from "@zcode/contracts";
import type { OffPeakControlParams, OffPeakControlResult } from "@zcode/shared";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions, ModelExecutionContext } from "../types.js";
import { OffPeakLifecycle, type OffPeakLifecycleEvent, type OffPeakOutcome } from "./lifecycle.js";
import { OffPeakTicketAuthority, type OffPeakModelBinding } from "./model-binding.js";

/**
 * 以 runtime 为 key 的三张 WeakMap（避免全局单例 / 不跨实例泄漏）：
 *   - controllers：当前执行控制器；一个 runtime 至多一个活跃执行；
 *   - sinks：lifecycle 事件出口（由宿主注入，通常转发到通知/事件表）；
 *   - temporarySelections：临时模型选择覆盖；存在 key 即表示"有临时选择生效"，
 *     值可能为 undefined（明确表示"临时没有选择"），因此这里用 has 而非 get 判定。
 */
const controllers = new WeakMap<AgentRuntimeInternal, OffPeakRuntimeExecution>();
const sinks = new WeakMap<AgentRuntimeInternal, (event: OffPeakLifecycleEvent) => void>();
const temporarySelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

/**
 * 注册（或清除）lifecycle 事件出口。
 *
 * 输入：runtime + 可选 sink。输出：无。
 * 传 undefined 是 no-op 而非清除 —— 保持既有 sink，避免调用方漏传参数意外静默事件。
 */
export function configureOffPeakRuntime(
  runtime: AgentRuntimeInternal,
  sink?: (event: OffPeakLifecycleEvent) => void,
): void {
  if (sink) sinks.set(runtime, sink);
}
/**
 * 取当前挂在该 runtime 上的执行控制器（可能 undefined）。
 *
 * 调用方用它判断"是否有 off-peak 执行""是否已终态/被接管"；不负责创建。
 */
export function getOffPeakExecution(
  runtime: AgentRuntimeInternal,
): OffPeakRuntimeExecution | undefined {
  return controllers.get(runtime);
}
/**
 * 记录"临时模型选择"（用于后续持久化时覆盖实际选择）。
 *
 * 输入：runtime + 普通选择或 undefined。输出：无。
 * 行为：总是写入 key（深拷贝），即使值为 undefined —— selectionForPersistence 用 has 判断，
 *   "显式写入 undefined"表示临时状态就是"无选择"，与"没有临时覆盖"是两回事。
 */
export function markTemporaryRuntimeSelection(
  runtime: AgentRuntimeInternal,
  ordinary: ModelSelection | undefined,
): void {
  temporarySelections.set(runtime, ordinary && structuredClone(ordinary));
}
/**
 * 计算"该持久化哪个模型选择"。
 *
 * 优先级：
 *   1) 存在临时选择 key → 直接返回它（哪怕是 undefined）；
 *   2) 有控制器且**非终态、未接管** → 返回执行的 ordinarySelection（闲时期间用户看到的仍是普通选择）；
 *   3) 否则返回传入的 selection。
 * 原因：终态控制器只用于幂等回执，若继续覆盖，会把用户随后新选的模型改回旧值。
 * 副作用：无。
 */
export function selectionForPersistence(
  runtime: AgentRuntimeInternal,
  selection?: ModelSelection,
): ModelSelection | undefined {
  if (temporarySelections.has(runtime)) return temporarySelections.get(runtime);
  const execution = controllers.get(runtime);
  // 终态控制器只保留幂等回执，不能继续覆盖随后普通用户选择的持久化。
  return execution && !execution.lifecycle.terminal && !execution.lifecycle.ownedByUser
    ? execution.ordinarySelection
    : selection;
}
/**
 * 接受用户接管请求：把当前执行标记为 userOwned（让出闲时执行权）。
 *
 * 幂等：无控制器或已终态/已接管时 lifecycle.takeOver 自身是 no-op。
 * 副作用：由 lifecycle 发出 user_takeover、拒绝等票者并重算状态。
 */
export function acceptOffPeakUserTakeover(runtime: AgentRuntimeInternal): void {
  controllers.get(runtime)?.lifecycle.takeOver();
}
/**
 * 外部工作事实变化时触发一次状态重算（如命令队列/登记表变动）。
 *
 * 无控制器时 no-op；真正重读队列由控制器内部的 refreshWork 异步完成。
 */
export function refreshOffPeakWork(runtime: AgentRuntimeInternal): void {
  controllers.get(runtime)?.refreshWork();
}
/**
 * 处理 Host 下发的控制消息（换票 / 取消）。
 *
 * 输入：runtime + OffPeakControlParams。
 * 输出：{ accepted } —— 只表示"该消息是否被本 runtime 受理"，不代表操作一定产生效果。
 * 拒绝口径：sessionId 不匹配 / 无控制器 / executionId 不匹配 → accepted=false。
 * 副作用：cancel 会停掉前台执行与后台任务（见 controller.cancel）；
 *   replace_ticket 会替换凭据并恢复等票者。
 */
export async function controlOffPeakRuntime(
  runtime: AgentRuntimeInternal,
  input: OffPeakControlParams,
): Promise<OffPeakControlResult> {
  const execution = controllers.get(runtime);
  if (
    input.sessionId !== runtime.sessionId ||
    !execution ||
    execution.executionId !== input.executionId
  )
    return { accepted: false };
  if (input.action === "cancel") {
    await execution.cancel();
    return { accepted: true };
  }
  return {
    accepted: execution.replaceTicket(
      input.executionId,
      input.renewalId,
      input.ticketId,
      input.requestAuth,
    ),
  };
}

/**
 * 普通执行入口的衔接点：决定本次 turn 是否使用闲时执行，并返回释放回调。
 *
 * 输入：runtime + 原始 ExecuteTurnOptions。
 * 输出：{ options, release(outcome) }。options 可能是原样返回（不接管）。
 * 三种路径：
 *   1) 首次出现 offPeak（original.modelExecution.offPeak）：若已有非终态且 executionId 不同
 *      → 抛 off_peak_execution_already_active；否则新建控制器并 setSessionModelSelection；
 *   2) 已有控制器且本 turn 属于它（有 offPeak 或 offPeakExecutionId 匹配）且未接管 →
 *      创建 binding，注入 executionSelection / requestDependencies / 子代理策略；
 *   3) 不属于本执行 → 原样返回（但若原执行仍活跃且非接管且本 turn 无 intent，
 *      仍把 executionSelection 设为 ordinarySelection，保持会话选择一致）。
 * release：mainEnded(outcome) → 释放 binding → refreshWork，三者顺序保证结果先落再判完成。
 * 副作用：可能创建控制器、注册 WeakMap、改 runtime 的会话模型选择；release 会触发状态重算。
 */
/** 仅在普通执行入口衔接上下文，模型循环、通知和工具仍由原来的执行器调度。 */
export function prepareOffPeakTurn(
  runtime: AgentRuntimeInternal,
  original?: ExecuteTurnOptions,
): {
  options: ExecuteTurnOptions | undefined;
  release(outcome: OffPeakOutcome): void;
} {
  let execution = controllers.get(runtime);
  const initial = original?.modelExecution?.offPeak;
  if (initial) {
    if (execution && !execution.lifecycle.terminal && execution.executionId !== initial.executionId)
      throw new Error("off_peak_execution_already_active");
    if (!execution || execution.lifecycle.terminal) {
      const selection = original?.intent?.modelSelection;
      if (!selection || !original?.offPeakTaskId)
        throw new Error("off_peak_execution_identity_missing");
      execution = new OffPeakRuntimeExecution(
        runtime,
        original.offPeakTaskId,
        selection,
        original.modelExecution!,
      );
      controllers.set(runtime, execution);
      runtime.setSessionModelSelection(selection);
    }
  }
  const ownsTurn =
    execution &&
    !execution.lifecycle.terminal &&
    (initial || original?.offPeakExecutionId === execution.executionId);
  if (!execution || !ownsTurn || execution.lifecycle.ownedByUser) {
    // 同会话原先存在的后台工作不属于本项闲时任务，仍使用原普通选择。
    return {
      options:
        execution &&
        !execution.lifecycle.terminal &&
        !execution.lifecycle.ownedByUser &&
        !original?.intent
          ? { ...original, executionSelection: execution.ordinarySelection }
          : original,
      release() {},
    };
  }
  const binding = execution.authority.createBinding();
  const activeExecution = execution;
  const options: ExecuteTurnOptions = {
    ...original,
    automationId: undefined,
    offPeakExecutionId: execution.executionId,
    offPeakTaskId: execution.offPeakTaskId,
    executionSelection: execution.selection,
    modelExecution: {
      selectionScope: "execution",
      memoryExtraction: "skip",
      requestDependencies: binding.requestDependencies,
      subagents: { foregroundModel: "submission", background: "allow" },
    },
  };
  return {
    options,
    release(outcome) {
      activeExecution.lifecycle.mainEnded(outcome);
      binding.release();
      activeExecution.refreshWork();
    },
  };
}

/**
 * 一次 off-peak 执行在 runtime 上的控制器。
 *
 * 字段口径：
 *   - lifecycle：状态机（归属/票据/终态）；
 *   - authority：票据权威（凭据替换与模型绑定）；
 *   - ordinarySelection：进入闲时时用户原本的普通模型选择，持久化与让位时回退用它；
 *   - executionId：本次执行身份，Host 控制消息与任务归属都按它匹配；
 *   - pendingInputs：是否还有待处理输入；初值 true —— 尚未读取权威队列前一律视为"有工作"，
 *     避免状态机在读队列完成前误判完成；
 *   - reading：是否正在异步重读队列，防止并发重读；
 *   - revision：重读版本号，用于"读完发现又变了"时循环重读；
 *   - unsubscribeRegistry：registry 订阅的取消函数；
 *   - eventSink：事件投影旁路，只订阅会改变完成条件的 turn_/subagent_ 事件。
 */
export class OffPeakRuntimeExecution {
  readonly lifecycle: OffPeakLifecycle;
  readonly authority: OffPeakTicketAuthority;
  readonly ordinarySelection: ModelSelection | undefined;
  readonly executionId: string;
  private pendingInputs = true;
  private reading = false;
  private revision = 0;
  private unsubscribeRegistry?: () => void;
  private readonly eventSink: SessionEventSink;

/**
 * 构造控制器：接好状态机的工作事实读取、事件出口、票据权威与订阅。
 *
 * 输入：runtime、offPeakTaskId、selection（闲时选择）、execution（含 offPeak 身份与依赖）。
 * readWork 口径：
 *   - mainRunning 用 runtime.hasActiveOrQueuedTurnWork（含排队 turn）；
 *   - 后台/通知只统计 offPeakExecutionId === 本执行的 registry 任务；
 *   - pendingNotifications 认"已后台且未 notify"或"还有待投递消息"；
 *   - pendingInputs = 本地标记 || reading || runtime 的输入预留数 > 0。
 * emit：先转发给宿主 sink，再在 completed 时 dispose（清理订阅/恢复选择）。
 * 副作用：写 registry 的 offPeakExecutionId、订阅 registry 与事件 sink、创建状态机与权威。
 */
  constructor(
    private readonly runtime: AgentRuntimeInternal,
    readonly offPeakTaskId: string,
    readonly selection: ModelSelection,
    execution: ModelExecutionContext,
  ) {
    const initial = execution.offPeak!;
    this.executionId = initial.executionId;
    this.ordinarySelection = runtime.getSessionModelSelection();
    this.lifecycle = new OffPeakLifecycle({
      ...initial,
      offPeakTaskId,
      readWork: () => {
        const tasks = Object.values(runtime.runtimeTaskRegistry.all()).filter(
          (task) => task.offPeakExecutionId === this.executionId,
        );
        return {
          mainRunning: runtime.hasActiveOrQueuedTurnWork(),
          backgroundRunning: tasks.some((task) => !isTerminalRuntimeTask(task)),
          pendingNotifications: tasks.some(
            (task) =>
              (task.isBackgrounded && task.notified !== true) ||
              (task.pendingMessages?.length ?? 0) > 0,
          ),
          pendingInputs:
            this.pendingInputs || this.reading || runtime.pendingInputReservations.size > 0,
        };
      },
      emit: (event) => {
        sinks.get(runtime)?.(event);
        if (event.type === "completed") this.dispose();
      },
    });
    this.authority = new OffPeakTicketAuthority(this.lifecycle, {
      ...initial,
      providerId: selection.providerId,
      requestAuthSource: execution.requestDependencies?.requestAuth?.source,
    });
    runtime.runtimeTaskRegistry.setOffPeakExecutionId?.(this.executionId);
    this.unsubscribeRegistry = runtime.runtimeTaskRegistry.subscribe?.(() => this.refreshWork());
    this.eventSink = {
      onSessionEvent: (event) => {
        // 队列事实留在原投影；这里只订阅改变完成条件的事件，不复制 accepted input queue。
        if (event.type.startsWith("turn_") || event.type.startsWith("subagent_"))
          this.refreshWork();
      },
    };
    runtime.eventSinks.add(this.eventSink);
  }

/**
 * 为子执行/子轮派发创建绑定。
 *
 * 输出：OffPeakModelBinding 或 undefined。
 * 拒绝条件：已终态或已用户接管 —— 子轮不得在用户接管后继续占用闲时票据。
 * 副作用：与 authority.createBinding 相同（占用一个模型轮次）。
 */
  createChildBinding(): OffPeakModelBinding | undefined {
    return this.lifecycle.ownedByUser || this.lifecycle.terminal
      ? undefined
      : this.authority.createBinding();
  }
/**
 * 换票入口（控制消息用）：先校验 executionId，再交给 authority。
 *
 * 输出：true = 安装成功；false = executionId 不匹配或 authority 拒绝。
 * 副作用：替换凭据、恢复等票者（见 authority.replaceTicket）。
 */
  replaceTicket(
    executionId: string,
    renewalId: number,
    ticketId: string,
    auth: ModelRequestAuth,
  ): boolean {
    return (
      executionId === this.executionId && this.authority.replaceTicket(renewalId, ticketId, auth)
    );
  }
/**
 * 取消本次执行（异步，需等待后台任务停止）。
 *
 * 输出：Promise<void>；终态时直接返回（旧 cancel 不能停掉同会话后来启动的用户轮）。
 * 步骤：标记本执行的所有 registry 任务 offPeakCancelled → 移除属于本执行的
 *   任务通知/子代理消息命令 → lifecycle.cancel()（进入终态并拒绝等票者）→
 *   按捕获的前台执行 id 精确停止前台执行 → 并行 stopBackgroundTask 停止仍非终态的后台任务。
 * 关键细节：前台执行 id 必须在 lifecycle.cancel 之前捕获，否则终态后可能已切换/清空。
 * 副作用：改 registry/命令队列、停前台与后台任务、发 completed(stopped)。
 */
  async cancel(): Promise<void> {
    // 终态控制器保留用于重复确认；旧 cancel 不能停止同会话后来启动的用户轮。
    if (this.lifecycle.terminal) return;
    const foregroundExecutionId = this.runtime.getActiveForegroundExecutionId();
    for (const task of Object.values(this.runtime.runtimeTaskRegistry.all())) {
      if (task.offPeakExecutionId === this.executionId)
        this.runtime.runtimeTaskRegistry.update(task.taskId, (current) => ({
          ...current,
          offPeakCancelled: true,
        }));
    }
    for (const command of this.runtime.runtimeCommandQueue.snapshot()) {
      if (
        command.offPeakExecutionId === this.executionId &&
        (command.mode === "task-notification" || command.mode === "subagent-message")
      )
        this.runtime.runtimeCommandQueue.removeById(command.id);
    }
    this.lifecycle.cancel();
    if (foregroundExecutionId)
      this.runtime.stopActiveForegroundExecution({
        expectedForegroundExecutionId: foregroundExecutionId,
      });
    const tasks = Object.values(this.runtime.runtimeTaskRegistry.all()).filter(
      (task) => task.offPeakExecutionId === this.executionId && !isTerminalRuntimeTask(task),
    );
    await Promise.all(
      tasks.map((task) =>
        this.runtime.stopBackgroundTask(task.taskId, {
          traceContext: this.runtime.rootTraceContext,
        }),
      ),
    );
  }
/**
 * 触发一次工作事实刷新（异步重读输入队列后重算状态）。
 *
 * 输入：无。输出：无（fire-and-forget）。
 * 并发控制：每次调用 revision++；已在 reading 或已终态则只递增版本不重读；
 *   重读结束在 finally 里统一 reading=false 并调 lifecycle.workChanged。
 * 失败降级：重读失败时把 pendingInputs 置回 true（宁可"当作还有工作"也不提前完成），
 *   只 warn 日志，等下个工作事件再重试；绝不靠计时器猜测。
 */
  refreshWork(): void {
    this.revision++;
    if (this.reading || this.lifecycle.terminal) return;
    this.reading = true;
    void this.readPendingInputs()
      .catch((error) => {
        // 无法读取权威队列时不提前完成，也不凭计时器猜测；下一次工作事件重新读取。
        this.pendingInputs = true;
        this.runtime.logger?.warn("Off-peak work projection failed", {
          error: String(error),
          event: "off_peak.work_read_failed",
        });
      })
      .finally(() => {
        this.reading = false;
        this.lifecycle.workChanged();
      });
  }
/**
 * 从权威投影读取"是否还有待处理 steer 输入"（私有）。
 *
 * 循环口径：读前记 version，读后若 revision 已变且未终态则重读，保证用到的是最新队列事实；
 * 终态后停止重读（结论已无意义）。
 * 副作用：只更新 pendingInputs；不修改状态机。
 */
  private async readPendingInputs(): Promise<void> {
    let version: number;
    do {
      version = this.revision;
      const projection = await this.runtime.rebuildProjection();
      this.pendingInputs = projection.pendingSteerInputs.length > 0;
    } while (version !== this.revision && !this.lifecycle.terminal);
  }
/**
 * 清理控制器资源（私有，completed 时调用）。
 *
 * 步骤：取消 registry 订阅 → 从 eventSinks 移除本 sink → 清空 registry 的 offPeakExecutionId →
 *   若未被用户接管，把会话模型选择恢复成 ordinarySelection。
 * 已接管时不恢复：接管意味着用户已有新选择，不能被旧值覆盖。
 * 副作用：改 runtime 选择与订阅；controllers WeakMap 中的引用保留到 runtime 回收。
 */
  private dispose(): void {
    this.unsubscribeRegistry?.();
    this.runtime.eventSinks.delete(this.eventSink);
    this.runtime.runtimeTaskRegistry.setOffPeakExecutionId?.(undefined);
    if (!this.lifecycle.ownedByUser) this.runtime.setSessionModelSelection(this.ordinarySelection);
  }
}
