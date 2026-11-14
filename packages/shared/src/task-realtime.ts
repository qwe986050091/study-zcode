// INV-01 信封统一：守住位置 全部事件；改错故障：事件缺少工作区键，消费方无法路由。
// INV-02 身份优先：守住位置 键解析口径；改错故障：同一路径的远程与本地窗口串台。
// INV-03 原因必填：守住位置 失效事件；改错故障：前端无法判断是否需要补拉。
// INV-04 水印可选：守住位置 水印字段；改错故障：无流状态时被要求必须带水印。
// INV-05 目标三段：守住位置 镜像目标；改错故障：运行标识缺失导致镜像写错任务。
// INV-06 持有者可缺：守住位置 持有者字段；改错故障：未归属客户端时被强行填默认值。
// INV-07 区间连续：守住位置 批次序号；改错故障：前端无法检测丢片。
// INV-08 终止明确：守住位置 terminal；改错故障：运行结束后前端持续等待新批次。
// INV-09 租约同构：守住位置 租约目标；改错故障：镜像与租约两套目标字段漂移。
// INV-10 申请去重：守住位置 leaseRequestId；改错故障：重投申请被当成新请求。
// INV-11 结果判别：守住位置 成功与失败联合；改错故障：失败分支被当成已获取租约。
// INV-12 失败原因闭合：守住位置 原因字面量；改错故障：未知原因进入前端分支。
// INV-13 命令闭合：守住位置 所有者命令联合；改错故障：新增命令未被消费方处理。
// INV-14 命令去重：守住位置 commandRequestId；改错故障：重复投递导致权限被回复两次。
// INV-15 权限载荷：守住位置 回复字段；改错故障：选项与请求不匹配被宿主拒绝。
// INV-16 模式收窄：守住位置 命令队列分支；改错故障：不可回放客户端也能提升命令。
// INV-17 递送附源：守住位置 DeliveredEvent；改错故障：消费方无法识别事件来源主机。
// INV-18 用途可选：守住位置 deliveryPurpose；改错故障：观察者被当成中继所有者处理。
//
// 模块职责：任务实时事件的共享合约类型（旧协议兼容面）。
// 状态所有权：无状态；本文件只有类型声明，不含运行时代码。
// 阅读顺序：信封 → 失效事件 → 镜像与批次 → 租约 → 所有者命令 → 汇总联合。
/* oxlint-disable eslint(max-lines) -- task realtime 共享合约集中维护，类型和 schema 需要保持就近。 */
// ── 旧协议兼容面（过渡期）──────────────────────────────
// 剩余 18 个导出：realtime 事件/lease/owner-command 接口类型。
// 消费者：desktop taskRealtimeBus/taskRealtimeBridge、services sessionRealtimePort、
// shared channels.ts（旧 host 通道表）。
// 运行时 zod schema 与 resolveWorkspaceKey 已迁 task-realtime-core.ts（幸存面）；
// 基础传输类型（TaskRealtimeReason/TaskStreamMirrorOp/TaskStreamWatermark 等）已迁
// zcode-task-types-core.ts。本文件与旧 realtime 总线组同生命周期。
import type {
  ZCodeTaskClientMode,
  ZCodeTaskRuntimeCommand,
  ZCodeTaskMeta,
  TraceId,
  TaskRealtimeReason,
  TaskStreamWatermark,
  TaskStreamMirrorUserMessageOp,
  TaskStreamMirrorStreamEventOp,
  TaskStreamMirrorOp,
} from "./zcode-task-types-core.js";
import type { ZCodePermissionResponse } from "./zcode-protocol-legacy-types.js";
import type { WorkspaceHookReviewDecision } from "./zcode-protocol-v4/workspace-hook-review.js";

// 信封字段是所有实时事件的公共前缀。
// 身份优先于路径，键由两者共同解析。
//
export interface TaskRealtimeEnvelope {
  eventId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  traceId: TraceId;
  createdAt: number;
}

// 失效事件统一带原因与水印，前端据此判断是否补拉。
// 水印可选，缺失表示无流状态可参照。
//
export interface TaskRealtimeInvalidationBaseEvent extends TaskRealtimeEnvelope {
  reason: TaskRealtimeReason;
  streamWatermark?: TaskStreamWatermark;
}

// 快照失效只针对单个任务。
// 同一信封下的列表失效可以不带任务标识。
//
export interface TaskSnapshotInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "task_snapshot_invalidated";
  taskId: string;
}

export interface WorkspaceTaskListInvalidatedEvent extends TaskRealtimeInvalidationBaseEvent {
  type: "workspace_task_list_invalidated";
  taskId?: string;
  taskMeta?: ZCodeTaskMeta;
}

// 镜像目标同时定位工作区、任务与运行。
// 持有者字段可选，缺失表示尚未归属具体客户端。
//
export interface TaskStreamMirrorTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: TraceId;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
}

export type TaskStreamMirrorPublishOp =
  | TaskStreamMirrorUserMessageOp
  | TaskStreamMirrorStreamEventOp;

// TaskStreamMirrorBatchEvent 的 ops 携带 fromSeq..toSeq 连续区间，前端据此检测缺口。
// terminal 为真表示该 runId 不再有新批次。
// ownerClientId 与 ownerDeviceLabel 用于回显来源设备。
//
export interface TaskStreamMirrorBatchEvent extends TaskRealtimeEnvelope {
  type: "task_stream_mirror_batch";
  taskId: string;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}

export type TaskRealtimeDeliveryPurpose = "observer" | "relay_owner";

export type TaskRealtimeHostDeliveryKind = "desktop_window" | "relay_bridge";

// TaskRunLeaseTarget 与 TaskStreamMirrorTarget 同构，单独命名只为语义清晰。
// 申请请求在目标上追加请求标识用于去重。
//
export interface TaskRunLeaseTarget extends TaskStreamMirrorTarget {}

export interface TaskRunLeaseAcquireRequest extends TaskRunLeaseTarget {
  leaseRequestId: string;
}

// 结果是判别联合，成功与失败都回带请求标识。
// 失败只允许被其他主机持有这一种原因。
//
export type TaskRunLeaseResult =
  | { leaseRequestId: string; acquired: true; ownerHostId: string }
  | {
      leaseRequestId: string;
      acquired: false;
      ownerHostId: string;
      reason: "owned_by_other_host";
    };

// TaskOwnerCommandRequest 是闭合联合，新增命令必须同步消费方。
// 每条命令自带 commandRequestId，重复投递按幂等处理。
// 权限与征询命令分别带 permissionRequestId 与 elicitationRequestId，由宿主编排回复。
//
export type TaskOwnerCommandRequest =
  | {
      commandRequestId: string;
      type: "stop_generation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
    }
  | {
      commandRequestId: string;
      type: "respond_permission";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      permissionRequestId: string;
      optionId: string;
      response: ZCodePermissionResponse;
    }
  | {
      commandRequestId: string;
      type: "respond_elicitation";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      elicitationRequestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }
  | {
      commandRequestId: string;
      type: "respond_workspace_hook_review";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      remoteSessionId?: string;
      taskId: string;
      runId: string;
      sessionId: string;
      bundleDigest: string;
      reviewFlowId: string;
      generation: number;
      interactionId: string;
      decision: WorkspaceHookReviewDecision;
    }
  | {
      commandRequestId: string;
      type: "enqueue_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      taskCommand: Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
    }
  | {
      commandRequestId: string;
      type: "promote_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    }
  | {
      commandRequestId: string;
      type: "cancel_task_command";
      workspacePath: string;
      workspaceIdentity?: string;
      workspaceKey: string;
      taskId: string;
      runId: string;
      commandId: string;
      clientMode: Extract<ZCodeTaskClientMode, "web-remote-replayable">;
    };

export type TaskOwnerCommandDelivery = TaskOwnerCommandRequest & {
  requesterHostId: string;
};

export type TaskOwnerCommandErrorCode =
  | "NO_ACTIVE_TASK_OWNER"
  | "STALE_TASK_OWNER_COMMAND"
  | "OWNER_COMMAND_FAILED";

export type TaskOwnerCommandResult =
  | { commandRequestId: string; success: true; taskCommand?: ZCodeTaskRuntimeCommand }
  | {
      commandRequestId: string;
      success: false;
      error: string;
      code?: TaskOwnerCommandErrorCode;
    };

export type TaskRealtimeEvent =
  | TaskSnapshotInvalidatedEvent
  | WorkspaceTaskListInvalidatedEvent
  | TaskStreamMirrorBatchEvent;

export type TaskRealtimeDeliveredEvent = TaskRealtimeEvent & {
  originHostId: string;
  deliveryPurpose?: TaskRealtimeDeliveryPurpose;
};
