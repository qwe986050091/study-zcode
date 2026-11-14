import type { ZCodeProcessDiagnostic } from "@zcode/shared/process-diagnostic";

// 生命周期事件的共同约定：字段全部由上报方在事件发生时刻采集，消费方不做二次推断。
// 事件只描述「已发生的事实」，不承载控制语义，因此不会因消费失败而回滚进程状态。
export interface RuntimeProcessSpawnEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

// ready 表示进程已握手可用，是一次性事件；超时未 ready 的进程仍可能先产生 exit 事件。
// startupDurationMs 由上报方按 startedAt 计算，避免跨时钟源带来的偏差。
export interface RuntimeProcessReadyEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  readyAt: number;
  // 仅统计到 ready 为止的耗时，不包含后续交互，便于单独观测冷启动性能。
  startupDurationMs: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

// exit 是终态事件，每个成功 spawn 的进程都应恰好上报一次，即便退出码为空也要上报。
// uptimeMs 以进程启动为基准，用于区分「启动即崩」与「运行期崩溃」两类故障。
export interface RuntimeProcessExitEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endedAt: number;
  // 退出归因：expected 为主动关闭，unexpected 为崩溃，watchdog_recycle 为看门狗回收，后者常伴随重启。
  terminationKind: "expected" | "unexpected" | "watchdog_recycle";
  terminationReason?: string;
  // runtimeReady 标记退出前是否完成过握手，用于把「从未就绪」与「就绪后中断」分开统计。
  runtimeReady: boolean;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  uptimeMs: number;
  stderrLineCount: number;
  // 只保留尾部若干行：完整 stderr 可能极大，全量上报会撑爆事件通道。
  stderrTail?: string[];
}

// error 覆盖 spawn 失败与运行期异常两类，pid 可能为空，因此不能据此关联进程记录。
// 它与 exit 不是互斥关系：某些实现会先报 error 再走 exit，消费方需按 pid 去重。
export interface RuntimeProcessErrorEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number | null;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  errorName: string;
  errorCode?: string;
  errorMessage: string;
  errorStack?: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  occurredAt: number;
}

// 上报接口只在 onSpawn 与 onExit 上强制，ready、error、exception 可选，便于轻量宿主只实现必要部分。
// 实现必须快速返回：这些回调位于进程事件链路上，长耗时操作应转交后台队列。
export interface RuntimeProcessLifecycleReporter {
  onSpawn(event: RuntimeProcessSpawnEvent): void;
  onReady?(event: RuntimeProcessReadyEvent): void;
  onExit(event: RuntimeProcessExitEvent): void;
  onError?(event: RuntimeProcessErrorEvent): void;
  onException?(event: RuntimeProcessExceptionEvent): void;
}

// exception 用于捕获未归入普通 error 的严重异常（如 watchdog 发现的状态机越界），附带诊断快照。
// diagnostic 由产生方填充，消费方只读；缺失上下文的宿主可忽略该事件而不影响主流程。
export interface RuntimeProcessExceptionEvent {
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  // 诊断信息取自共享类型，保证与诊断面板的字段口径一致，避免各处自定义结构。
  diagnostic: ZCodeProcessDiagnostic;
}

// 任务数变化事件只表达最新计数，不保证逐次可加；消费方应整体覆盖而非累加。
export interface RuntimeTaskCountChangedEvent {
  runningTaskCount: number;
}

// 任务上报与进程上报分离：任务数由运行时自行统计，宿主无需理解进程细节。
// 该接口无返回值，实现不得反向阻塞运行时调度。
export interface RuntimeTaskReporter {
  onRunningTaskCountChanged(event: RuntimeTaskCountChangedEvent): void;
}
