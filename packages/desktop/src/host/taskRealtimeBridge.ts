// INV-01 非 InitLocal 返回空：守住位置 type 比较；改错故障 远端模式误建通道。
// INV-02 缺 hostId 返回空：守住位置 判空；改错故障 桥无法与 main 关联。
// INV-03 deliveryKind 随桥固化：守住位置 构造参数；改错故障 同一 Host 出现两条通道。
// INV-04 边界先过共享 schema：守住位置 safeParse；改错故障 非法跨进程消息进入分派。
// INV-05 回包只认 requestId：守住位置 pending map；改错故障 迟到回包影响其它请求。
// INV-06 找不到 pending 即丢弃：守住位置 早退；改错故障 重复回包触发两次结算。
// INV-07 租约与命令结果分开存放：守住位置 两个 Map；改错故障 请求类型互相串。
// INV-08 事件去重有界：守住位置 rememberEventId；改错故障 内存线性增长。
// INV-09 FIFO 淘汰最旧：守住位置 shift；改错故障 新事件被误判重复。
// INV-10 去重失败停止分发：守住位置 返回 false；改错故障 同一事件投递两次。
// INV-11 投递类才 fan-out：守住位置 两个 deliver 分支；改错故障 回包被当事件广播。
// INV-12 dispose 拒绝全部 pending：守住位置 两个循环；改错故障 调用方永久挂起。
// INV-13 dispose 摘掉监听：守住位置 off；改错故障 关闭后仍有回调。
// INV-14 dispose 幂等：守住位置 disposed 早退；改错故障 重复清理抛错。
// INV-15 写操作在 dispose 后静默：守住位置 各方法早退；改错故障 关闭后仍 postMessage。
// INV-16 监听器返回可释放句柄：守住位置 闭包 delete；改错故障 订阅泄漏。
// INV-17 租约请求生成唯一 id：守住位置 createUuid；改错故障 并发请求互相覆盖。
// INV-18 事件监听同样受 disposed 约束：守住位置 早退；改错故障 关闭后仍注册。
//
// 模块职责：在 Host 与 main 之间中继任务实时事件、租约与 owner command。
// 状态所有权：listener 集合与两个 pending 映射随桥创建与销毁。
// 阅读顺序：先看构造入口，再看消息分派，最后看销毁。
// Host 侧任务实时通道桥（parentPort ↔ main）。
//
// 职责：在 Host 进程与 main 进程之间中继任务实时事件与租约请求：publish/stream op 单向发往
// main，acquire/release lease 与 owner command 通过 requestId 关联的 pending map 做双向 RPC。
// 输入输出：createTaskRealtimeBridgeForHostInit 从 InitLocal 消息派生桥（非 InitLocal 或
// 缺 hostId 返回 null）；createTaskRealtimeBridge 返回 SessionRealtimePort 合约实现。
// 副作用：监听 parentPort "message"，向 parentPort postMessage；会创建 pending promise。
// 失败语义：dispose 后所有写操作静默返回、请求类直接 reject；dispose 时必须 reject 所有
// pending，不能留下永远悬空的 Promise。
// 维护的不变量：#18 的 deliveryKind 随桥固化（default desktop_window），同一 Host 实例只
// 有一条 realtime 通道；事件按 eventId 去重且缓存窗口有上限，dispose 后不再向 listener 分发。

import type { SessionRealtimePort } from "@zcode/services";
import {
  type TaskRealtimeHostDeliveryKind,
  createUuid,
  type TaskOwnerCommandDelivery,
  type TaskOwnerCommandResult,
  type TaskRealtimeDeliveredEvent,
  type TaskRealtimeEvent,
  type TaskRunLeaseResult,
  HostMessageTypes,
  HostResponseTypes,
  hostIncomingMessageSchema,
} from "@zcode/shared";

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface HostInitLike {
  type: string;
  hostId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
}

const DEFAULT_SEEN_EVENT_LIMIT = 1000;

// 按 Host 初始化消息构造实时桥。
// 仅 InitLocal 需要 realtime 通道；其他 init（如纯 remote）返回 null 表示「本 Host 不提供」。
// hostId 是桥的身份锚点，缺失时无法与 main 侧关联，因此同样返回 null 而不是抛错。
// 输出：SessionRealtimePort | null；调用方据 null 跳过实时能力注册。
// 只有 InitLocal 建立通道。
// 缺 hostId 返回空。
// deliveryKind 原样下传。
// 返回 null 时调用方跳过 registerSessionRealtimePort，实时能力按不可用处理。
export function createTaskRealtimeBridgeForHostInit(
  message: HostInitLike,
  parentPort: ParentPortLike,
): SessionRealtimePort | null {
  if (message.type !== HostMessageTypes.InitLocal) {
    return null;
  }
  if (!message.hostId) {
    return null;
  }

  return createTaskRealtimeBridge({
    hostId: message.hostId,
    deliveryKind: message.deliveryKind,
    parentPort,
  });
}

// 创建任务实时桥实例。
// 状态：两个 listener 集合（事件 / owner command）、两个 requestId→pending 映射
//（lease / owner command）、一个有界 seen event 集合；disposed 标志控制所有入口。
// 输入：hostId（必填）、deliveryKind（#18：区分 desktop_window 与远端重放通道）、
// parentPort、seenEventLimit（测试可注入，最小 1）。
// 副作用：注册 parentPort message 监听；方法调用会 postMessage。
// 失败语义：dispose 幂等；dispose 时 reject 全部 pending 并摘掉监听，重复 dispose 为 no-op。
// 维护的不变量：同一 eventId 只分发一次（FIFO 淘汰）；租约/命令结果必须匹配 requestId，
// 找不到 pending 的回包直接丢弃（迟到或重复回包不得影响其他请求）。
// 事件与命令监听分开。
// 两个 pending 映射分开。
// 去重窗口有界。
// disposed 控制所有入口。
export function createTaskRealtimeBridge(params: {
  hostId: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  parentPort: ParentPortLike;
  seenEventLimit?: number;
}): SessionRealtimePort {
  const listeners = new Set<(event: TaskRealtimeDeliveredEvent) => void>();
  const ownerCommandListeners = new Set<(command: TaskOwnerCommandDelivery) => void>();
  const pendingLeaseRequests = new Map<
    string,
    {
      resolve(result: TaskRunLeaseResult): void;
      reject(error: Error): void;
    }
  >();
  const pendingOwnerCommands = new Map<
    string,
    {
      resolve(result: TaskOwnerCommandResult): void;
      reject(error: Error): void;
    }
  >();
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const seenEventLimit = Math.max(1, params.seenEventLimit ?? DEFAULT_SEEN_EVENT_LIMIT);
  let disposed = false;

  // 记录 eventId 并返回是否为首次出现。
  // 去重窗口用 FIFO 而非时间：超出 seenEventLimit 时同步淘汰最旧 id，保证内存与乱序回包
  // 都能被有界处理；返回 false 时调用方必须停止向下游分发。
  // seenEventIds.has(eventId) 命中即判重复，因此这里直接 return false 而不写任何状态。
  // 写入后 while 循环按 seenEventLimit 淘汰最旧 id，保证去重窗口有界。
  // 淘汰时同步 seenEventOrder.shift() 并 delete 索引，避免两份结构漂移。
  const rememberEventId = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      return false;
    }

    seenEventIds.add(eventId);
    seenEventOrder.push(eventId);

    while (seenEventOrder.length > seenEventLimit) {
      const removed = seenEventOrder.shift();
      if (removed) {
        seenEventIds.delete(removed);
      }
    }

    return true;
  };

  // 单入口消息分派：先过共享 schema（跨进程边界必须校验），再按 type 路由。
  // 回包类消息只 resolve 对应 pending，找不到就丢弃；投递类消息（owner command / realtime）
  // 才 fan-out 给 listener。dispose 后的消息一律忽略，避免桥关闭后仍有回调。
  // 先校验共享 schema。
  // 回包只结算对应 pending。
  // 投递类才广播。
  const onMessage = (messageEvent: { data: unknown }) => {
    if (disposed) {
      return;
    }

    const parsed = hostIncomingMessageSchema.safeParse(messageEvent.data);
    if (!parsed.success) {
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskRunLeaseResult) {
      const pending = pendingLeaseRequests.get(parsed.data.result.leaseRequestId);
      if (!pending) {
        return;
      }
      pendingLeaseRequests.delete(parsed.data.result.leaseRequestId);
      pending.resolve(parsed.data.result);
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskOwnerCommandResult) {
      const pending = pendingOwnerCommands.get(parsed.data.result.commandRequestId);
      if (!pending) {
        return;
      }
      pendingOwnerCommands.delete(parsed.data.result.commandRequestId);
      pending.resolve(parsed.data.result);
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskOwnerCommandDeliver) {
      for (const listener of ownerCommandListeners) {
        listener(parsed.data.command);
      }
      return;
    }

    if (parsed.data.type === HostMessageTypes.TaskRealtimeDeliver) {
      // host typecheck 之前未覆盖 realtime bridge，schema 推导里 stream event payload 比
      // TaskRealtimeDeliveredEvent 合约更宽。这里在消息通过共享 schema 校验后收口到共享合约，
      // 保持 desktop continuous 与 web remote replayable 仍走同一条 delivery 边界。
      // 同时把 eventId 去重缓存限制在固定窗口内，避免异常高频 relay 把 host 内存线性吃满。
      const event = parsed.data.event as TaskRealtimeDeliveredEvent;
      if (!rememberEventId(event.eventId)) {
        return;
      }

      for (const listener of listeners) {
        listener(event);
      }
    }
  };

  params.parentPort.on("message", onMessage);

  return {
    hostId: params.hostId,
    deliveryKind: params.deliveryKind ?? "desktop_window",
    publish(event: TaskRealtimeEvent): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskRealtimePublish,
        event,
      });
    },
    acquireTaskRunLease(request): Promise<TaskRunLeaseResult> {
      if (disposed) {
        return Promise.reject(new Error("task realtime bridge disposed"));
      }
      const leaseRequestId = createUuid();
      return new Promise((resolve, reject) => {
        pendingLeaseRequests.set(leaseRequestId, { resolve, reject });
        params.parentPort.postMessage({
          type: HostResponseTypes.TaskRunLeaseAcquire,
          request: {
            ...request,
            leaseRequestId,
          },
        });
      });
    },
    releaseTaskRunLease(target): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskRunLeaseRelease,
        target,
      });
    },
    publishStreamOp(target, op): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskStreamOpPublish,
        target,
        op,
      });
    },
    requestOwnerCommand(command): Promise<TaskOwnerCommandResult> {
      if (disposed) {
        return Promise.reject(new Error("task realtime bridge disposed"));
      }
      const commandRequestId = createUuid();
      return new Promise((resolve, reject) => {
        pendingOwnerCommands.set(commandRequestId, { resolve, reject });
        params.parentPort.postMessage({
          type: HostResponseTypes.TaskOwnerCommandRequest,
          command: {
            ...command,
            commandRequestId,
          },
        });
      });
    },
    onDidReceiveEvent(listener): { dispose(): void } {
      if (disposed) {
        return { dispose: () => {} };
      }
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    onDidReceiveOwnerCommand(listener): { dispose(): void } {
      if (disposed) {
        return { dispose: () => {} };
      }
      ownerCommandListeners.add(listener);
      return {
        dispose: () => {
          ownerCommandListeners.delete(listener);
        },
      };
    },
    publishOwnerCommandResult(result): void {
      if (disposed) {
        return;
      }
      params.parentPort.postMessage({
        type: HostResponseTypes.TaskOwnerCommandResult,
        result,
      });
    },
    // 桥销毁：置 disposed 后拒绝所有等待中的租约/命令请求（否则调用方无限挂起），
    // 清空 listener 与去重缓存，并摘掉 parentPort 监听；幂等，重复调用直接返回。
    // dispose 入口先判 disposed，重复调用直接 return 以实现幂等。
    // 拒绝全部 pending。
    // 摘掉监听并清缓存。
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      const error = new Error("task realtime bridge disposed");
      for (const pending of pendingLeaseRequests.values()) {
        pending.reject(error);
      }
      for (const pending of pendingOwnerCommands.values()) {
        pending.reject(error);
      }
      pendingLeaseRequests.clear();
      pendingOwnerCommands.clear();
      listeners.clear();
      ownerCommandListeners.clear();
      seenEventIds.clear();
      seenEventOrder.length = 0;
      params.parentPort.off("message", onMessage);
    },
  };
}
