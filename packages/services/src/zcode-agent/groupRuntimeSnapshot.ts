import {
  conversationTopicFrameSchema,
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SessionControl,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "#src/zcode-agent/zcodeAgent.js";

/** Bot 控制操作临时读取 CLI 权威快照，不建立第二份输入队列。 */
// Bot 侧只做一次只读观察：借用 CLI 权威快照，不建立第二份输入队列，
// 否则群聊控制会出现两个事实来源。
export function readBotGroupRuntimeSnapshot(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
): Promise<ConversationSnapshot> {
  return observeRuntime(agent, target, (frame) =>
    frame.payload.kind === "snapshot" ? frame.payload.snapshot : undefined,
  );
}

/** 只观察同一订阅的连续控制状态；停止 ACK 不是终态证据。 */
// 等待的是「某个 execution 真正结束」：必须结合控制状态与活跃工作身份，
// 不能把一次 stopping 的 ACK 当成终态证据。
export function waitBotGroupExecutionEnd(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
  executionId: string,
  signal?: AbortSignal,
): Promise<SessionControl> {
// [并发] 用 fromSeq/toSeq 串成连续区间：只观察同一订阅，
// 一旦序号断裂说明中间帧丢失，此时的状态不可信，必须立即失败。
  let seq: number | undefined;
// control 是推导结果而不是缓存事实：只在收到 state.updated 或快照时整体替换。
  let control: SessionControl | undefined;
  return observeRuntime(
    agent,
    target,
    (frame) => {
// 首帧建立基线：之后所有判定都相对这份快照推进，不另起状态。
      if (frame.payload.kind === "snapshot") {
        seq = frame.toSeq;
        control = frame.payload.snapshot.control;
      } else {
// [失败路径] 首帧必须是 snapshot（尚无 seq），之后每个 delta 帧必须紧邻上一帧；
// 断档时抛错而不是猜测，避免用不完整状态误判执行已结束。
        if (seq === undefined || frame.fromSeq !== seq) throw new Error("Topic stop control gap");
        seq = frame.toSeq;
// delta 按到达顺序逐个应用，只有 state.updated 才会改写 control。
        for (const delta of frame.payload.deltas) {
// 其他 op 的 delta 与执行结束判定无关，直接跳过，避免误读状态补丁。
          if (delta.op === "state.updated" && delta.patch.control) control = delta.patch.control;
        }
      }
// stopping 只是过程态：继续等待后续帧，不能在此提前返回。
      if (!control || control.stopState === "stopping") return undefined;
// 只看活跃工作列表：已完成的工作留在其他字段里，不参与本判定。
      const active = control.activeWorks;
      const stillRunning = active.some((work) => work.foregroundExecutionId === executionId);
      const identityKnown = active.length > 0 && active.every((work) => work.foregroundExecutionId);
// [权衡] 仅当所有活跃工作都带 foregroundExecutionId 时，身份才是可判定的；
// 存在匿名工作时只能依赖 stopState=idle 这一更强的终态信号。
// 两个条件同时成立才算结束：目标 execution 已不在跑，且控制层给出终态或可判定的身份视图。
      return !stillRunning && (control.stopState === "idle" || identityKnown) ? control : undefined;
    },
    signal,
  );
}

// 观察器统一承担订阅、超时、中断与释放，调用方只提供一个纯选择函数。
async function observeRuntime<T>(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
  select: (frame: ConversationTopicFrame) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
// [并发] 每次观察独立装配器：分片重组状态不能跨订阅复用，否则会串帧。
// schema 在此绑定，后续 accept 只处理已通过协议校验的帧。
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
// 首帧可能早于订阅 ACK 到达，先有界缓存；上限 128 防止异常流量占满内存。
  const early: ConversationTopicWireCandidate[] = [];
// 归属在 ACK 之前是未知的，因此它必须是可空状态而不是默认值。
  let subscriptionId: string | undefined;
  let resolveSnapshot!: (snapshot: T) => void;
  let rejectSnapshot!: (reason: unknown) => void;
  const snapshot = new Promise<T>((resolve, reject) => {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });
  // 订阅 ACK 可能晚于首帧送达；先注册监听，取得 ownership 后才解析缓存帧。
  void snapshot.catch(() => undefined);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const abort = () => rejectAbort(signal?.reason ?? new Error("Topic observation aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const accept = (wire: ConversationTopicWireCandidate): void => {
    if (wire.topic !== `conversation/${target.sessionId}`) return;
// [并发] 还没拿到 subscriptionId 时无法判定归属，只能暂存；
// 取得 ACK 后再按 subscriptionId 过滤重放，防止收到别的订阅的帧。
    if (!subscriptionId) {
      if (early.length < 128) early.push(wire);
      return;
    }
// 只接受本订阅的帧；同 session 的前后台订阅互不干扰。
    if (wire.subscriptionId !== subscriptionId) return;
    for (const event of assembler.accept(wire)) {
// [失败路径] 协议层 fault 直接终止观察，不上报半成品状态。
      if (event.kind === "fault") rejectSnapshot(new Error(event.fault.reasonCode));
      else {
        try {
          const selected = select(event.frame);
          if (selected !== undefined) resolveSnapshot(selected);
        } catch (error) {
          rejectSnapshot(error);
        }
      }
    }
  };
// 先注册监听再发起 subscribe，避免 ACK 与首帧之间的窗口丢事件。
  const listener = agent.onDynamicConversationFrame(target)(accept);
  let closed = false;
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
// 15s 上限同时覆盖订阅 ACK 与首帧，避免 Bot 侧无限等待一个不可用的运行时。
    timeout = setTimeout(() => reject(new Error("Group runtime snapshot timed out")), 15_000);
  });
// 释放是 best-effort：取消失败只影响后台订阅回收，不能反过来打断调用方结果。
  const release = (id: string) => {
    void agent.unsubscribeConversationV4({ ...target, subscriptionId: id }).catch(() => undefined);
  };
  try {
    // 超时必须覆盖订阅 ACK 本身；迟到的 ACK 仍要释放，不留下后台订阅。
    const subscribing = agent
      .subscribeConversationV4({ ...target, visibility: "background" })
      .then((result) => {
        if (closed) release(result.ack.subscriptionId);
        return result;
      });
    const result = await Promise.race([subscribing, deadline, aborted]);
// ACK 到达后立刻回放缓存帧：这些帧早于订阅建立，但归属已可确认。
    subscriptionId = result.ack.subscriptionId;
// splice 清空并逐个重放，保证同一帧不会被既当作 early 又被后续监听重复处理。
    for (const frame of early.splice(0)) accept(frame);
    return await Promise.race([snapshot, deadline, aborted]);
// [资源] 无论成功、超时还是中断，都在 finally 中拆除监听与订阅：
// 这里漏一个就会在每次观察后残留一个后台订阅。
  } finally {
    closed = true;
    signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
// 监听必须在订阅释放之前拆除，否则释放过程中的帧会被当成新事件处理。
    listener.dispose();
    if (subscriptionId) release(subscriptionId);
  }
}
