/**
 * ============================================================================
 * runtime/command-queue.ts —— 会话级 runtime command 队列
 * ============================================================================
 *
 * 【它装什么】
 *   不只是 prompt:目标续跑、任务通知、子代理回复、control-only 配置轮都排在这里。
 *   每条命令带 mode + priority + 可选 branchGeneration/offPeakExecutionId。
 *
 * 【排序规则】
 *   优先级 now < next < later;同优先级按**入队顺序**(选择时取第一个最小 rank 的下标),
 *   因此队列是稳定的 FIFO,不会因快照/重排而乱序。
 *
 * 【批量出队】
 *   只有 task-notification 支持批量:同一 priority + 同一 offPeakExecutionId 的通知
 *   可以合并成一批消费(它们对模型是"多个任务结果",没有严格先后关系)。
 *   其它 mode(prompt/control-only/续跑)必须一次一条,否则会打乱轮次语义。
 *
 * 【取消标记】
 *   cancelPending 是两阶段标记:调用方先 mark,队列消费到该命令时再 consume;
 *   这样"取消"不会和"已经出队正在执行"产生竞态。
 *
 * 【消费方与生命周期】
 *   外层由 drainRuntimeCommandQueue 按 mode 分派(执行/target 续跑/子代理/设置轮);
 *   活动 turn 内由 runtime-command-active-loop 只在模型步之间吸收 next 及以上的
 *   task-notification / subagent-message;遇到 control-only-turn 必须停下让位。
 *
 * 【不变量】
 *   - 队列是纯内存态事实:不落盘、不参与冷恢复,进程结束即消失;
 *   - 每条命令的 resolve/reject 是一次性收口,消费方必须在 finally 中排空;
 *   - 带 branchGeneration 的三类命令(通知/子代理回复/control-only)在消费前必须
 *     再次比对当前代际,不匹配即丢弃(rewind 后的旧分支结果不得进入当前分支);
 *   - 批量合并仅限 task-notification,且要求同 priority + 同 offPeakExecutionId,
 *     因为这一批结果会在同一次模型请求里一起被读到。
 * ============================================================================
 */
import type { TraceContext, TurnState } from "./deps.js";
import type { BackgroundResultOriginMeta, WorkflowLaunchMeta } from "@zcode/contracts";
import type {
  ActiveTurnStartReservation,
  ContinueActiveTargetLoopOptions,
  ExecuteTurnOptions,
  TurnResult,
} from "./types.js";

/**
 * 出队优先级口径:rank now(0) < next(1) < later(2),rank 越小越先出队。
 * now 用于必须立刻执行的打断型命令;next 是普通 prompt / 通知 / 设置轮;
 * later 留给"当前 turn 结束后再处理"的命令,活动 loop 通过 getByMaxPriority("next")
 * 明确不吸收它们。同优先级不抢占,因此队列整体保持稳定 FIFO。
 */
export type RuntimeCommandPriority = "now" | "next" | "later";

/**
 * 命令的消费路径标签,决定由谁、以什么粒度执行:
 * - prompt / target-continuation(-loop):占用前台执行,一次一条;
 * - task-notification:可批量合并后作为一次模型轮的输入;
 * - subagent-message:先落一条 model-only 消息,再跑一次 turn;
 * - control-only-turn:只记录配置变更,不进入模型轮,必须等当前 turn 结束。
 */
export type RuntimeCommandMode =
  | "prompt"
  | "target-continuation"
  | "target-continuation-loop"
  | "task-notification"
  | "subagent-message"
  | "control-only-turn";
/**
 * 品牌化字符串,防止普通 string 被误当成命令 id。
 * 值由 createRuntimeCommandId 生成:进程内单调序号,不跨进程、不持久化,
 * 只用于日志排序、取消标记与去重,不构成任何 durable 身份。
 */
export type RuntimeCommandId = string & {
  readonly __runtimeCommandId: unique symbol;
};

/**
 * 所有命令的公共字段口径:
 * - id:见 RuntimeCommandId,进程内标识;
 * - mode:决定消费路径,也是批量的前置条件;
 * - priority:决定出队顺序,同 priority 时按入队顺序;
 * - offPeakExecutionId:off-peak 执行批次标识,通知批量的合并边界;
 * - createdAt / traceContext:仅用于日志与因果追踪,不参与排序或持久化。
 */
export interface RuntimeCommandBase {
  readonly offPeakExecutionId?: string;
  readonly createdAt: Date;
  readonly id: RuntimeCommandId;
  readonly mode: RuntimeCommandMode;
  readonly priority: RuntimeCommandPriority;
  readonly traceContext: TraceContext;
}

/**
 * 一条普通用户 prompt。它由 admitPrompt 在 admission 阶段构造:
 * - startReservation 证明 turn 启动权已被本命令占用,执行阶段不得再创建/竞争 turn;
 * - resolve 只在整轮 executeTurnCommand 成功时调用(可被 target 续跑结果覆盖);
 * - reject 用于取消(createTurnCancelledError)或执行失败,调用方据此结束等待。
 * 两个回调都是一次性收口,队列本身不做去重或重试。
 */
export interface PromptRuntimeCommand extends RuntimeCommandBase {
  readonly attachments?: TurnState["attachments"];
  readonly input: string;
  readonly mode: "prompt";
  readonly options?: ExecuteTurnOptions;
  /** admission 已建立的 reservation；执行阶段不得再次创建/竞争 turn。 */
  readonly startReservation?: ActiveTurnStartReservation;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult) => void;
}

export interface TargetContinuationRuntimeCommandOptions {
  readonly abortSignal?: AbortSignal;
  readonly inputId?: string;
  readonly intent?: ExecuteTurnOptions["intent"];
  readonly traceContext: TraceContext;
  readonly verifyBeforeContinue?: boolean;
}

/**
 * Goal 的单次续跑:只有存在可续跑的 active target 时才会入队。
 * resolve 的 TurnResult | null 中, null 表示"没有候选 / 让位给队列",不是失败;
 * reject 才代表执行期真实错误。verifyBeforeContinue 决定是否先跑完成校验。
 */
export interface TargetContinuationRuntimeCommand extends RuntimeCommandBase {
  readonly mode: "target-continuation";
  readonly options: TargetContinuationRuntimeCommandOptions;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult | null) => void;
}

/**
 * Goal 的连续续跑循环:与单次续跑的差别在于它会在一个前台执行域内反复跑 turn,
 * 直到目标完成、被取消或让位给其它队列命令。因为占用前台执行,队列里同一时刻
 * 只应有一条此类命令。
 */
export interface TargetContinuationLoopRuntimeCommand extends RuntimeCommandBase {
  readonly mode: "target-continuation-loop";
  readonly options: ContinueActiveTargetLoopOptions & {
    readonly traceContext: TraceContext;
  };
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult | null) => void;
}

/**
 * 后台任务(Bash / 子代理 / workflow run)的结果通知。
 * - branchGeneration 记录入队时的分支代际,消费前必须与 runtime 当前值一致;
 * - originMeta / taskId / toolName 是"哪个任务、哪类结果"的归因事实,用于
 *   组合通知文本与后续 target 续跑判断;
 * - text 是已渲染好的模型可见文本,消费方不再二次拼装。
 * 只有本类型参与批量合并(同 priority + 同 offPeakExecutionId)。
 */
export interface TaskNotificationRuntimeCommand extends RuntimeCommandBase {
  readonly branchGeneration: number;
  readonly mode: "task-notification";
  readonly source: "background_task";
  readonly originMeta?: BackgroundResultOriginMeta;
  readonly taskId?: string;
  readonly text: string;
  readonly toolName?: string;
}

/**
 * 子代理回传给父会话的一条消息。
 * - responseId / agentId / childSessionId / childToolCallId 定位"哪次调用的回传",
 *   持久化时会据此写 message 与 causality;
 * - summary 供日志与折叠展示,text 才是模型可见正文;
 * - messageLength 预计算长度,避免日志里截断前先复制长文本;
 * - branchGeneration 与通知同理:rewind 后旧分支的回传必须丢弃。
 */
export interface SubagentMessageRuntimeCommand extends RuntimeCommandBase {
  readonly branchGeneration: number;
  readonly mode: "subagent-message";
  readonly source: "subagent_message";
  readonly responseId: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly childSessionId: string;
  readonly childToolCallId: string;
  readonly parentToolCallId?: string;
  readonly summary: string;
  readonly messageLength: number;
  readonly text: string;
}

/**
 * 一条排队的 controlOnly 用户轮：GUI「配置」
 * 已经把 run 修订掉了，这条命令只负责把这件事记进会话。它不进模型轮，却要落一条 user 消息，而
 * user 消息插不进一个正在跑的 turn（provider 语法：assistant 的 tool_use 与 tool_result 之间
 * 不能夹 user），所以它排在队列里、等当前 turn 结束。与通知同一个优先级，因而落在新 run 的任何
 * 通知之前；带 branchGeneration，rewind 后丢弃。
 */
export interface ControlOnlyTurnRuntimeCommand extends RuntimeCommandBase {
  readonly branchGeneration: number;
  readonly mode: "control-only-turn";
  /** 进 runtime history 与持久消息的规范句（模型下一回合读它）。 */
  readonly text: string;
  /** `ensureSessionPersisted` 的首输入标题种子。 */
  readonly titleInput: string;
  readonly inputId?: string;
  /** 轮与消息上的同一份元数据（冷热同形）。 */
  readonly workflowLaunch: WorkflowLaunchMeta;
}

/**
 * 队列元素的封闭集合。新增 mode 必须同步:消费分派(runtime-command-queue /
 * active-loop)、代际过滤(哪些类型带 branchGeneration)与批量规则,
 * 否则命令会入队后无人消费或绕过 rewind 过滤。
 */
export type RuntimeCommand =
  | PromptRuntimeCommand
  | TargetContinuationRuntimeCommand
  | TargetContinuationLoopRuntimeCommand
  | TaskNotificationRuntimeCommand
  | SubagentMessageRuntimeCommand
  | ControlOnlyTurnRuntimeCommand;

/**
 * 会话级命令队列的内存契约(实现见 createRuntimeCommandQueue):
 * - 出队 `dequeue / dequeueNextBatch` 是破坏性操作,且后者可能一次取走多条通知;
 * - `snapshot / getByMaxPriority` 返回冻结的只读数组,但元素仍是同一批命令对象,
 *   调用方不得原地改命令字段;
 * - `markCancelPending / consumeCancelPending` 构成两阶段取消:标记幂等,
 *   消费返回 true 表示"这次取消由本次出队兑现",只能成功一次;
 * - `removeById` 是显式撤销(如活动 loop 吸收或用户删除排队项),找不到返回 undefined。
 */
export interface RuntimeCommandQueue {
  clearCancelPending(id: RuntimeCommandId): void;
  consumeCancelPending(id: RuntimeCommandId): boolean;
  dequeue(): RuntimeCommand | undefined;
  dequeueNextBatch(): readonly RuntimeCommand[];
  enqueue(command: RuntimeCommand): void;
  getByMaxPriority(maxPriority: RuntimeCommandPriority): readonly RuntimeCommand[];
  hasPending(): boolean;
  markCancelPending(id: RuntimeCommandId): void;
  removeById(id: RuntimeCommandId): RuntimeCommand | undefined;
  size(): number;
  snapshot(): readonly RuntimeCommand[];
}

const RUNTIME_COMMAND_PRIORITY_ORDER: Record<RuntimeCommandPriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

let runtimeCommandIdSequence = 0;

/**
 * 生成命令 id:模块级自增序号 + 固定前缀。
 *
 * 输入:无(序号是模块级可变状态);输出:品牌化 RuntimeCommandId。
 * 副作用:每次调用推进进程内计数器。并发语义:JS 单线程,同步自增无竞态;
 * 进程重启后序号归零,因此该 id 不能被持久化或跨进程当作幂等键。
 * 失败路径:不存在(纯内存操作,不抛错)。
 */
export function createRuntimeCommandId(): RuntimeCommandId {
  // 进程内单调序号而不是 UUID:
  //   - 队列只在本 runtime 内使用,不需要全局唯一;
  //   - 序号让日志/事件里的命令顺序可读,也避免高频入队的随机数开销。
  runtimeCommandIdSequence += 1;
  return `runtime_command_${runtimeCommandIdSequence}` as RuntimeCommandId;
}

/**
 * 创建一个纯内存的命令队列实例(一个 runtime 一个)。
 *
 * 状态只有两份:`commands`(插入顺序的数组)与 `cancelPendingCommandIds`(两阶段取消标记)。
 * 不落盘、不 emit 事件、不感知 activeTurn;所有调度语义(何时 drain、按 mode 分派)
 * 都在调用方。失败降级:任何选择/移除找不到目标都返回 undefined / 空数组,不抛错,
 * 保证 drain 循环不会因为一条坏命令卡死。
 */
export function createRuntimeCommandQueue(): RuntimeCommandQueue {
  const commands: RuntimeCommand[] = [];
  const cancelPendingCommandIds = new Set<RuntimeCommandId>();

  /**
   * 选出下一个应出队的下标(不删除)。
   * 比较规则是"rank 更小即更优先,严格小于才替换",所以同优先级时下标最小者
   * (最早入队)胜出,构成稳定 FIFO;`maxPriority` 是允许消费的最高优先级上界,
   * rank 超过它的命令直接跳过,供活动 loop 把 later 留到 turn 结束后。
   */
  const selectNextIndex = (maxPriority?: RuntimeCommandPriority): number => {
    let selectedIndex = -1;
    let selectedPriority = Number.POSITIVE_INFINITY;
    // maxPriority 语义是"允许消费的最高优先级":rank 大于它的命令不参与选择,
    // 因此 active-loop 可以用 next 把 later 的命令留到 turn 结束后再跑。
    const maxPriorityRank =
      maxPriority === undefined
        ? Number.POSITIVE_INFINITY
        : RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority];

    // 严格小于才替换 → 同优先级保留最早入队的那条(稳定 FIFO)。
    for (const [index, command] of commands.entries()) {
      const priority = RUNTIME_COMMAND_PRIORITY_ORDER[command.priority];
      if (priority > maxPriorityRank) continue;
      if (priority < selectedPriority) {
        selectedIndex = index;
        selectedPriority = priority;
      }
    }

    return selectedIndex;
  };

  return {
    clearCancelPending(id: RuntimeCommandId): void {
      // 命令已执行完毕(turn 在取消标记被消费前就自然结束)时清掉标记,
      // 避免同 id 的残留标记影响后续判断;重复清除是幂等的。
      cancelPendingCommandIds.delete(id);
    },

    consumeCancelPending(id: RuntimeCommandId): boolean {
      // Set.delete 的返回值正好表达"这次由我兑现取消":第二次调用返回 false,
      // 从而保证一次取消只 reject 一个等待方,不会重复收口。
      return cancelPendingCommandIds.delete(id);
    },

    /**
     * 取出一条最高优先级命令并移除;空队列返回 undefined。
     * 不检查 cancelPending,取消的兑现留给消费方(避免队列替调用方做决定)。
     */
    dequeue(): RuntimeCommand | undefined {
      const index = selectNextIndex();
      if (index === -1) return undefined;
      const [command] = commands.splice(index, 1);
      return command;
    },

    /**
     * 取出"下一次可一起消费"的一批命令:非通知恒为 1 条,通知可合并同批。
     * 返回冻结数组;合并后批次内顺序沿用数组原顺序(即入队顺序),调用方按此
     * 渲染通知文本,保证模型看到的任务结果次序稳定。
     */
    dequeueNextBatch(): readonly RuntimeCommand[] {
      const index = selectNextIndex();
      if (index === -1) return Object.freeze([]);
      const selected = commands[index];
      // 非通知命令一次只出队一条:prompt/control-only/续跑之间没有"可合并"的语义,
      // 合并会让它们互相覆盖轮次边界。
      if (selected?.mode !== "task-notification") {
        const [command] = commands.splice(index, 1);
        return Object.freeze(command ? [command] : []);
      }

      // 通知可以批量:同 priority + 同 offPeakExecutionId 的结果会在同一次模型请求里
      // 一起被读到;不同 offPeakExecutionId 属于不同执行批次,不能混在一起。
      const batch = commands.filter(
        (command) =>
          command.mode === "task-notification" &&
          command.priority === selected.priority &&
          command.offPeakExecutionId === selected.offPeakExecutionId,
      );
      for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
        const command = commands[commandIndex];
        if (
          command?.mode === "task-notification" &&
          command.priority === selected.priority &&
          command.offPeakExecutionId === selected.offPeakExecutionId
        ) {
          commands.splice(commandIndex, 1);
        }
      }
      return Object.freeze(batch);
    },

    /**
     * 纯追加,不做去重、不设容量上限、不触发 drain。
     * 去重与幂等属于上层(CommandInbox / admission),队列只负责顺序。
     */
    enqueue(command: RuntimeCommand): void {
      commands.push(command);
    },

    /**
     * 只读地列出 rank <= maxPriority 的命令(不删除),供活动 loop 逐条判断
     * 哪些能被本轮吸收;返回冻结数组但元素可变,调用方不得改命令对象。
     */
    getByMaxPriority(maxPriority: RuntimeCommandPriority): readonly RuntimeCommand[] {
      const maxPriorityRank = RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority];
      return Object.freeze(
        commands.filter(
          (command) => RUNTIME_COMMAND_PRIORITY_ORDER[command.priority] <= maxPriorityRank,
        ),
      );
    },

    hasPending(): boolean {
      return commands.length > 0;
    },

    markCancelPending(id: RuntimeCommandId): void {
      cancelPendingCommandIds.add(id);
    },

    /**
     * 按 id 显式移除并返回该命令;找不到返回 undefined。
     * 用于活动 loop 吸收、用户删除排队项、lease 提升等"绕开优先级"的撤销;
     * 移除方负责决定被移除命令的 resolve/reject 收口。
     */
    removeById(id: RuntimeCommandId): RuntimeCommand | undefined {
      const index = commands.findIndex((command) => command.id === id);
      if (index === -1) return undefined;
      const [command] = commands.splice(index, 1);
      return command;
    },

    /** 当前排队条数(不含正在执行的命令);仅用于日志与忙闲判断。 */
    size(): number {
      return commands.length;
    },

    snapshot(): readonly RuntimeCommand[] {
      // 浅拷贝 + freeze 只保护数组结构;命令对象仍被队列持有,调用方只读。
      // 用途是 lease 匹配等"看不删"的场景,不能用它做决策后再依赖队列未变。
      return Object.freeze([...commands]);
    },
  };
}
