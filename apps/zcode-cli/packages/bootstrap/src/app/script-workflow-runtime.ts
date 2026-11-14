// INV-01 调用序号只在 validate 归零，run 与 resume 都不重置，守住位置是 runAgent 里的自增，改错故障是每 run 重置会让 1000 上限按次失效。
// INV-02 上限判定先比较后自增，第 1000 次可执行第 1001 次抛，守住位置是 runAgent 首段的比较，改错故障是自增后再比较会提前一次失败。
// INV-03 活动行必须先 create 再进入本地闸门，守住位置是创建与限流的先后，改错故障是把创建挪进闸门内会让排队调用在 status 里消失。
// INV-04 缓存命中只追加 activity_cached，不建活动行、不建 task link、不计 token，守住位置是命中分支的提前返回，改错故障是命中后仍建行会重复计费。
// INV-05 child_session_id 有 session 外键，活动行更新必须在子会话持久化之后，守住位置是持久化那行的 await，改错故障是提前更新会触发外键失败。
// INV-06 执行边界先于读脚本、父会话持久化与子进程启动，守住位置是 run 的第一个 await，改错故障是边界后置会让预算与审批晚于执行体。
// INV-07 父会话持久化先于 prepareScriptWorkflowRun，task link 才挂得住，守住位置是这两步的先后，改错故障是反序会让外键指向不存在的会话。
// INV-08 终态记录与事件成对且记录在前，守住位置是 try 与 catch 的尾部，改错故障是先发事件再写终态会让 status 读 running 而事件已宣告完成。
// INV-09 run 把执行失败收敛成 failed 记录并正常返回，但 store 写失败仍外抛，守住位置是 catch 的边界，改错故障是把装配故障也吞掉会掩盖真实原因。
// INV-10 失败活动要同时写 failed 状态、失败统计与 activity_failed 事件后再重抛，守住位置是 runLiveAgent 的 catch，改错故障是吞掉错误会让脚本拿空值继续跑。
// INV-11 事件订阅必须在 finally 退订，守住位置是 finally 分支，改错故障是只在成功路径退订会泄漏父会话的事件监听。
// INV-12 子进程事件统一加 script_ 前缀入库，只有 phase 且 payload.title 为字符串才改 currentPhase，守住位置是 handleChildEvent 的分支，改错故障是无条件写阶段会让 run 被空值覆盖。
// INV-13 callPath 缺省 root/agentN 且 N 取本次序号，inputHash 由 opts、phase、prompt 共同决定，守住位置是哈希入参，改错故障是漏一项会让缓存键错配命中。
// INV-14 resume 只认记录里的 scriptPath 与 args，缺失即抛不做猜测，守住位置是两道前置校验，改错故障是兜底空路径会续跑到别的脚本。
// INV-15 子进程请求只有 agent 一种实现，嵌套 workflow 与未知类型一律抛，守住位置是 handleChildRequest 的两个异常分支，改错故障是静默忽略会让脚本卡在未决状态。
// INV-16 store 每次调用重新做能力探测，不缓存端口引用，守住位置是 store 方法的判断分支，改错故障是缓存一次探测结果会漏掉后续注入的 store。
// INV-17 budgetSpent 只累加 tokens.total，stats 走 merge 不覆盖维度，守住位置是 addRunStats 的写回，改错故障是用替换写入会抹掉既有统计。
// INV-18 并发上限取自 resolveWorkflowDefaultConcurrency，legacy 路径只有本地 limiter 不接治理器，守住位置是构造期字段初始化，改错故障是运行期重读配置会让同实例前后并发不一致。
//
// 模块职责：把 legacy 文件型脚本工作流从读脚本、准备 run、spawn 子进程到事件与活动落库串成一次可观测执行。
// 状态所有权：sessionStore 借自 deps 且必须同时是 ScriptWorkflowStorePort，本类不关闭端口、不拥有子会话。
// 阅读顺序：先看 run 的主干顺序，再看 runAgent 的计数与缓存，最后看 runLiveAgent 的边界与失败统计。
/**
 * script-workflow-runtime：legacy 文件型脚本工作流（RunWorkflow / ResumeWorkflowRun）的执行体。
 * 定位：读脚本 → 准备 run（预算/续跑）→ spawn 子进程执行 → 子进程经 IPC 回传事件与 agent 请求 →
 *   本类为每个 agent 调用构造 child AgentRuntime，并把 activity / task link / 事件落进 store。
 * 所有权：不拥有 sessionStore（借用 deps.sessionStore，且它必须同时是 ScriptWorkflowStorePort）；
 *   child 会话由 store 持久化；本类不关闭任何端口，生命周期随父 App。
 * 失败语义：run() 把执行失败收敛成 failed 记录后**正常返回**（不向调用方抛）；单个 agent 活动失败
 *   则先落 failed 记录与统计，再把原错误抛回子进程（是否捕获由脚本决定）。
 * 并发口径：同一实例内 legacy 路径只有本地 WorkflowLimiter，不接进程级治理器；上限取自
 *   resolveWorkflowDefaultConcurrency（与 dwf/治理器同一实现，决策 30）。
 * 不变量：agent 调用总数 ≤ 1000；activity 先 create 再排队；缓存命中的调用不建活动行。
 */
import {
  WorkflowAgentCallInputSchema,
  createChildTraceContext,
  createSessionId,
  type ScriptWorkflowActivityRecord,
  type ScriptWorkflowRunRecord,
  type ScriptWorkflowRunStats,
  type ScriptWorkflowRunStatus,
  type ScriptWorkflowStorePort,
  type SessionId,
  type TraceContext,
  type WorkflowAgentCallInput,
} from "@zcode/contracts";
import type { PrepareUserExecutionBoundary } from "./types.js";
import { readWorkflowScriptDocument, stableHash } from "./script-workflow-meta.js";
import { prepareScriptWorkflowRun } from "./script-workflow-prepare.js";
import { resolveWorkflowDefaultConcurrency } from "./workflow-default-concurrency.js";
import {
  runScriptWorkflowChild,
  type ScriptWorkflowChildRequest,
} from "./script-workflow-process.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";
import {
  emptyScriptWorkflowStats,
  formatScriptWorkflowList,
  formatScriptWorkflowRun,
  formatScriptWorkflowValidation,
  mergeScriptWorkflowStats,
} from "./script-workflow-format.js";
import {
  WorkflowLimiter,
  buildAgentPrompt,
  collectScriptWorkflowSessionStats,
  isRecord,
  isScriptWorkflowStore,
  mergedSignal,
  parseStructuredResponse,
  serializeError,
} from "./script-workflow-utils.js";

// 上限是实例级硬闸门，跨 run 累计，除 validate 之外没有归零点。
// 先比较后自增：第 1000 次仍可执行，第 1001 次直接抛硬错。
// 构造期固定，运行期不再读配置，调整配额要新建实例。
// 改写这条常量会同时改变长会话里工作流能否启动的判定。
const MAX_WORKFLOW_AGENT_CALLS = 1000;

/** 依赖 = 子代理 runtime 依赖 + 执行边界准备 + 父 trace；sessionStore 必须兼具 ScriptWorkflowStorePort。 */
export interface ScriptWorkflowRuntimeDeps extends ScriptWorkflowAgentRuntimeDeps {
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  traceContext: TraceContext;
}

/** 运行选项：abortSignal 只取消本次执行；onEvent 透传给子会话事件；其余是执行边界字段。 */
type ScriptWorkflowRunOptions = {
  abortSignal?: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
} & Parameters<PrepareUserExecutionBoundary>[0];

/**
 * 每个父会话一个实例（create-app 构造后注入 facade）。实例级可变状态只有三个：
 * concurrency/limiter（本地并发闸门）与 callIndex（agent 调用序号）。
 * 注意 callIndex 只在 validate() 归零，run() 不重置——1000 次上限按实例累计而不是按 run 重置，
 * 这是历史行为，改动它会改变长会话里"第 N 次工作流"能否启动的判定。
 */
export class ScriptWorkflowRuntime {
  // 与 dwf run service / 进程级治理器同一份默认并发实现（决策 30）；legacy 工具仍只有本地 limiter，不接治理器。
  private readonly concurrency = resolveWorkflowDefaultConcurrency();
  private readonly limiter = new WorkflowLimiter(this.concurrency);
  private callIndex = 0;

  constructor(private readonly deps: ScriptWorkflowRuntimeDeps) {}

  /**
   * 只校验脚本（读文档并返回 meta/hash 摘要），不建 run、不落盘。
   * 副作用：把 callIndex 归零——这是本类唯一的"重置"点，不要把它当成每次 run 都会发生的动作。
   */
  async validate(input: { scriptPath: string }): Promise<{ response: string; traceId: string }> {
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: this.deps.traceContext,
    });
    // 唯一的归零点，只在这里清零调用序号，run 与 resume 都不重置。
    // 因此配额按实例累计，与本次 run 提交了多少次 agent 调用无关。
    // 守住位置是这行赋值；validate 表面只读脚本，却带这个副作用。
    // 改错故障是把归零搬进 run，续跑与重跑都能重新取得全额配额。
    this.callIndex = 0;
    return {
      response: formatScriptWorkflowValidation({
        meta: document.meta,
        scriptHash: document.hash,
        scriptPath: document.path,
      }),
      traceId: this.deps.traceContext.traceId,
    };
  }

  /** 列出本工作目录最近的 run（limit 缺省 20），只读；格式化后由工具直接回给模型。 */
  async list(input: { limit?: number } = {}): Promise<{ response: string; traceId: string }> {
    const runs = await this.store().listScriptWorkflowRuns({
      cwd: this.deps.workingDirectory,
      limit: input.limit ?? 20,
    });
    return {
      response: formatScriptWorkflowList(runs),
      traceId: this.deps.traceContext.traceId,
    };
  }

  /** 查单 run（缺省取本工作目录最近一条）：列表活动 + 格式化；无记录时回 "No workflow run found."。 */
  async status(input: { runId?: string } = {}): Promise<{
    response: string;
    runId?: string;
    status?: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    const run = input.runId
      ? await this.store().getScriptWorkflowRun(input.runId)
      : (
          await this.store().listScriptWorkflowRuns({
            cwd: this.deps.workingDirectory,
            limit: 1,
          })
        )[0];
    if (!run) {
      return {
        response: "No workflow run found.",
        traceId: this.deps.traceContext.traceId,
      };
    }
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run }),
      runId: run.id,
      status: run.status,
      traceId: this.deps.traceContext.traceId,
    };
  }

  /**
   * 执行一次脚本工作流：边界 → 读脚本 → 确保父会话已持久化（外部活动要挂 task link）→
   *   prepare run（预算/续跑/runId）→ 记 workflow_started → 置 running → spawn 子进程 →
   *   无论成败都落终态与 completed/failed 事件 → 读回最终记录并格式化。
   * 输入：scriptPath 必填；args / resumeFromRunId / runId 可选（resume() 复用本方法）。
   * 输出：格式化文本 + runId/status + traceId（status 是最终记录的状态，不是异常信号）。
   * 失败语义：执行错误被 catch 成 failed 记录、不重抛；但 store 自身写失败仍会抛出（属装配故障）。
   * 顺序敏感：prepareUserExecutionBoundary 必须先于会话持久化与子进程启动，否则执行边界晚于执行体。
   */
  async run(
    input: { args?: unknown; resumeFromRunId?: string; runId?: string; scriptPath: string },
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    status: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    // 顺序硬约束：执行边界先于读脚本、父会话持久化与子进程启动。
    // 边界晚于执行体会让预算与审批在子进程已经跑起来之后才生效。
    // traceContext 优先取 options，缺省回落 deps，两条来源不能同时为空。
    // 守住位置是 run 的第一个 await，之前不得插入任何带副作用的语句。
    await this.deps.prepareUserExecutionBoundary(options);
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: options?.traceContext ?? this.deps.traceContext,
    });
    await this.deps.runtime.ensureSessionPersistedForExternalActivity(
      `/workflow run ${document.path}`,
      { traceContext: options?.traceContext ?? this.deps.traceContext },
    );
    const run = await prepareScriptWorkflowRun({
      args: input.args,
      document,
      parentSessionId: this.deps.sessionId,
      resumeFromRunId: input.resumeFromRunId,
      runId: input.runId,
      store: this.store(),
      workingDirectory: this.deps.workingDirectory,
    });
    await this.appendEvent(run.id, "workflow_started", { scriptPath: document.path });

    try {
      await this.store().updateScriptWorkflowRun({
        id: run.id,
        startedAt: Date.now(),
        status: "running",
      });
      const childResult = await runScriptWorkflowChild({
        args: input.args ?? run.args,
        budgetTotal: run.budgetTotal,
        document,
        handleEvent: (event) => this.handleChildEvent(run.id, event.type, event.payload),
        handleRequest: (request) => this.handleChildRequest(run, request, options),
        signal: options?.abortSignal,
        workingDirectory: this.deps.workingDirectory,
      });
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        id: run.id,
        status: "completed",
      });
      // 成功路径的落库顺序：先写 completed 记录，再追加 workflow_completed 事件。
      // 失败路径结构对称：failed 记录在前，workflow_failed 事件在后。
      // 两条路径都在 try 与 catch 内，事件写入抛错会被外层捕获当成执行失败。
      // 改错故障是先发事件再写终态，status 会读到 running 而事件已宣告完成。
      await this.appendEvent(run.id, "workflow_completed", { result: childResult.value });
    } catch (error) {
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        failure: serializeError(error),
        id: run.id,
        status: "failed",
      });
      await this.appendEvent(run.id, "workflow_failed", serializeError(error));
    }

    const finalRun = (await this.store().getScriptWorkflowRun(run.id)) ?? run;
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run: finalRun }),
      runId: run.id,
      status: finalRun.status,
      traceId: this.deps.traceContext.traceId,
    };
  }

  /**
   * 续跑入口：只用记录里的 scriptPath 与 args，并带 resumeFromRunId 让活动缓存命中；
   * 记录或 scriptPath 缺失时直接抛（结构上不可续跑的 run 不做猜测）。其余语义全部委托 run()。
   */
  async resume(
    input: { runId: string },
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    status: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    const run = await this.store().getScriptWorkflowRun(input.runId);
    // 续跑只认记录：scriptPath 与 args 都从 run 记录取，不接受调用方覆盖。
    // 记录缺失或 scriptPath 为空立即抛，不做路径猜测，避免续跑到别的脚本。
    // resumeFromRunId 同时参与缓存键，缺它会让已完成的活动重新执行。
    // 其余语义全部委托 run，这里不复制边界、预算与终态写入逻辑。
    if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
    if (!run.scriptPath) throw new Error(`Workflow run has no script path: ${input.runId}`);
    return this.run(
      {
        args: run.args,
        resumeFromRunId: input.runId,
        scriptPath: run.scriptPath,
      },
      options,
    );
  }

  /** 子进程请求分发：agent 是唯一实现；嵌套 workflow() 与未知类型一律抛，由子进程侧转成脚本错误。 */
  private async handleChildRequest(
    run: ScriptWorkflowRunRecord,
    request: ScriptWorkflowChildRequest,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (request.type === "agent") {
      return this.runAgent(run, WorkflowAgentCallInputSchema.parse(request.payload), options);
    }
    if (request.type === "workflow") {
      throw new Error("Nested workflow() is reserved for a later workflow runtime version.");
    }
    throw new Error(`Unknown workflow child request: ${request.type}`);
  }

  /** 子进程事件 → run 当前阶段（phase.title）更新 + 事件追加（统一加 script_ 前缀）。 */
  private async handleChildEvent(runId: string, type: string, payload: unknown): Promise<void> {
    if (type === "phase" && isRecord(payload) && typeof payload.title === "string") {
      await this.store().updateScriptWorkflowRun({
        currentPhase: payload.title,
        id: runId,
      });
    }
    // 子进程事件入库前统一加 script_ 前缀，避免与父会话原生事件名撞车。
    // 只有 phase 且 payload.title 为字符串才改 currentPhase，其余事件只追加。
    // 先更新阶段再追加事件，status 读到的 currentPhase 不会落后于事件流。
    // 改错故障是无条件写阶段，一次畸形 payload 就能把 run 阶段覆盖成空。
    await this.appendEvent(runId, `script_${type}`, payload);
  }

  /**
   * 一次 agent 调用的入口：先计数（超 1000 抛硬错），按 callPath+inputHash 查缓存；命中只记
   * activity_cached、不建活动行（缓存不消耗 token，也不再建 task link）。
   * 未命中才 create activity 并交给本地并发闸门；callPath 缺省 root/agentN（N=本次序号）。
   */
  private async runAgent(
    run: ScriptWorkflowRunRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (this.callIndex >= MAX_WORKFLOW_AGENT_CALLS) {
      throw new Error(`Workflow agent call limit exceeded: ${MAX_WORKFLOW_AGENT_CALLS}`);
    }
    const callIndex = ++this.callIndex;
    const callPath = input.callPath ?? `root/agent${callIndex}`;
    const phase = input.opts?.phase ?? input.phase;
    const inputHash = stableHash({ opts: input.opts, phase, prompt: input.prompt });
    const cached = await this.store().findCachedScriptWorkflowActivity({
      callPath,
      inputHash,
      runId: run.id,
    });
    if (cached?.result) {
      await this.appendEvent(run.id, "activity_cached", { activityId: cached.id });
      // The child runner unwraps result.value while reading stats from the envelope.
      return cached.result;
    }

    const activity = await this.store().createScriptWorkflowActivity({
      callIndex,
      callPath,
      id: `activity_${crypto.randomUUID()}`,
      inputHash,
      label: input.opts?.label,
      opts: input.opts,
      phase,
      prompt: input.prompt,
      runId: run.id,
      type: "agent",
    });
    // 限流只包住真正执行，活动行在进入排队之前就已创建。
    // 所以 status 能看到排队中的活动，而不是等执行开始才出现一行。
    // 闸门是实例级本地计数，不接进程级治理器，跨实例不共享配额。
    // [权衡] 取消发生在 limiter.run 之前，序号与活动行已提交：要么留一条排队痕迹；要么把创建挪进闸门内让调用消失。
    // 改错故障是把创建挪进闸门内部，已提交未执行的调用会从列表里消失。
    return this.limiter.run(() => this.runLiveAgent(run, activity, input, options));
  }

  /**
   * 真正执行一次 agent 活动：构造 child 会话/runtime，按序推进（确保子会话持久化 → 置 running →
   *   记 activity_started → 订阅事件 → executeTurn）、成功后写 result/stats/task link/事件，
   *   最后返回 activity envelope（脚本侧只拿到 value）。
   * 失败语义：catch 先落 failed 活动与失败统计，再把原错误抛回子进程；finally 必定退订。
   * 口径：schema 在场时 value=解析后的结构，否则 value=原始 response；envelope 留在 IPC 边界。
   * 并发口径：本活动已由 runAgent 包在 limiter 内，这里不再二次限流。
   */
  private async runLiveAgent(
    run: ScriptWorkflowRunRecord,
    activity: ScriptWorkflowActivityRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (input.opts?.isolation === "worktree") {
      throw new Error("workflow agent isolation 'worktree' is not implemented yet.");
    }
    const startedAt = Date.now();
    const childSessionId = createSessionId(`workflow_${activity.id}`);
    const childTraceContext = createChildTraceContext(this.deps.traceContext, {
      attributes: {
        parentSessionId: this.deps.sessionId,
        workflowActivityId: activity.id,
        workflowRunId: run.id,
      },
      sessionId: childSessionId,
    });
    const childRuntime = createScriptWorkflowAgentRuntime({
      childSessionId,
      deps: this.deps,
      request: input,
      traceContext: childTraceContext,
    });
    const agentPrompt = buildAgentPrompt(input);

    let unsubscribe: (() => void) | undefined;
    try {
      // workflow_activity.child_session_id has an FK to session(id), so link only after persistence.
      await childRuntime.ensureSessionPersistedForExternalActivity(agentPrompt, {
        traceContext: childTraceContext,
      });
      await this.store().updateScriptWorkflowActivity({
        childSessionId,
        id: activity.id,
        startedAt,
        status: "running",
      });
      await this.appendEvent(run.id, "activity_started", { activityId: activity.id });
      unsubscribe = options?.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      const signal = mergedSignal(options?.abortSignal, input.opts?.timeoutMs);
      const result = await childRuntime.executeTurn(agentPrompt, undefined, {
        abortSignal: signal,
        inputSource: "subagent",
        traceContext: childTraceContext,
      });
      const stats = await this.collectSessionStats(childSessionId);
      const value = input.opts?.schema ? parseStructuredResponse(result.response) : result.response;
      const activityResult = {
        response: result.response,
        stats,
        traceId: result.traceId,
        turnId: result.turnId,
        value,
      };
      await this.store().updateScriptWorkflowActivity({
        completedAt: Date.now(),
        id: activity.id,
        result: activityResult,
        status: "completed",
      });
      const childSelection = childRuntime.getSessionModelSelection();
      await this.store().createSessionTaskLink({
        activityId: activity.id,
        agentType: input.opts?.agentType,
        childSessionId,
        id: `tasklink_${crypto.randomUUID()}`,
        label: input.opts?.label,
        model: childSelection
          ? `${childSelection.providerId}/${childSelection.modelId}`
          : undefined,
        parentSessionId: this.deps.sessionId,
        path: activity.callPath,
        phase: activity.phase,
        role: "workflow_agent",
        rootWorkflowRunId: run.id,
        status: "completed",
      });
      await this.addRunStats(run.id, stats);
      await this.appendEvent(run.id, "activity_completed", { activityId: activity.id });
      // Keep the activity envelope on the child-process IPC boundary; script code receives value.
      return activityResult;
    } catch (error) {
      await this.store().updateScriptWorkflowActivity({
        completedAt: Date.now(),
        error: serializeError(error),
        id: activity.id,
        status: "failed",
      });
      // 失败也要计账：补一条 agentCalls=1、failedAgentCalls=1 的增量后再重抛。
      // 只补失败维度，成本维度保持为零，失败的调用不该消耗 token 预算。
      // 重抛保留原错误对象，是否中止脚本由子进程侧脚本自行决定。
      // finally 必定退订事件订阅，异常路径同样如此，否则父会话监听泄漏。
      // 改错故障是吞掉错误，脚本会以为 agent 成功并拿着空值继续往下跑。
      await this.addRunStats(run.id, {
        ...emptyScriptWorkflowStats(),
        agentCalls: 1,
        failedAgentCalls: 1,
      });
      await this.appendEvent(run.id, "activity_failed", {
        activityId: activity.id,
        error: serializeError(error),
      });
      throw error;
    } finally {
      unsubscribe?.();
    }
  }

  /** 从子会话读累计 stats（复用 utils 的归约，避免与 format 侧口径分叉）。 */
  private async collectSessionStats(sessionId: SessionId): Promise<ScriptWorkflowRunStats> {
    return collectScriptWorkflowSessionStats(
      this.deps.sessionStore,
      sessionId,
      emptyScriptWorkflowStats,
    );
  }

  /** run 级用量累加：budgetSpent 按 tokens.total 增量，stats 走 merge（不覆盖既有维度）。 */
  private async addRunStats(runId: string, delta: ScriptWorkflowRunStats): Promise<void> {
    const run = await this.store().getScriptWorkflowRun(runId);
    const current = run?.stats ?? emptyScriptWorkflowStats();
    await this.store().updateScriptWorkflowRun({
      // run 级累加是读改写：先取记录，再同时写 budgetSpent 与 stats 两个字段。
      // budgetSpent 只吃 delta.tokens.total，不按活动条数或耗时估算。
      // stats 走 merge 而不是替换，避免抹掉先前累积的维度。
      // 并发活动各自累加，非原子写，同一 run 的两次完成可能互相覆盖增量。
      budgetSpent: (run?.budgetSpent ?? 0) + delta.tokens.total,
      id: runId,
      stats: mergeScriptWorkflowStats(current, delta),
    });
  }

  /** 追加 run 级事件（id 随机铸造；时序由 store 的插入序决定，不依赖时间戳）。 */
  private async appendEvent(runId: string, type: string, payload?: unknown): Promise<void> {
    await this.store().appendScriptWorkflowEvent({
      id: `workflow_event_${crypto.randomUUID()}`,
      payload,
      runId,
      type,
    });
  }

  /** 能力探测：deps.sessionStore 必须同时是 ScriptWorkflowStorePort，否则视为装配错误直接抛。 */
  private store(): ScriptWorkflowStorePort {
    if (isScriptWorkflowStore(this.deps.sessionStore)) return this.deps.sessionStore;
    throw new Error("Script workflow store is not available for this session store.");
  }
}
