// Window Host 对 sessions-index V4 主题的「被动观察器」。
//
// 它不复用窗口 controller 的 attachment，而是以 window-controller scope 单独订阅：
// 使用 existing-only 运行时策略（缺 runtime 就保持 dormant，不主动拉起 Agent），
// 收到 snapshot/增量后只维护一份 SessionSummary 投影并通过 onSessionsChange 上报。
//
// 序号语义（与 #18 的 seq 口径同源）：cursor = { logEpoch, seq }，只有 fromSeq 连续才应用增量，
// 不连续或组装超时即 requestRecovery（forceSnapshot 重同步）；runtime 换代（generation 自增）
// 会清空 cursor 与暂存，避免把旧 runtime 的 seq 当成新 runtime 的基线。
// 首帧竞态：ACK 之前到达的 physical wire 先有界暂存（1 024 条 / 32MB），超限整批作废而不是
// 截断——截断会得到「能过类型校验但缺片」的 snapshot，比失败更危险。
// 失败语义：runtime unavailable 不报错（降级 dormant）；其它错误交给 onError 并触发重订阅。
// 副作用：订阅/取消订阅 Agent 主题；dispose 时释放全部订阅与定时器（幂等）。

// Window Host 的 sessions-index V4 被动观察器：合并、去重、换代与释放顺序
// INV-01 订阅以 window-controller scope 绑定 workspace key，不复用窗口 controller 的 attachment；守住位置：SUBSCRIBER_SCOPE 与 workspaceKey 推导；改错故障：两个窗口共用一条订阅，一个窗口的会话刷新到另一个窗口。
// INV-02 existing-only 策略下缺 runtime 只降级 dormant，不主动拉起 Agent；守住位置：createWindowHostSessionsIndexObserver 的 subscribe 入参与 catch 分支；改错故障：仅浏览会话列表就冷启 Agent 进程，空闲内存翻倍。
// INV-03 summaries 是当前 runtime 的唯一投影，上报只发全量不发增量；守住位置：publish 与 onSessionsChange；改错故障：renderer 侧自行合并增量，已删除的会话长期残留。
// INV-04 snapshot 必须整体替换而不是与旧投影求并集；守住位置：applyFrame 的 snapshot 分支先 clear 再写入；改错故障：旧 runtime 已删除的会话仍在列表，点开即报不存在。
// INV-05 cursor 只有在 fromSeq 与本地 seq 连续时才推进；守住位置：applyFrame 的连续性判断；改错故障：断档增量被接受，投影永久缺少一段变更。
// INV-06 snapshot 落定时 cursor 必须同步取 toSeq 作为新基线；守住位置：applyFrame snapshot 分支末尾的赋值；改错故障：后续增量全部判为不连续，陷入反复恢复。
// INV-07 增量在同一帧内要么全应用要么不应用，不允许半帧生效；守住位置：applyFrame 的 deltas 循环；改错故障：列表与 Agent 真实状态错位且无法自愈。
// INV-08 断档或组装 fault 只能请求 forceSnapshot 重同步；守住位置：requestRecovery；改错故障：客户端自行猜测缺口，列表进入不可信状态。
// INV-09 恢复请求在途时不得再发起第二次恢复；守住位置：requestRecovery 的 recovering 早返回；改错故障：一次断档打出多次 resync，Agent 侧订阅被打爆。
// INV-10 恢复的超时兜底以装配超时常量为准，超时后重订阅；守住位置：requestRecovery 的 recoveryTimer；改错故障：resync 响应丢失后观察器永久卡在 recovering。
// INV-11 runtime 换代必须清空 cursor、暂存、assembler 与投影；守住位置：invalidateRuntime；改错故障：旧 runtime 的 seq 被当成新基线，增量永远对不上。
// INV-12 只有与当前 activeSubscriptionId 匹配的 wire 才可进入 assembler；守住位置：acceptOwnedWire 的首段校验；改错故障：上一代订阅的迟到帧污染新投影。
// INV-13 ACK 之前的 wire 必须按序有界暂存，而不是直接丢弃；守住位置：stageOrAcceptWire 的暂存分支；改错故障：首帧 snapshot 早于 RPC 响应时列表空白到下次重连。
// INV-14 暂存越界必须整批作废并标记 overflow；守住位置：stageOrAcceptWire 的越界分支；改错故障：被截断的 snapshot 能过类型校验却缺片，比失败更难排查。
// INV-15 overflow 之后不得静默继续，必须上报错误并放弃该次订阅；守住位置：start 中 stagingOverflowed 的收口；改错故障：用户看到永不完整的会话列表且没有任何提示。
// INV-16 订阅归属必须先写入 startPromise 再调用 subscribe；守住位置：start 的 pending 赋值顺序；改错故障：同步 lifecycle 回调递归进入第二次订阅，一条链路两条订阅。
// INV-17 workspaceKey 不匹配的 lifecycle 与 restart 事件必须忽略；守住位置：两个回调的首行过滤；改错故障：别的窗口 runtime 重启会清空本窗口列表。
// INV-18 dormant 只影响订阅时机，不得吞掉其它错误；守住位置：lifecycle 回调与 start 的 catch 分支；改错故障：鉴权失败被当成休眠，用户反复点击无任何反馈。
// INV-19 dispose 幂等且先摘回调、再本地复位、最后远程退订；守住位置：返回对象里的 dispose；改错故障：释放后的迟到帧继续写投影，或定时器唤醒已销毁窗口。
// INV-20 单帧处理失败必须落到恢复路径而不是静默吞掉；守住位置：acceptOwnedWire 的 faulted 标记；改错故障：坏帧之后增量永久落后，用户看到过期会话。
// 总述：观察器只维护只读投影，所有状态变更都由 snapshot 或增量单点驱动，失败一律走恢复路径。
//
import type { IDisposable } from "@zcode/rpc";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE, type IZCodeAgentService } from "@zcode/services";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";

// [并发] 订阅 scope 固定为 window-controller，与窗口 controller 的 attachment 互不复用
// 改成窗口级 scope 会让同一 workspace 的多个窗口争抢同一条主题订阅
const SUBSCRIBER_SCOPE = "window-controller";
// [资源] 暂存上界同时约束条数与字节，1 024 条与 32MB 是刻意保守的双闸
// 只看条数会让超大会话的单个 frame 直接吃满内存
// 只看字节又放不住大量小帧，两条闸必须同时生效
const MAX_STAGED_WIRES = 1_024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;

// 依赖面收敛到五个订阅相关方法，避免整个 Agent 服务被拖进观察器
// lifecycle 用 Partial 保留，老 Host 没有该回调时观察器仍能工作
type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;

// 观察器句柄：start 幂等（并发调用复用同一 pending），dispose 幂等并释放订阅/定时器。
export interface WindowHostSessionsIndexObserver {
  start(): Promise<void>;
  dispose(): void;
}

// [失败路径] runtime 不可用是预期降级，必须与真实故障分开判定
// 按 code 精确比对，不匹配错误文案，避免文案本地化后误判
function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Window Host 的被动 sessions-index 观察器。它只使用 existing-only，缺少 runtime 时保持
 * dormant；ACK 前 physical wire 有界暂存，避免初始 snapshot 早于 RPC response 时丢失。
 */
// 输入：agentService（Agent RPC 面）、target（workspace 身份，决定 topic 与订阅 key）、
//   onSessionsChange（全量投影回调，不是增量）、onError（非 runtime-unavailable 错误）。
// 输出：{ start, dispose }；start 只做订阅与重放，不发起任何写操作。
// 副作用：注册三类 Agent 回调（frame / lifecycle / restarted），dispose 时全部解除。
// 失败语义：subscribe 失败若不是 runtime-unavailable 会回调 onError；dispose 后不再回调。
// 不变量：summaries 始终是「当前 runtime 的完整投影」，换代时清空后由 snapshot 重建。
// 对外只暴露 start 与 dispose，投影统一经 onSessionsChange 全量回调
// [权衡] 回调不带增量参数，宁可整表重传也不让 renderer 参与合并
export function createWindowHostSessionsIndexObserver(options: {
  agentService: SessionsIndexAgentService;
  target: { workspacePath: string; workspaceIdentity?: string };
  onSessionsChange: (sessions: SessionSummary[]) => void;
  onError?: (error: unknown) => void;
}): WindowHostSessionsIndexObserver {
  const workspace = {
    workspacePath: options.target.workspacePath,
    ...(options.target.workspaceIdentity
      ? { workspaceIdentity: options.target.workspaceIdentity }
      : {}),
  };
  // 身份 key 统一为 identity 优先、path 兜底，与仓库其它绑定逻辑同源
  // 只用 path 会让同一路径的远程与本地 workspace 互相串台
  const workspaceKey = options.target.workspaceIdentity?.trim() || options.target.workspacePath;
  const topic = sessionsIndexTopic(workspaceKey);
  // [并发] summaries 是本观察器唯一可变投影，所有写入都在同一事件循环内完成
  // snapshot 与增量的写入口都收敛在 applyFrame，没有第二条写入路径
  // 在别处另建一份缓存会立刻出现两套事实
  const summaries = new Map<string, SessionSummary>();
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  let activeSubscriptionId: string | null = null;
  let cursor: { logEpoch: string; seq: number } | null = null;
  let disposed = false;
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  let restartAfterPending = false;
  let dormant = false;
  let recovering = false;
  let stagedWires: SessionsIndexTopicWireCandidate[] = [];
  let stagedBytes = 0;
  let stagingOverflowed = false;
  let assemblyTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = (): void => {
    options.onSessionsChange(Array.from(summaries.values()));
  };

  const clearAssemblyTimer = (): void => {
    if (assemblyTimer) clearTimeout(assemblyTimer);
    assemblyTimer = null;
  };

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  // [资源] 重排超时定时器前先清旧的，保证同一时刻只有一个待触发句柄
  // nextExpiryAt 为空表示没有待组装帧，此时不排定时器也不留空转
  // 句柄调用 unref，进程退出不被这个定时器拖住
  const scheduleAssemblyExpiry = (): void => {
    clearAssemblyTimer();
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    assemblyTimer = setTimeout(
      () => {
        assemblyTimer = null;
        const faults = assembler.expire(Date.now()).filter((event) => event.kind === "fault");
        if (faults.length > 0) requestRecovery();
        scheduleAssemblyExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    assemblyTimer.unref?.();
  };

  // 帧处理按 payload 的 kind 二分：snapshot 重建，增量续接
  // 两条路径都要维护 cursor，任一条漏更新都会让下一次判断失准
  const applyFrame = (frame: SessionsIndexTopicFrame): void => {
    // [事务] snapshot 先 clear 再逐条写入，替换语义不允许与旧投影求并集
    // 旧 runtime 已删除的会话必须在这一次替换里消失
    // 清空到上报之间不插入其它异步等待，避免观察者读到半张表
    if (frame.payload.kind === "snapshot") {
      summaries.clear();
      for (const session of frame.payload.snapshot.sessions) {
        summaries.set(session.sessionId, session);
      }
      cursor = { logEpoch: frame.payload.snapshot.logEpoch, seq: frame.toSeq };
      recovering = false;
      clearRecoveryTimer();
      publish();
      return;
    }
    // fromSeq 与本地 seq 严格相等才继续，跳号与回退都算断档
    // 断档不做局部丢弃继续跑，直接交给恢复路径重建
    if (!cursor || frame.fromSeq !== cursor.seq) {
      requestRecovery();
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") summaries.set(delta.session.sessionId, delta.session);
      else summaries.delete(delta.sessionId);
    }
    cursor = { ...cursor, seq: frame.toSeq };
    publish();
  };

  // [并发] topic 与 activeSubscriptionId 双匹配的 wire 才进入 assembler
  // 上一代订阅迟到的帧在这里被挡掉，不会污染新投影
  const acceptOwnedWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (
      !activeSubscriptionId ||
      wire.topic !== topic ||
      wire.subscriptionId !== activeSubscriptionId
    ) {
      return;
    }
    const events = assembler.accept(wire);
    let faulted = false;
    for (const event of events) {
      if (event.kind === "fault") faulted = true;
      else applyFrame(event.frame);
    }
    if (faulted) requestRecovery();
    scheduleAssemblyExpiry();
  };

  // 已持有订阅时直接消费，没有订阅时才走暂存
  // topic 不匹配或已 dispose 的 wire 一律丢弃，不做任何记账
  const stageOrAcceptWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (disposed || wire.topic !== topic) return;
    if (activeSubscriptionId) {
      acceptOwnedWire(wire);
      return;
    }
    if (stagingOverflowed) return;
    const bytes = encodedBytes(wire);
    if (
      bytes > MAX_STAGED_BYTES ||
      stagedWires.length + 1 > MAX_STAGED_WIRES ||
      stagedBytes + bytes > MAX_STAGED_BYTES
    ) {
      // 初始 frame 可早于 subscribe ACK；截断头部会留下可通过类型校验但缺片的
      // snapshot。越界时必须整批作废，待 ACK 后取消该订阅并等待下一次 runtime lifecycle。
      stagedWires = [];
      stagedBytes = 0;
      stagingOverflowed = true;
      return;
    }
    stagedWires.push(wire);
    stagedBytes += bytes;
  };

  // [事务] 恢复只做 forceSnapshot，base 仍带 cursor 供服务端裁剪
  // recovering 标志挡住并发恢复，一次断档只对应一次 resync
  // runtimePolicy 继续 existing-only，恢复过程同样不主动拉起 Agent
  function requestRecovery(): void {
    const subscriptionId = activeSubscriptionId;
    if (disposed || recovering || !subscriptionId) return;
    recovering = true;
    assembler.abort(topic, subscriptionId);
    void options.agentService
      .resyncSessionsIndexV4({
        ...workspace,
        subscriptionId,
        base: cursor,
        forceSnapshot: true,
        runtimePolicy: "existing-only",
      })
      .then(() => {
        if (disposed || activeSubscriptionId !== subscriptionId || !recovering) return;
        clearRecoveryTimer();
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (!disposed && activeSubscriptionId === subscriptionId && recovering) {
            resubscribeAfterRecovery();
          }
        }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
        recoveryTimer.unref?.();
      })
      .catch((error) => {
        recovering = false;
        if (!isRuntimeUnavailableError(error)) {
          options.onError?.(error);
          resubscribeAfterRecovery();
        }
      });
  }

  // [资源] 先本地失效再远程退订：代际自增、cursor 与暂存清空、assembler 复位
  // 旧订阅 id 单独保存，退订失败只吞错误，不阻塞新订阅
  // startPromise 在途时只置 restartAfterPending，由 start 的 finally 收口再起
  function resubscribeAfterRecovery(): void {
    const previousSubscriptionId = activeSubscriptionId;
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    if (previousSubscriptionId) {
      void options.agentService
        .unsubscribeSessionsIndexV4({
          ...workspace,
          subscriptionId: previousSubscriptionId,
          runtimePolicy: "existing-only",
        })
        .catch(() => {});
    }
    if (startPromise) restartAfterPending = true;
    else void start();
  }

  const frameSubscription =
    options.agentService.onDynamicSessionsIndexFrame(workspace)(stageOrAcceptWire);

  // 换代清理与恢复重建共用同一套动作，唯多一步清空投影并立即上报
  // 投影先清空而不是等新 snapshot，避免用户看到上一代 runtime 的残留会话
  // 代际自增让在途的 subscribe 响应作废，迟到的 ACK 会走退订分支
  const invalidateRuntime = (): void => {
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    summaries.clear();
    publish();
  };

  let lifecycleSubscription: IDisposable | undefined;
  let restartSubscription: IDisposable | undefined;
  // [并发] 有 lifecycle 时优先用它判断换代，避免与 restarted 双触发重复清理
  // 回调首行按 workspaceKey 过滤，跨窗口事件在这里被隔离
  if (options.agentService.onAgentRuntimeLifecycle) {
    lifecycleSubscription = options.agentService.onAgentRuntimeLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      if (event.state === "unavailable") {
        dormant = true;
        invalidateRuntime();
        return;
      }
      const wasDormant = dormant;
      dormant = false;
      if (startPromise) {
        // 同一次 existing-only subscribe 可能在 ACK 前发布 available；这不是旧 runtime
        // 换代。只有先观察到 unavailable 的 pending 才需要在当前请求收口后重订阅。
        if (wasDormant) restartAfterPending = true;
      } else if (!activeSubscriptionId) void start();
    });
  } else {
    restartSubscription = options.agentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      invalidateRuntime();
      if (startPromise) restartAfterPending = true;
      else void start();
    });
  }

  // start 三重幂等：已 dispose、dormant、已持有订阅都直接返回
  // startPromise 存在时复用同一 Promise，调用方不会触发第二次 subscribe
  // subscribeGeneration 记下发起时的代际，响应回来若代际已变就退订放弃
  async function start(): Promise<void> {
    if (disposed || dormant || activeSubscriptionId) return;
    if (startPromise) return startPromise;
    const subscribeGeneration = generation;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    // 先把 pending ownership 写入 startPromise，再进入 subscribe；Agent 可能在 RPC Promise
    // 返回前同步发布 runtime available，不能让 lifecycle callback 递归进入第二次 start。
    // [并发] pending 体在微任务里执行，startPromise 的赋值总在 subscribe 之前完成
    // 同步触发的 lifecycle 回调因此看到在途 Promise，不会递归进入第二次 start
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await options.agentService.subscribeSessionsIndexV4({
          ...workspace,
          visibility: "background",
          subscriberScope: SUBSCRIBER_SCOPE,
          runtimePolicy: "existing-only",
        });
        if (disposed || subscribeGeneration !== generation || stagingOverflowed) {
          void options.agentService
            .unsubscribeSessionsIndexV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
              runtimePolicy: "existing-only",
            })
            .catch(() => {});
          if (stagingOverflowed) {
            options.onError?.(new Error("fault.subscription.initialFrameStagingOverflow"));
          }
          return;
        }
        activeSubscriptionId = result.ack.subscriptionId;
        const initialWires = stagedWires;
        stagedWires = [];
        stagedBytes = 0;
        for (const wire of initialWires) acceptOwnedWire(wire);
      } catch (error) {
        if (!disposed && isRuntimeUnavailableError(error)) {
          // 有 lifecycle 的新 Host 等 available 再订阅，避免每次列表查询都重复打 dormant RPC。
          dormant = Boolean(options.agentService.onAgentRuntimeLifecycle);
        } else if (!disposed) {
          options.onError?.(error);
        }
      }
    });
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = null;
      if (restartAfterPending && !disposed && !activeSubscriptionId) {
        restartAfterPending = false;
        void start();
      }
    }
  }

  return {
    start,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const subscriptionId = activeSubscriptionId;
      activeSubscriptionId = null;
      // [资源] dispose 先摘 frame 回调，再摘 lifecycle 与 restart 回调
      // 本地复位（定时器、assembler、暂存）在远程退订之前完成，退订失败也不影响已释放状态
      // 订阅 id 提前单独保存，置空 activeSubscriptionId 之后仍能退掉旧订阅
      frameSubscription.dispose();
      lifecycleSubscription?.dispose();
      restartSubscription?.dispose();
      clearAssemblyTimer();
      clearRecoveryTimer();
      assembler.clear();
      stagedWires = [];
      if (subscriptionId) {
        void options.agentService
          .unsubscribeSessionsIndexV4({
            ...workspace,
            subscriptionId,
            runtimePolicy: "existing-only",
          })
          .catch(() => {});
      }
    },
  };
}
