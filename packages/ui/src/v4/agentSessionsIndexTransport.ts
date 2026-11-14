// sessions-index 传输面（desktop/host 实现）：桥到 IZCodeAgentService 的 v4 sessions-index 转发面
// （与 agentConversationTransport 同构；web 直连 relay 时换实现即可）。
// INV-01 每个传输实例只服务单个 workspace 目标，topic 由 identity 优先于 path 派生；守住位置：createAgentSessionsIndexTransport 内 topic 与 targetWorkspaceKey；改错故障：跨 workspace 帧串流到错误会话
// INV-02 握手必须先于任何 subscribe/resync/unsubscribe 的 RPC；守住位置：ensureHandshake 及各方法入口；改错故障：未初始化连接直接报错或帧永不抵达
// INV-03 subscribe 期间 barrier 必须先占位，成功后才按 ack 的 subscriptionId 绑定；守住位置：subscribe 主路径；改错故障：旧订阅帧混入新订阅初始态
// INV-04 ACK 越界、绑定失败或任意异常都必须取消占位；守住位置：subscribe 的 catch 与 bind 失败分支；改错故障：屏障泄漏 pending，后续订阅永远等不到激活
// INV-05 绑定失败还要回滚远端订阅；守住位置：subscribe 内的退订清理；改错故障：host 侧残留无人释放的订阅并持续推送帧
// INV-06 runtimeGeneration 变化必须让在途 subscribe 判废；守住位置：subscribeRuntimeGeneration 比对；改错故障：把重启前 ack 当成有效订阅，界面停在死连接
// INV-07 只有 activate 成功才记录 activeSubscriptionId；守住位置：activate 分支；改错故障：未激活的订阅号被当作自有，重同步打到错误目标
// INV-08 resync 前必须比对 activeSubscriptionId；守住位置：resync 的 ownership 校验；改错故障：为其他实例的订阅请求快照，破坏对方序号
// INV-09 resync 先让解码器进入恢复态再发远端请求；守住位置：resync 中 recover 与 RPC 的先后；改错故障：快照替换与旧序号错位，界面丢消息
// INV-10 unsubscribe 必须先本地释放 ownership 与解码缓冲，再握手与远端退订；守住位置：unsubscribe 前三行；改错故障：失效 service proxy 继续投帧到已卸载视图
// INV-11 onFrame 首个监听者触发上游订阅，最后一个注销时同步释放；守住位置：onFrame 的懒创建与清理；改错故障：重复注册出第二条上游，帧被投递两次
// INV-12 装配失败只经 faultListeners 广播；守住位置：createTopicWireDecoder 的 fault 回调；改错故障：半成品帧进入业务回调，列表闪回残缺数据
// INV-13 重启事件必须按 workspaceKey 过滤；守住位置：onRuntimeRestart 的事件回调；改错故障：其他 workspace 的重启清空本实例状态
// INV-14 重启时必须同时清空 barrier、decoder 与 activeSubscriptionId；守住位置：重启与生命周期回调；改错故障：三者部分清理导致旧缓冲与新订阅混用
// INV-15 activate 切换订阅时丢弃上一条订阅的解码缓冲；守住位置：activate 的 previousSubscriptionId 分支；改错故障：旧 physical batch 残留并污染新订阅
// INV-16 帧监听与故障监听使用独立集合；守住位置：listeners 与 faultListeners；改错故障：注销一个监听者影响其他监听者的投递
// INV-17 生命周期通道缺失时传输面仍可用；守住位置：返回对象中的条件展开；改错故障：强制依赖可选能力，宿主较旧版本直接不可用
// INV-18 所有清理路径幂等，重复 unsubscribe 或重复 dispose 不得抛错；守住位置：注销函数与 barrier、decoder 的清理；改错故障：组件卸载时异常冒泡打断后续清理
//
// 文件定位：v4 sessions-index 的传输适配层，把 IZCodeAgentService 的订阅、重同步、退订封装成带本地状态的传输面。
// 关键链路：握手、屏障占位、远端订阅、ack 绑定、激活、帧解码投递，任一步失败或运行时重启都要回滚到干净初态。
// 阅读顺序：先看 INV 列表与四个生命周期方法，再看三个监听注册函数的引用计数释放。
import type { IZCodeAgentService } from "@zcode/services";
import {
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type ConversationResyncParams,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type TopicFrameDeliveryKind,
  type V4ConversationResyncResult,
  type V4SessionsIndexSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionsIndexTopic } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createAckActivationBarrier } from "@/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "@/v4/topicWireDecoder.js";

// 四段生命周期需成对使用：subscribe 配 unsubscribe，activate 配 resync
// onRuntimeLifecycle 为可选成员，宿主未提供时调用方按不支持处理
export interface SessionsIndexTransport {
  subscribe(params: {
    base?: { logEpoch: string; seq: number };
    visibility?: "foreground" | "background";
  }): Promise<V4SessionsIndexSubscribeResult>;
  activate(subscriptionId: string): void;
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onFrame(
    listener: (
      frame: SessionsIndexTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  onRuntimeRestart(listener: () => void): () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
}

// [权衡] workspacePath 必填，workspaceIdentity 只在远程或隔离场景出现
// 身份 key 由 identity 去空白优先、缺省回落 path，由创建函数统一派生
export interface AgentSessionsIndexTransportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// [权衡] 五个方法为硬依赖：订阅、重同步、退订、动态帧与重启通知缺一不可
// 握手与生命周期为可选依赖，缺失时由 ensureHandshake 返拒绝而非编译期失败
type SessionsIndexV4AgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<
    Pick<
      IZCodeAgentService,
      "helloConversationV4" | "initializeConversationV4" | "onAgentRuntimeLifecycle"
    >
  >;

/** 一条 host 连接（= 一个 workspace）上的 sessions-index 传输面。 */
// 创建单个 workspace 的传输面，所有可变状态封闭在闭包内，不跨实例共享
// [并发] 同一实例的四个生命周期方法可交错调用，状态迁移依赖屏障串行化
// 返回对象是唯一对外句柄，调用方不应保留 agentService 自行发请求
export function createAgentSessionsIndexTransport(
  agentService: SessionsIndexV4AgentService,
  target: AgentSessionsIndexTransportTarget,
): SessionsIndexTransport {
  // 请求体统一带 workspacePath，identity 有值时才展开
  // [权衡] 用条件展开而非赋 undefined，保证请求 JSON 不出现空 identity 字段
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  // [失败路径] 缺少任一握手方法直接拒绝，错误码 handshakeUnavailable 供上层区分
  // 每个生命周期方法都重新确认握手，重复调用由握手模块自身去重
  const ensureHandshake = () => {
    if (!agentService.helloConversationV4 || !agentService.initializeConversationV4) {
      return Promise.reject(new Error("fault.connection.handshakeUnavailable"));
    }
    return ensureAgentV4ConnectionHandshake(
      agentService as Pick<IZCodeAgentService, "helloConversationV4" | "initializeConversationV4">,
    );
  };
  // topic 与 targetWorkspaceKey 使用同一优先级，帧路由与重启过滤口径一致
  // identity 先 trim 再判空，全空白视为未提供，回落到 workspacePath
  const topic = sessionsIndexTopic(target.workspaceIdentity?.trim() || target.workspacePath);
  // [资源] 帧监听用 Set 保持插入顺序并天然去重，同一函数只投递一次
  // 集合为空是释放上游订阅的唯一判据，见 onFrame 的注销分支
  const listeners = new Set<
    (
      frame: SessionsIndexTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void
  >();
  const faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  const restartListeners = new Set<() => void>();
  const runtimeLifecycleListeners = new Set<
    (state: "available" | "unavailable") => void
  >();
  // 解码器把 wire 候选装配成 schema 校验后的帧，再统一分发给帧监听者
  // [事务] 装配失败只走 fault 回调，不会以半成品帧触发业务回调
  // deliveryKind 随帧透传，调用方据此区分实时投递与重放补齐
  const decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
    (frame: SessionsIndexTopicFrame, deliveryKind) => {
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of faultListeners) listener(fault);
    },
  );
  // 激活屏障按 topic 给候选帧排队，等订阅 ack 到达后才允许解码
  // [并发] 多个在途 subscribe 各自持有 pending 句柄，互不覆盖
  // [失败路径] 绑定越界时由 subscribe 捕获并回滚远端订阅，屏障不静默吞帧
  const barrier = createAckActivationBarrier<SessionsIndexTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });
  // [资源] 帧、重启、生命周期三条上游句柄各自独立，任一通道缺席都不影响其余释放
  let upstream: { dispose(): void } | null = null;
  let restartUpstream: { dispose(): void } | null = null;
  let lifecycleUpstream: { dispose(): void } | null = null;
  let activeSubscriptionId: string | null = null;
  let runtimeGeneration = 0;
  // 重启与生命周期事件的过滤键，与 topic 构造同表达式，避免两处口径漂移
  // 比较用原始字符串相等，不做路径规范化，要求 host 侧同源
  const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  return {
    // [事务] 顺序固定：握手、占位、远端订阅、校验代数、绑定 ack
    // [并发] 占位早于 RPC 发出，保证 ack 之前的物理批次有归属可挂
    // [失败路径] 任一步抛错都会在 catch 中取消占位，调度器不残留空 pending
    async subscribe(params) {
      await ensureHandshake();
      const pending = barrier.begin(topic);
      const subscribeRuntimeGeneration = runtimeGeneration;
      try {
        const result = await agentService.subscribeSessionsIndexV4({
          ...workspace,
          runtimePolicy: "existing-only",
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        });
        // [并发] 订阅返回时若已发生运行时重启，ack 属于旧运行时，必须判废
        // 判废路径先取消占位再抛 runtimeRestarted，调用方可据此重新订阅
        if (subscribeRuntimeGeneration !== runtimeGeneration) {
          barrier.cancel(pending);
          throw new Error("fault.subscription.runtimeRestarted");
        }
        try {
          // [事务] 绑定成功才意味着初始快照可被激活，此前帧只排队不投递
          // [失败路径] 越界即 ACK 前批次超出容量，残缺初始态不可用于激活 store
          // 回滚退订失败只记 warn 并继续抛原错误，避免掩盖真正的绑定异常
          barrier.bind(pending, result.ack.subscriptionId);
        } catch (error) {
          // ACK 前 physical batch 越界后不能用残缺初始态激活 store。
          try {
            await agentService.unsubscribeSessionsIndexV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
              runtimePolicy: "existing-only",
            });
          } catch (cleanupError) {
            logger.warn("[v4-sessions-index] failed to undo rejected subscription", cleanupError);
          }
          throw error;
        }
        return result;
      } catch (error) {
        barrier.cancel(pending);
        throw error;
      }
    },
    // 激活成功后记录 activeSubscriptionId，作为后续 resync 的 ownership 凭据
    // [资源] 切换订阅时丢弃上一条订阅的解码缓冲，旧 physical batch 不再参与装配
    // 激活返回空值时视为无效，owner 不更新，旧订阅状态保持不变
    activate(subscriptionId) {
      const activation = barrier.activate(subscriptionId);
      if (activation) activeSubscriptionId = subscriptionId;
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
      }
    },
    // [事务] 先让解码器进入恢复态再请求远端，快照替换与序号续接由此衔接
    // [权衡] forceSnapshot 只有显式传入才展开，默认交给服务端按 base 判断
    async resync(params) {
      await ensureHandshake();
      if (activeSubscriptionId !== params.subscriptionId) {
        throw new Error("fault.subscription.notOwned");
      }
      decoder.recover(topic, params.subscriptionId);
      return agentService.resyncSessionsIndexV4({
        ...workspace,
        subscriptionId: params.subscriptionId,
        base: params.base,
        runtimePolicy: "existing-only",
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      });
    },
    // [资源] 本地 ownership 与解码缓冲先释放，之后即使握手失败也不再投帧
    // [失败路径] 远端退订的错误仍抛给调用方，不吞掉 host 侧失败
    async unsubscribe(subscriptionId) {
      // 本地 ownership 先释放；旧 service proxy 的 handshake/RPC 已失败时也不能继续投帧。
      barrier.forget(subscriptionId);
      // [事务] 只清本实例持有的订阅号，其他实例的退订请求不得改动 owner 归属
      if (activeSubscriptionId === subscriptionId) activeSubscriptionId = null;
      decoder.discard(topic, subscriptionId);
      await ensureHandshake();
      return agentService.unsubscribeSessionsIndexV4({
        ...workspace,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    },
    // [资源] 首个监听者懒创建上游订阅，返回的注销函数按引用计数释放
    // 最后一个监听者移除时同步 dispose 并置空，防止产生第二条上游
    onFrame(listener) {
      listeners.add(listener);
      upstream ??= agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        barrier.accept(frame),
      );
      return () => {
        listeners.delete(listener);
        // [资源] 集合清空才释放上游，晚一步注销的组件仍能收到在途帧而不致断流
        if (listeners.size === 0) {
          upstream?.dispose();
          upstream = null;
        }
      };
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    // [并发] 事件按 workspaceKey 过滤，其他 workspace 的重启不触达本实例监听者
    // [事务] 重启时递增代数并清空屏障、解码器与 owner，三者必须同时完成
    onRuntimeRestart(listener) {
      restartListeners.add(listener);
      restartUpstream ??= agentService.onAgentRuntimeRestarted((event) => {
        if (event.workspaceKey !== targetWorkspaceKey) return;
        runtimeGeneration += 1;
        barrier.clear();
        decoder.clear();
        activeSubscriptionId = null;
        for (const restartListener of restartListeners) restartListener();
      });
      return () => {
        restartListeners.delete(listener);
        if (restartListeners.size === 0) {
          restartUpstream?.dispose();
          restartUpstream = null;
        }
      };
    },
    ...(agentService.onAgentRuntimeLifecycle
      ? {
          // [权衡] 该成员按宿主能力条件展开，未提供 onAgentRuntimeLifecycle 时对象上不存在
          // 生命周期与重启共用代数递增与清理逻辑，只是回调参数不同
          onRuntimeLifecycle(listener: (state: "available" | "unavailable") => void) {
            const lifecycleListeners = runtimeLifecycleListeners;
            lifecycleListeners.add(listener);
            lifecycleUpstream ??= agentService.onAgentRuntimeLifecycle?.((event) => {
              if (event.workspaceKey !== targetWorkspaceKey) return;
              runtimeGeneration += 1;
              barrier.clear();
              decoder.clear();
              activeSubscriptionId = null;
              for (const lifecycleListener of lifecycleListeners) {
                lifecycleListener(event.state);
              }
            }) ?? null;
            return () => {
              lifecycleListeners.delete(listener);
              if (lifecycleListeners.size === 0) {
                lifecycleUpstream?.dispose();
                lifecycleUpstream = null;
              }
            };
          },
        }
      : {}),
  };
}
