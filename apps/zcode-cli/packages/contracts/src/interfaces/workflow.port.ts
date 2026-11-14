// ============================================================
// Workflow Port - background workflow launch boundary
// ============================================================
//
// 【定位】这是 **legacy 脚本工作流**（`Workflow` 工具 / `/workflows`）的启动与查询边界，与
// `DynamicWorkflowRunPort`（新 dwf 引擎、`CreateWorkflow`）并列且不互相复用：前者把脚本复制进
// 会话目录并以 `wf_<uuid>` 为 run 身份，后者以 journal 的 `dwf_run` 为唯一事实家。实现体是
// bootstrap 的 `script-workflow-tool-port.ts`，消费者是 core 的 `Workflow` 工具 handler 与
// v4 的 `/workflows` 查询。
//
// 【所有权】`start` 一旦返回 `runId`，run 就已脱离当前 tool call：实现体给它单独的
// AbortController，父回合取消不中止它。因此本端口**没有 cancel 方法**——停止 legacy run 走
// 会话存储/命令面，而不是这里。
//
// 【同一性】`runId ≡ taskId ≡ WorkflowOutput.backgroundTaskId`：三处都是同一个 `wf_*` 串，
// 没有身份映射表；`resumeFromRunId` 复用的也是这个串。

import type { WorkflowInput, WorkflowOutput } from "../tools/workflow.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * 【契约坐标】`WorkflowInput` 的一半字段（`script` / `scriptPath` / `name` / `args` /
 * `resumeFromRunId`）是**来源选择**，恰好四选一；端口在此之上补执行上下文。生产者：core 的
 * `Workflow` 工具 handler 与 runtime 的启动路径；消费者：`script-workflow-tool-port` 的来源
 * 解析（内联脚本写成会话目录下的 `*.workflow.js`，文件/具名脚本先复制再执行）。`sessionId`
 * 决定脚本副本与 run 行的归属；`parentToolCallId` 只用于内联脚本的文件名与审计，不参与路由。
 */
export interface WorkflowStartRequest extends WorkflowInput {
  parentToolCallId: ToolCallId | string;
  sessionId: SessionId;
  trace: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
  workspaceRoot: string;
}

/**
 * 【契约坐标】`signal` 只覆盖**启动这一段**（校验脚本、抄写副本、提交 runtime），一旦
 * `start` 返回 runId 就不再对它生效：实现体另行创建 run 自己的 AbortController，父 turn 的
 * 取消不得顺带杀掉已后台化的 run。这是 legacy 端口与 dwf 端口（`cancel` 显式传 initiator）
 * 最容易混淆的一处，两个生命周期只有返回值里的 runId 相连。
 */
export interface WorkflowStartOptions {
  signal?: AbortSignal;
}

/**
 * 【契约坐标】五个值里有四个是引擎词汇（completed / failed / cancelled + running），`lost`
 * 是**读面的兜底**：会话存储里的 run 行状态缺席或落在未知列（pending / paused / 被升级前的
 * 老行）时，实现体把它归成 `lost`（见 `workflowTaskStatus`），而不是让查询失败。`running`
 * 因此是「非终态」的合并值，不能据此推断引擎内部的 pending/paused。生产者：`getTask` /
 * `waitForTask` 的行投影与启动内存快照；消费者：v4 的 `/workflows` 与后台任务追踪器。
 */
export type WorkflowTaskStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

/**
 * 【契约坐标】快照有**两个来源**，读序固定：先查会话存储里的 run 行，查不到才回落到启动时
 * 写下的内存 `launchSnapshots`——后者只覆盖「启动已返回、行尚未落库」的间隙，进程亡故即消失。
 * `runId` / `taskId` 是同一个 `wf_*` 串；`output` 只在终态才有；`error` 是失败消息的纯文本
 * （不是错误码）。`completedAt` 缺席 = 还在跑，不用读时兜底。生产者：`script-workflow-tool-port`
 * 的 `getWorkflowTaskSnapshot` 与完成 promise；消费者：`getTask` / `waitForTask` 的调用方。
 */
export interface WorkflowTaskSnapshot {
  completedAt?: Date;
  description?: string;
  error?: string;
  name?: string;
  output?: WorkflowOutput;
  runId: string;
  startedAt: Date;
  status: WorkflowTaskStatus;
  taskId: string;
}

/**
 * 【契约坐标】`start` 是唯一必选方法，其余三个可选：能力探测（`typeof port.getTask ===
 * "function"`）决定 UI 是否显示查询入口。`start` 的返回是**已后台化**的 `WorkflowOutput`
 * （status: "backgrounded"），不是执行结果本身；要拿结果必须经 `waitForTask`，它等待的是
 * 内存里的完成 promise（查不到就立刻返回当前快照，不悬挂）。生产者：bootstrap 的
 * `createScriptWorkflowToolPort`；消费者：core 的 `Workflow` handler、v4 与后台任务面。
 */
export interface WorkflowPort {
  start(request: WorkflowStartRequest, options?: WorkflowStartOptions): Promise<WorkflowOutput>;
  getTask?(taskId: string): Promise<WorkflowTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowTaskSnapshot | undefined>;
}
