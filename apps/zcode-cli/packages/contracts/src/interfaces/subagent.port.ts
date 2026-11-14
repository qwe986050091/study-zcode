// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================
//
// 【定位】父会话派生一个独立 child runtime 并取回结果的边界。实现体是 core 的
// `createExploreSubagentPort`（`subagent/runner.ts`），消费者是 `Agent` / `Explore` 工具
// handler、`SendMessage` 与后台任务面。端口不持久化任何东西：任务台账在进程内的
// RuntimeTaskRegistry，child 自己的事件/消息/trace 写在**子会话**里。
//
// 【所有权】父会话拥有 child：`parentToolCallId` 是父 timeline 上的锚，取消/停止沿它传播；
// child 只通过 `sendMessage` 回消息，不能反向路由。前台 child 的 signal 由调用方传入，后台
// child 由注册表持有 AbortController（`stopTask` 才动它）。
//
// 【三条身份】①持久化身份 = `childSessionId`（事件、消息、trace 的归属）；②交互身份 =
// 父会话（权限弹窗、AskUserQuestion、provider 请求头路由回父）；③可见性身份 = 父 timeline
// 只镜像摘要/工具活动，raw child 正文不得污染父 timeline，但外部 sink 仍收到 child 原始事件。

import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * 【契约坐标】三条身份边界在这里成形：`sessionId` 是**父会话**（不是 child 的持久身份，
 * child 会话由实现体派生并回填到快照）；`parentToolCallId` 是父 timeline 上的锚；
 * `agentType` 决定 profile、权限与工具面；`description` 是给父会话看的任务标题；`prompt`
 * 是 child 的首轮输入。生产者：core 的 `Agent` / `Explore` 工具 handler；消费者：runner 的
 * `runAgentToCompletion`。请求不写库，失败也不产生持久 run 行。
 */
export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

/**
 * 【契约坐标】`signal` 中止**本次 child 执行**（前台路径），不保留给后台 continuation；
 * `model` 是父 Agent Loop 不可变 Model 的继承值；`modelOverride` 是 Core Server 对前台 child
 * 的最高优先级 Selection，`background: "deny"` 同时是「强制前台、不得自动后台化」的开关。
 * 选择优先级是 profile > 父继承 > override，但 override 最终也收敛成标准 `ModelSelection`。
 * 这些值只在调用期有效，不写入子会话的持久配置。
 */
export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
}

/**
 * 【契约坐标】`launch` 的请求 = run 请求 + `runInBackground`。后台化的判据是**三选一**：
 * 显式 `true`、profile 的 `background` 为真、或调用方没有用 `modelOverride.background:
 * "deny"` 强制前台；实现体据此决定走 `run` 还是 `start`。因此同一份请求在 profile 不同的
 * agent 上会有不同的默认行为，`runInBackground: false` 也不保证前台。
 */
export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

/**
 * 【契约坐标】同义别名：`launch` 与 `start` 共用一套选项（signal / model / modelOverride），
 * 别名存在只是为了让调用点的意图可读，**不是**两套语义。新增选项必须同时被两条路径消费，
 * 否则会出现「前台生效、后台忽略」的静默分叉。
 */
export type SubagentLaunchOptions = SubagentRunOptions;

/**
 * 【契约坐标】`start` 专指**直接后台化**的入口，请求与 `run` 同形（没有 `runInBackground`
 * 开关）；返回 `AgentBackgroundedOutput`，任务身份由实现体登记进 RuntimeTaskRegistry。
 */
export type SubagentStartRequest = SubagentRunRequest;

/** 同义别名：`start` 与 `run` 共用同一套选项，语义见 {@link SubagentRunOptions}。 */
export type SubagentStartOptions = SubagentRunOptions;

/**
 * 【契约坐标】`signal` 只中止**这次等待**（立即以 reason 拒绝），**不**停止任务：任务继续在
 * 后台跑，之后仍可以再次 `waitForTask`。等到的是终态快照（registry 的 `waitForTerminal`）；
 * 任务不在注册表里时返回 `undefined` 而不是悬挂。
 */
export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

/**
 * 【契约坐标】`signal` 只中止**停止请求本身**（在发出前已 abort 则直接拒绝）；真正停止是
 * 把该 task 的 AbortController abort 并等它落到 `stopped` 快照。对已是终态的任务是幂等
 * no-op，返回原快照；任务不在注册表里返回 `undefined`。停止会传播到 child 会话的
 * 后台任务收尾，但不删除已写入的子会话历史。
 */
export interface SubagentStopOptions {
  signal?: AbortSignal;
}

/**
 * 【契约坐标】`to` 是**目标子代理的 agentId**（不是 sessionId）——同一子代理在停止后重新
 * 后台化时 taskId 会变，agentId 是跨这两次生命周期的稳定寻址键。`sessionId` /
 * `parentToolCallId` 是父侧路由上下文；`summary` / `message` 是给 child 的两段文本。
 * 生产者：core 的 `SendMessage` 工具 handler；消费者：runner 的
 * `sendMessageToLocalAgent`（按目标状态选择投递方式）。
 */
export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

/** 同义别名：发消息与启动共用同一套选项；后台 continuation 同样会用 modelOverride 决策。 */
export type SubagentSendMessageOptions = SubagentRunOptions;

/**
 * 【契约坐标】三种投递形态是**目标状态**的函数，不是调用方自选：`steered` = 目标有活跃 turn
 * 且 messageSink 可用，消息进入当前轮；`queued` = 没有 sink 或投递失败，消息留在注册表等
 * 下一个 tool round；`resumed_background` = 目标已停止（completed/failed/stopped 等），实现体
 * 用它把 agentId 重新后台化、以该消息作为新一轮输入。`queued` 是**唯一**保证不丢的形态；
 * `steered` 依赖当前轮能否接收，`resumed_background` 产生新的 taskId。
 */
export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

/**
 * 【契约坐标】`status` 只表达**是否已投递**（`success` 不等于目标已处理）；`messageId` 是本次
 * 消息的稳定 id；`delivery` 仅在 success 时在场，说明走的是哪条路（见
 * {@link SubagentSendMessageDelivery}）。`agentId` / `taskId` / `outputFile` 回显目标的当前
 * 身份——`resumed_background` 时 `taskId` 与 `outputFile` 是**新**的，调用方必须用返回值更新
 * 自己手里的句柄。`failed` 时 `error` 携带原因，消息没有进入任何投递路径。
 */
export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

/**
 * 【契约坐标】`running` 是唯一非终态；其余六个都是终态且互不覆盖。`completed` / `failed` 是
 * 执行结局，`cancelled` 是父侧取消传播，`killed` 是强制终止（如进程级清理），`stopped` 是
 * `stopTask` 的显式停止，`lost` 是注册表重启/丢失后的读面兜底。任务台账只在进程内，
 * 进程亡故后这些状态不会从持久存储重建——未完成即消失。
 */
export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

/**
 * 【契约坐标】快照是**进程内注册表的读时投影**，不是持久行：`taskId` 每次后台化都可能变，
 * `agentId` 是跨 continuation 稳定的寻址键，`childSessionId` 才是持久身份。`completedAt`
 * 缺席 = 非终态；`output` 只在终态且成功时在场，`outputFile` 是长输出的落盘路径；
 * `notified` 记录父会话是否已收到完成通知（与 `sealBackgroundTaskNotifications` 的封口
 * 顺序耦合，不能提前置真）。`pid` 只对子进程形态的子代理有意义。
 */
export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

/**
 * 【契约坐标】`launch` / `run` / `start` 是三个**入口语义**而不是三个实现：`launch` 按
 * profile 与 override 决定前台/后台，`run` 恒定前台并阻塞到 child 结算，`start` 恒定后台并
 * 立刻返回 `AgentBackgroundedOutput`。观察方法全部可选（能力探测决定 UI）：`getTask` 只读
 * 快照，`waitForTask` 等终态，`stopTask` 传播取消，`sendMessage` 向仍活着的或已停止的
 * agentId 投递。端口不提供持久化、不提供跨进程恢复——任务消失即消失，这是与
 * `DynamicWorkflowRunPort`（journal 为家）最根本的区别。
 */
export interface SubagentPort {
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
