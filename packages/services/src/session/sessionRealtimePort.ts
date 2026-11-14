// 会话实时端口：屏蔽宿主差异（进程内/跨进程/远程）的统一通道，业务层只依赖该接口。
// 端口实现负责序列化与路由，接口本身不承诺投递顺序之外的任何语义。
import type {
  TaskOwnerCommandDelivery,
  TaskOwnerCommandRequest,
  TaskOwnerCommandResult,
  TaskRealtimeDeliveredEvent,
  TaskRealtimeEvent,
  TaskRealtimeHostDeliveryKind,
  TaskRunLeaseAcquireRequest,
  TaskRunLeaseResult,
  TaskRunLeaseTarget,
  TaskStreamMirrorPublishOp,
  TaskStreamMirrorTarget,
} from "@zcode/shared";

// hostId 标识当前宿主；同一事件的多次投递可用它做去重。
// 所有 publish* 方法都是“尽力而为”，失败不得抛出到业务调用栈。
export interface SessionRealtimePort {
  readonly hostId: string;
  readonly deliveryKind?: TaskRealtimeHostDeliveryKind;
// 广播任务事件：订阅方按事件类型自行过滤，端口不做业务级筛选。
  publish(event: TaskRealtimeEvent): void;
// 申请任务运行租约：同一任务同时只允许一个持有者，未拿到租约不得开始执行。
  acquireTaskRunLease(
    request: Omit<TaskRunLeaseAcquireRequest, "leaseRequestId">,
  ): Promise<TaskRunLeaseResult>;
// 释放租约必须幂等：重复释放或释放非本人持有的租约不得影响其他执行者。
  releaseTaskRunLease(target: TaskRunLeaseTarget): void;
// 流镜像操作按 target 路由，便于远端只订阅自己关心的任务流。
  publishStreamOp(target: TaskStreamMirrorTarget, op: TaskStreamMirrorPublishOp): void;
// 向任务持有者发起控制命令（停止/权限应答/排队等），返回结果而非抛错。
// commandRequestId 由端口补全，调用方只描述命令内容。
  requestOwnerCommand(
    command:
      | Omit<Extract<TaskOwnerCommandRequest, { type: "stop_generation" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "respond_permission" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "respond_elicitation" }>, "commandRequestId">
      | Omit<
          Extract<TaskOwnerCommandRequest, { type: "respond_workspace_hook_review" }>,
          "commandRequestId"
        >
      | Omit<Extract<TaskOwnerCommandRequest, { type: "enqueue_task_command" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "promote_task_command" }>, "commandRequestId">
      | Omit<Extract<TaskOwnerCommandRequest, { type: "cancel_task_command" }>, "commandRequestId">,
  ): Promise<TaskOwnerCommandResult>;
// 订阅事件流；返回的 dispose 必须只解除本次订阅，不能误删其他监听器。
  onDidReceiveEvent(listener: (event: TaskRealtimeDeliveredEvent) => void): {
    dispose(): void;
  };
// 持有者侧接收控制命令的入口；同一命令可能因重试重复到达，需按 ID 幂等处理。
  onDidReceiveOwnerCommand(listener: (command: TaskOwnerCommandDelivery) => void): {
    dispose(): void;
  };
// 回传命令执行结果，请求方按 commandRequestId 关联原请求。
  publishOwnerCommandResult(result: TaskOwnerCommandResult): void;
// 释放端口资源；之后不得再接收或发送任何事件。
  dispose(): void;
}
