/* eslint-disable max-lines -- index projection、applied-base 与 recovery flight 必须由同一原子 store 裁决。 */
// sessions-index topic 的 renderer 只读 store：
// snapshot 帧全量替换；delta 帧仅在区间衔接（frame.fromSeq === watermark）时 apply，
// 断档不猜、不缓存补偿——重订阅交由服务端裁决续传或全量（与 ConversationProjectionStore 同策略）。
// ── sessions-index renderer store：职责边界与不变量 ──
//
// 职责：把 sessions-index topic 的帧序列投影成 useSyncExternalStore 可消费的只读快照。
// 不做：不生产会话、不写回 host、不缓存补偿帧、不猜断档，断档后也不保留旧投影。
// 所有权：state 与订阅生命周期都在本 store；transport 只收发，分组/pin 与分页切片归上层。
// 读出口：getSessions 给出的稳定数组是本 store 唯一对外投影，顺序只由 lastActivityAt 决定。
//
// 不变量（INV）表：
// INV-01 断言：snapshot 必须重建 Map，不得复用旧 Map —— 守住它的位置：applySessionsIndexFrame 的 snapshot 分支 —— 改错故障：已删除会话残留，列表出现幽灵行
// INV-02 断言：delta 仅在 frame.fromSeq === state.seq 时合并 —— 守住它的位置：衔接判定 —— 改错故障：跳帧被静默接受，投影永久缺一段
// INV-03 断言：toSeq <= seq 的陈旧帧按序号原样丢弃 —— 守住它的位置：applySessionsIndexFrame 早退 —— 改错故障：回放帧倒退水位，后续真增量被判断档
// INV-04 断言：断档只上报 gap，不本地补齐 —— 守住它的位置：gap:true 与 handleFrame 的重订阅 —— 改错故障：不连续区间被缝合，列表内容错误
// INV-05 断言：帧必须属于当前 subscriptionId —— 守住它的位置：handleFrame 代际闸门 —— 改错故障：foreign 帧窗口被当断档，重订阅风暴
// INV-06 断言：增量合并与全量刷新不得交错改写 state —— 守住它的位置：recovery 单例与 requestInFlight 分支 —— 改错故障：snapshot 与 resume 交错，水位与内容不一致
// INV-07 断言：会话删除后不得再出现 —— 守住它的位置：delta remove 分支与 snapshot 重建 —— 改错故障：已删除会话复活，选中态指向不存在实体
// INV-08 断言：未 apply base 前不得接受 deltas —— 守住它的位置：subscriptionHasAppliedBase 闸门 —— 改错故障：从空投影增量起算，缺口被当成全量
// INV-09 断言：仅 ACK 成功且代际未变才发布 live —— 守住它的位置：connect 的 generation 复核 —— 改错故障：迟到旧订阅覆盖新订阅，帧被路由到错误通道
// INV-10 断言：fail-closed 同时清空投影、cachedList 与 live 证明 —— 守住它的位置：failAndScheduleRecovery —— 改错故障：错误态仍展示 running，出现孤儿 spinner
// INV-11 断言：内容确定性失败不得进入无界退避 —— 守住它的位置：failRecovery 的 scheduleRetry —— 改错故障：读不懂的内容反复重订，永不收敛
// INV-12 断言：cachedList 与 state.sessions 必须同代失效 —— 守住它的位置：applyFrame/reset/handleRuntimeUnavailable 的置 null —— 改错故障：引用不变导致 React 不重渲染
//
// 阅读顺序：纯 applySessionsIndexFrame → handleFrame 路由 → recovery flight 状态机 → fail-closed 终态 → handleRuntime*。
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { logger } from "@/logger.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

// [契约] state 是唯一投影真相：workspaceId/logEpoch 标识“哪一份流”，seq 是增量水位。
// sessions 以 sessionId 为键做 conflated 存储：同一会话多帧只保留最后一条，不保留历史。
// EMPTY 常量共享同一个 Map 实例，所以任何写路径都必须换新 Map；原地 set 会污染所有空态持有者。
export interface SessionsIndexState {
  /** workspaceId → 已知；null = 尚无 snapshot。 */
  workspaceId: string | null;
  logEpoch: string | null;
  /** 帧区间水位（= 最近一帧 toSeq）。 */
  seq: number;
  /** 会话摘要，按 sessionId 索引（conflated）。 */
  sessions: Map<string, SessionSummary>;
}

export const EMPTY_SESSIONS_INDEX_STATE: SessionsIndexState = {
  workspaceId: null,
  logEpoch: null,
  seq: 0,
  sessions: new Map(),
};

export type SessionsIndexStoreStatus = "idle" | "dormant" | "connecting" | "live" | "error";

const RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS = 5_000;
const RUNTIME_RESTART_BURST_RESET_MS = 30_000;
const TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ERROR_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

// [失败路径] 这里只分类“值得重试的传输/文件锁症状”，不判断协议语义失败。
// EBUSY/EMFILE/ENFILE 与 config.json.lock 冲突都来自 host 冷启动期 provider registry。
// 归类错误代价双向：漏判会永久 error，误判会把确定性失败拖成重试循环。
function isTransientSubscribeError(error: unknown): boolean {
  if (isZCodeFileLockTimeoutError(error)) {
    return true;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return true;
  }
  if (code === "EEXIST" && message.includes("config.json.lock")) {
    return true;
  }
  return /\b(?:EBUSY|EMFILE|ENFILE)\b/.test(message) || message.includes("config.json.lock");
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

// [资源] 退订是 best-effort：proxy 换代后旧 RPC 可能永不 settle，await 会卡住新代际接管。
// 失败只 warn 不抛：cleanup 失败不能变成 unhandled rejection，也不能影响新一代 registry entry。
// 服务端按 subscriptionId 精确退订，因此迟到的 cleanup 不会误删新代际的订阅。
async function unsubscribeIgnoringFailure(
  transport: SessionsIndexTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    // service proxy 换代后旧 store cleanup 仍会命中已断开的 RPC。
    // cleanup 失败不能变成 unhandled rejection，也不能影响新一代 registry entry。
    logger.warn(
      `[v4-sessions-index] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface ApplySessionsIndexResult {
  state: SessionsIndexState;
  /** true = 帧区间断档（fromSeq 与水位不衔接），调用方应重订阅。 */
  gap: boolean;
}

/** 纯 apply：snapshot 全量替换；deltas 仅在衔接时逐条 upsert/remove。 */
// [契约] 纯函数：输入当前 state 与一帧，输出新 state 或 gap，不触碰 transport、timer 与 logger。
// gap=true 时原样返回 current，调用方据此重订阅；这里绝不尝试本地补齐缺失区间。
// `applySessionsIndexFrame` 是纯函数：水位与断档语义可脱离订阅生命周期单测。
export function applySessionsIndexFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): ApplySessionsIndexResult {
  // [事务] snapshot 是权威全量：必须新建 Map 并从零装载，旧投影里的条目都不再可信。
  // workspaceId/logEpoch 一并替换，换 workspace 或日志纪元重置也走这条路径。
  // 若复用旧 Map 只做增量覆盖，已删除会话会残留——这正是“已删除会话复活”的根因。
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const sessions = new Map<string, SessionSummary>();
    for (const session of snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return {
      gap: false,
      state: {
        workspaceId: snapshot.workspaceId,
        logEpoch: snapshot.logEpoch,
        seq: frame.toSeq,
        sessions,
      },
    };
  }
  // [并发] 陈旧帧按序号丢弃：toSeq 不大于本地水位，说明这段区间已经合并过。
  // 返回 current 而不是新对象，保证 state 引用不变、不触发无意义 emit 与重渲染。
  // 此处不判 gap：旧帧的重叠不是断档，报 gap 会让上层误重订阅。
  if (frame.toSeq <= current.seq) {
    return { state: current, gap: false };
  }
  // deltas：区间必须衔接（fromSeq === 当前水位），否则断档。
  // [契约] 衔接条件是 fromSeq === 当前 seq：上一帧的 toSeq 就是下一帧的 fromSeq。
  // 不衔接即断档，gap 交给 handleFrame 决定走 initial 重连还是 requestRecovery。
  // 禁止在此缓存孤儿 delta 等补偿——断档后的内容只能由服务端续传或全量裁决。
  if (frame.fromSeq !== current.seq) {
    return { state: current, gap: true };
  }
  // [事务] 增量合并写时复制：先浅拷贝 Map，再逐条 upsert/remove，最后整体换 state。
  // 这样判定断档或中途出错时，current.sessions 仍保持上一份完整投影，不会半写。
  // seq 必须与 sessions 在同一次 state 替换里更新，二者不可分开发布。
  const sessions = new Map(current.sessions);
  for (const delta of frame.payload.deltas) {
    // [契约] upsert 覆盖同 sessionId 的整条摘要；否则视为删除，从 Map 中移除该 id。
    // 删除是终态：真要复活只能由服务端发新 upsert 或全量 snapshot 重建。
    // 不要保留墓碑或软删除标记，上层一律用 getSessions() 判断存在性。
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
    } else {
      sessions.delete(delta.sessionId);
    }
  }
  return {
    gap: false,
    state: { ...current, seq: frame.toSeq, sessions },
  };
}

/**
 * useSyncExternalStore 兼容的只读 store：subscribe + getState 返回稳定引用。
 * 状态本体与纯 applyFrame 可独立单测；传输绑定（connect/handleFrame/close）
 * 负责订阅生命周期与断档重订阅。
 */
export class SessionsIndexStore {
  private state: SessionsIndexState = EMPTY_SESSIONS_INDEX_STATE;
  private readonly listeners = new Set<() => void>();
  /** 缓存的有序列表（getSessions 稳定引用，避免每次 new array 触发重渲染）。 */
  // [资源] 有序列表缓存：getSessions 返回同一数组引用，避免每次 new array 破坏 memo。
  // state.sessions 每次替换都把它置 null，下次读取时重建并排序，是 O(n log n) 的一次性成本。
  // 忘记置 null 的症状是内容已变但 React 不重渲染——排查时先看这三处赋值。
  private cachedList: SessionSummary[] | null = null;
  // 传输绑定（可选：纯 applyFrame 单测不需要）。
  private transport: SessionsIndexTransport | null = null;
  private frameUnsub: (() => void) | null = null;
  private faultUnsub: (() => void) | null = null;
  private restartUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private subscriptionId: string | null = null;
  // [并发] awaitingInitial 把“等首帧”绑定到具体 subscriptionId：只有该订阅的 initial 帧能兑现。
  // 首帧到达前 transport 做有界 staging，这个字段决定 activate 之后哪些早帧可以放行。
  // 代际变化或 ACK 失败必须清空，否则旧订阅的迟到帧会被误认成本次首帧。
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  // [契约] 只有真正应用过 base（resume 命中同一 logEpoch）才允许消费 deltas。
  // false 时收到 deltas 只能 requestRecovery：从空投影增量起算会把缺口当全量，静默丢数据。
  // 它是“投影是否可信”的证明位，任何 fail-closed、detach 与换代都要同步置 false。
  private subscriptionHasAppliedBase = false;
  // [并发] recovery 是单例 flight：同一时刻最多一次 resync，增量合并与全量刷新由此互斥。
  // requestInFlight/ackReceived/validFrameSeen 描述阶段；forceSnapshot 只可升级，postRecoveryGapPending 记录收敛后又见缺口。
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，且不再无限退避重订阅。 */
    contentFault: boolean;
  } | null = null;
  private status: SessionsIndexStoreStatus = "idle";
  private generation = 0;
  private closed = false;
  private runtimeRestartReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRestartBurstCount = 0;
  private lastRuntimeRestartAt = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryAttempt = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionsIndexState => this.state;

  getStatus(): SessionsIndexStoreStatus {
    return this.status;
  }

  /**
   * 绑定传输并发起订阅：注册帧监听 + subscribe（水位不变量：仅当真持有一致状态才带 base）。
   * 断档帧 → 丢 base 重订阅（handleFrame 触发）。close 后可再次 connect（React
   * effect 卸载/重挂载——StrictMode 双调——走同一路径复活）。
   */
  async connect(
    transport: SessionsIndexTransport,
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      subscribeRetryAttempt?: number;
      errorRecoveryRetryAttempt?: number;
    } = {},
  ): Promise<void> {
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.clearSubscribeRetry();
    if (options.errorRecoveryRetryAttempt === undefined) {
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
    }
    this.closed = false;
    this.transport = transport;
    if (!this.frameUnsub) {
      this.frameUnsub = transport.onFrame((frame, context) => this.handleFrame(frame, context));
      this.faultUnsub = transport.onAssemblyFault((fault) => {
        if (fault.subscriptionId === this.subscriptionId) {
          this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
        }
      });
      if (transport.onRuntimeLifecycle) {
        this.lifecycleUnsub = transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.handleRuntimeAvailable();
          else this.handleRuntimeUnavailable();
        });
      } else {
        this.restartUnsub = transport.onRuntimeRestart(() => this.handleRuntimeRestart());
      }
    }
    const generation = ++this.generation;
    this.discardRecovery();
    this.status = "connecting";
    this.emit();
    // [契约] 水位不变量：仅当真持有一致投影（logEpoch 非空且非强制全量）才带 base 订阅。
    // base 是 {logEpoch, seq}，服务端据此裁决 resume 还是 snapshot；本端不预设结果。
    // forceSnapshot 或本地无 logEpoch 时显式传 undefined，宁可从零取全量也不猜续传。
    const base =
      options.forceSnapshot || this.state.logEpoch === null
        ? undefined
        : { logEpoch: this.state.logEpoch, seq: this.state.seq };
    try {
      // [并发] subscribe 的 await 窗口是本 store 最危险的区间：旧订阅仍在，新订阅尚未 remember。
      // 窗口内可能创建 same-sub recovery，而 host scope 在新 ACK remember 时会静默驱逐旧 ownership。
      // 所以 ACK 后先校验代际、再 discardRecovery，避免旧 flight 的迟到失败把 live 打成 error。
      const result = await transport.subscribe(base ? { base } : {});
      // [并发] 代际闸门：await 期间可能已 close、换代或被新 transport 接管，此时结果一律作废。
      // 作废的订阅必须显式远端退订，否则泄漏一个仍会推帧的 subscriptionId。
      // 直接 return 不 emit：更新的 connect 已负责推进状态，旧路径不得再写 state。
      if (generation !== this.generation || this.closed) {
        void unsubscribeIgnoringFailure(transport, result.ack.subscriptionId);
        return;
      }
      // 与 conversationProjectionStore.connect 同因（线上 notOwned 卡死）：
      // subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery，而 host scope 在
      // 新 ACK remember() 时已静默驱逐旧 ownership。换代成功即丢弃旧 recovery，避免其
      // 迟到失败把 live 的新订阅打成 error。
      this.discardRecovery();
      this.subscriptionId = result.ack.subscriptionId;
      this.status = "live";
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
      // [契约] 只有 base 被服务端以 resume 接受且 logEpoch 一致，才承认本地投影是连续基线。
      // snapshot 模式或 logEpoch 漂移都意味着内容将被全量替换，不能宣称已 apply base。
      // 它与 awaitingInitial 同时设置：一个管“能否吃增量”，一个管“首帧属于谁”。
      this.subscriptionHasAppliedBase = Boolean(
        base && result.ack.mode === "resume" && result.ack.logEpoch === base.logEpoch,
      );
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      // initial 只经 notification 到达；先绑定代际，再 activate 释放 ACK 前早帧。
      transport.activate(result.ack.subscriptionId);
      this.emit();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (isRuntimeUnavailableError(error)) {
        // restored workspace 的被动列表订阅曾把 runtime 缺失当成普通失败并
        // 退避重试，最终由 getClient 批量启动 CLI。dormant 等待 lifecycle，不设 timer。
        this.handleRuntimeUnavailable();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        // [失败路径] 首帧 staging 溢出说明 initial 帧过大被 transport 拒收，只能改取全量快照。
        // 只重试一次（initialOverflowRetry）：再溢出就是协议或分片问题，重试只会放大负载。
        // 重试复用同一 transport 与 errorRecoveryRetryAttempt，保持退避预算不被清零。
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        await this.connect(transport, {
          forceSnapshot: true,
          initialOverflowRetry: true,
          ...(options.errorRecoveryRetryAttempt !== undefined
            ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
            : {}),
        });
        return;
      }
      const retryAttempt = options.subscribeRetryAttempt ?? 0;
      const retryDelay = TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
      // [失败路径] 瞬时失败保持 connecting 而非 error，用有界阶梯 250/1000/3000ms 重订阅。
      // 已拿到的 snapshot 继续保留：冷启动首订失败不该让聚合层立刻显示“还没有对话”。
      // 阶梯耗尽才 failAndScheduleRecovery；每次重试复核 closed 与 generation，防止复活旧代际。
      if (isTransientSubscribeError(error) && retryDelay !== undefined) {
        // Host 冷启动时 provider registry 的配置锁可能短暂冲突。若把
        // 首次 subscribe 失败永久定格为 error，聚合层随即发布空列表并显示“还没有对话”。
        // 瞬时文件锁错误保持 hydrating，用有界退避重订阅；已有 snapshot 也继续保留。
        this.status = "connecting";
        logger.warn(`[v4-sessions-index] subscribe 瞬时失败，${retryDelay}ms 后重试: ${message}`);
        this.subscribeRetryTimer = setTimeout(() => {
          this.subscribeRetryTimer = null;
          if (this.closed || generation !== this.generation) return;
          void this.connect(transport, {
            ...(options.forceSnapshot ? { forceSnapshot: true } : {}),
            subscribeRetryAttempt: retryAttempt + 1,
            ...(options.errorRecoveryRetryAttempt !== undefined
              ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
              : {}),
          });
        }, retryDelay);
        this.emit();
        return;
      }
      this.failAndScheduleRecovery(`subscribe:${message}`);
    }
  }

  /**
   * 远程 RPC proxy 换代时原地替换 transport。
   *
   * 先同步解除旧 transport 的本地监听，再对新 transport 强制取 snapshot；远端退订只做
   * best-effort，不能阻塞新 proxy 接管。服务端按 subscriptionId 精确退订，迟到 cleanup
   * 不会删除新代际。并发换代由 store generation 失效旧结果，store 身份和最后一份投影保持不变。
   */
  // [资源] proxy 换代原地复用 store 身份：先同步 detach 旧监听，再对新 transport 强取 snapshot。
  // 旧远端退订只 best-effort，不能阻塞接管；服务端按 subscriptionId 精确退订，迟到 cleanup 不误删。
  // 并发换代由 generation 失效旧结果，最后一份投影作为新订阅 base，避免列表闪空。
  async replaceTransport(transport: SessionsIndexTransport): Promise<void> {
    if (!this.closed && this.transport === transport) return;

    const generation = ++this.generation;
    const previous = this.detachTransport();
    this.status = "connecting";
    this.emit();

    if (previous.transport && previous.subscriptionId) {
      // proxy handoff 后旧 RPC 可能永远不 settle；等待它会让新 transport
      // 永久停在 connecting。先完成本地 detach，远端精确退订异步收尾即可。
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
    if (generation !== this.generation || this.closed) return;

    await this.connect(transport, { forceSnapshot: true });
  }

  /** 帧路由入口（initial / online notification）。断档 → 重订阅。 */
  // [契约] 帧路由唯一入口：按 deliveryKind 区分 initial、recovery、online，并在此推进 flight 状态。
  // initial 帧到达时消费 awaitingInitial；online 帧在 recovery 期间只记录缺口，不直接合并。
  // 所有“要不要重订阅”的裁决都收敛到这里，applyFrame 本身只回答 gap 与否。
  handleFrame(
    frame: SessionsIndexTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际闸门：workspace 级 fan-out 会把同 topic 其他订阅者的帧也送到这里
    // （host 侧 task-index syncer 用独立 connectionId 常驻订阅 sessions-index）。
    // 不按自己的 subscriptionId 过滤会把别人的 (fromSeq, toSeq] 窗口当成断档，触发重订阅风暴。
    // subscriptionId 尚未就位时的 own initial 由 transport 有界 staging；绑定后 activate
    // 才释放。其他旧代际/foreign frame 在这里继续丢弃。
    // [并发] 代际闸门：workspace 级 fan-out 会把同 topic 其他订阅者的帧也送到这里。
    // host 侧 task-index syncer 用独立 connectionId 常驻订阅 sessions-index，其 (fromSeq,toSeq] 与本端无关。
    // 不按 subscriptionId 过滤就会把别人的窗口当断档，触发重订阅风暴——这是线上教训。
    if (this.subscriptionId === null || frame.subscriptionId !== this.subscriptionId) {
      return;
    }
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    // [事务] flight 期间到达的 online snapshot 属于旧订阅残余全量，不能与本次 recovery 交错写入。
    // 这里 applyFrame 并要求无 gap 才置 base：竞态下宁可丢这一帧，也不让两个来源同时改 state。
    // 真正的收敛仍由 recovery 帧与 markRecoveryFrameSeen 决定，避免“谁后到谁赢”。
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      const gap = this.applyFrame(frame);
      if (!gap) this.subscriptionHasAppliedBase = true;
      return;
    }
    // [并发] 非 snapshot 的 online 帧在 flight 期间只做记录：真增量要等 recovery 帧建立新基线。
    // 若其 toSeq 越过本地水位且此前已见有效帧，标记 postRecoveryGapPending，收敛后需再取一次。
    // 直接 return 而不 apply，是为了让增量合并与全量刷新严格互斥，不产生混合投影。
    if (deliveryKind === "online" && this.recovery) {
      if (frame.toSeq > this.state.seq) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    // [契约] 没应用过 base 的 deltas 一律拒收：本地缺少起点，任何合并都会得到错误全量。
    // 转 requestRecovery，recoveryEvent 取决于该帧是否 recovery 投递，进而影响 flight 的升级策略。
    // 不要用“先缓存等 snapshot”兜底：缓存补偿会掩盖协议层断档，也让水位无法收敛。
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    const gap = this.applyFrame(frame);
    if (gap && this.transport) {
      logger.warn(
        `[v4-sessions-index] 帧断档 fromSeq=${frame.fromSeq} local=${this.state.seq}，重订阅`,
      );
      if (initial) void this.connect(this.transport, { forceSnapshot: true });
      else this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.subscriptionHasAppliedBase = true;
    if (deliveryKind === "recovery") this.markRecoveryFrameSeen();
  }

  private handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会重投同一批被拒的内容。
    // 直接跳到唯一可能产出不同字节的强制 snapshot；它再被内容拒绝就停手。本 store 的 fail
    // closed 会清空投影并有界退避重订阅——对确定性失败那就是一个永不收敛的重订阅循环。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null),
    );
  }

  // [并发] recovery 入口做三件事：去重、记录内容失败归属、决定 resume 还是强制 snapshot。
  // 已有 flight 时非 recovery 事件只合并 contentFault；recovery 事件在 resume 已 ACK 时升级为 snapshot。
  // 已处于 forceSnapshot 再失败直接 failRecovery，不再尝试第二条恢复路径。
  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    const transport = this.transport;
    const subscriptionId = this.subscriptionId;
    if (this.closed || !transport || !subscriptionId) return;
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null as "snapshot" | "resume" | null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  // [事务] 发 resync 前先复位 flight 的阶段位，并把 base 与 forceSnapshot 一起定稿。
  // 没有可信 base 时 base 传 null：服务端只能给 snapshot，本端不伪造 seq 起点。
  // ACK 回来要核对 subscriptionId 未变，否则按 resyncGenerationMismatch 走失败路径。
  private issueRecovery(
    recovery: NonNullable<SessionsIndexStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    const transport = this.transport;
    if (!transport) return;
    this.clearRecoveryDeadline(recovery);
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.validFrameSeen = false;
    recovery.upgradePending = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          !this.subscriptionHasAppliedBase || this.state.logEpoch === null
            ? null
            : { logEpoch: this.state.logEpoch, seq: this.state.seq },
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-sessions-index] resync 失败: ${message}`);
        if (isRuntimeUnavailableError(error)) {
          this.handleRuntimeUnavailable();
          return;
        }
        if (message.includes("fault.subscription.notOwned") && this.transport) {
          // 与 conversationProjectionStore.issueRecovery 同因（线上事件）：
          // notOwned 是 ownership 状态分歧的确定性失效而非瞬态故障，停在 error 会让
          // 会话列表永久卡死。携当前水位 fresh subscribe 由服务端裁决 resume/snapshot，
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect(this.transport);
          return;
        }
        this.failAndScheduleRecovery(`resync:${message}`);
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  // [并发] 收敛条件：ACK 已到、无请求在飞，且本 flight 仍是 this.recovery（未被换代丢弃）。
  // upgradePending 优先：resume 不足以修复就升级 snapshot；已强制 snapshot 仍缺帧则直接失败。
  // 无有效帧时挂 frameDeadline，超时先升级一次，再超时按传输症状终态，不误标内容拒绝。
  private settleRecovery(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) this.issueRecovery(recovery, false);
      else this.recovery = null;
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private clearSubscribeRetry(): void {
    if (!this.subscribeRetryTimer) return;
    clearTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
  }

  private clearErrorRecoveryRetry(): void {
    if (!this.errorRecoveryRetryTimer) return;
    clearTimeout(this.errorRecoveryRetryTimer);
    this.errorRecoveryRetryTimer = null;
  }

  /**
   * 内容确定性失败：终态 code 与传输失败区分，且**不排退避重订阅**——重订阅会拿到同一份读不懂的
   * 内容，本 store 的退避会因此变成永不收敛的循环（清空投影 → 重订阅 → 再被拒 → …）。自愈仍有
   * 路径：runtime 换代、fresh connect、用户重连都会重新订阅；被拿掉的只是那个循环。
   *
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，不该被重标
   * 成 contentRejected，更不该因此取消那次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    // contentFault 必须在 discardRecovery 之前读。
    const contentFault = this.recovery?.contentFault === true && options.contentEligible !== false;
    this.failAndScheduleRecovery(contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode, {
      scheduleRetry: !contentFault,
    });
  }

  /**
   * recovery/subscribe 失败时撤销旧 projection 的 live 证明，并用有界退避重新取权威
   * snapshot。error 仍对外可观测；重试仅在 transport/runtime 仍属于当前代际时执行。
   *
   * `scheduleRetry: false` 只给确定性失败用：重试必然得到同一结果时不该排它。
   */
  // [事务] fail-closed 原子清空：recovery、subscriptionId、awaitingInitial、base 证明、投影与列表缓存。
  // 清空是有意的：runtime 不在或内容读不懂时，保留旧投影等于展示失去 live 证明的假状态。
  // scheduleRetry=false 只给确定性失败；其余按 5/15/60s 有界退避，且仅当前代际有效。
  private failAndScheduleRecovery(
    reasonCode: string,
    options: { scheduleRetry?: boolean } = {},
  ): void {
    const transport = this.transport;
    const previousSubscriptionId = this.subscriptionId;
    this.discardRecovery();
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "error";
    logger.warn(`[v4-sessions-index] recovery fail-closed: ${reasonCode}`);
    if (transport && previousSubscriptionId) {
      void unsubscribeIgnoringFailure(transport, previousSubscriptionId);
    }
    this.clearErrorRecoveryRetry();
    if (transport && !this.closed && options.scheduleRetry !== false) {
      const attempt = this.errorRecoveryRetryAttempt;
      const delayMs =
        ERROR_RECOVERY_RETRY_DELAYS_MS[
          Math.min(attempt, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1)
        ];
      const nextAttempt = Math.min(attempt + 1, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1);
      const generation = this.generation;
      this.errorRecoveryRetryAttempt = nextAttempt;
      this.errorRecoveryRetryTimer = setTimeout(() => {
        this.errorRecoveryRetryTimer = null;
        if (this.closed || this.transport !== transport || this.generation !== generation) {
          return;
        }
        void this.connect(transport, {
          forceSnapshot: true,
          errorRecoveryRetryAttempt: nextAttempt,
        });
      }, delayMs);
    }
    this.emit();
  }

  // [并发] restart 事件合并为一次 fresh subscribe，按连续次数指数退避，30s 稳定后恢复首跳。
  // 每条 restart 立即 connect 会让 subscribe 反向触发更多 runtime 启动，形成无上限重连风暴。
  // 此处只递增 generation 并清本地证明，真正重连交给 timer，close 后不再执行。
  private handleRuntimeRestart(): void {
    if (this.closed || !this.transport) return;
    const transport = this.transport;
    const now = Date.now();
    if (now - this.lastRuntimeRestartAt >= RUNTIME_RESTART_BURST_RESET_MS) {
      this.runtimeRestartBurstCount = 0;
    }
    this.lastRuntimeRestartAt = now;
    const delayMs =
      this.runtimeRestartBurstCount === 0
        ? 0
        : Math.min(
            RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS *
              2 ** Math.min(this.runtimeRestartBurstCount - 1, 16),
            RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS,
          );
    this.runtimeRestartBurstCount += 1;
    this.generation += 1;
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    if (this.status !== "connecting") {
      this.status = "connecting";
      this.emit();
    }
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
    }
    // runtimeRestarted 不能每到一条就立即 connect。若上游异常地连续发布
    // restart，subscribe 会反向触发更多 runtime 启动，形成无上限重连风暴。这里将 burst
    // 合并为一次 fresh subscribe，并按连续次数指数退避；稳定 30 秒后恢复首跳立即重连。
    this.runtimeRestartReconnectTimer = setTimeout(() => {
      this.runtimeRestartReconnectTimer = null;
      if (this.closed || this.transport !== transport) return;
      void this.connect(transport, { forceSnapshot: true });
    }, delayMs);
  }

  private handleRuntimeAvailable(): void {
    if (this.closed || !this.transport) return;
    this.handleRuntimeRestart();
  }

  // [失败路径] runtime 缺失进入 dormant：不排 timer，等 lifecycle available 再走 restart 路径。
  // 必须清空投影与 cachedList：旧 summary 的 running/attention 已失去 live 证明，会留下孤儿 spinner。
  // 持久 task 行归 tasks-index 保留，这里只负责 sessions-index 这一层不展示假状态。
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.generation += 1;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    // runtime 已不存在时旧 summary 的 running/attention 失去 live 证明；持久 task 行由
    // tasks-index 保留，sessions-index 投影必须清空以避免孤儿 spinner。
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "dormant";
    this.emit();
  }

  /** 释放订阅与监听（组件卸载 / workspace 切换）。 */
  // [资源] close 递增 generation 并置 idle，先 detach 本地监听，再 best-effort 退订远端。
  // 不再 emit：卸载后的监听者已销毁，继续通知只会造成 setState 警告与悬空引用。
  // close 后允许再次 connect（StrictMode 双调走同一路径），因此清理必须幂等。
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.status = "idle";
    const previous = this.detachTransport();
    if (previous.subscriptionId && previous.transport) {
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
  }

  // [资源] 统一拆除点：清三类 timer、反注册四个监听、丢弃 flight 与全部代际证明。
  // burst 计数与 lastRuntimeRestartAt 一并归零，避免旧 transport 的退避历史影响新连接。
  // 返回旧 transport/subscriptionId 供调用方决定是否远端退订，本函数不发 RPC。
  private detachTransport(): {
    transport: SessionsIndexTransport | null;
    subscriptionId: string | null;
  } {
    const previous = {
      transport: this.transport,
      subscriptionId: this.subscriptionId,
    };
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.runtimeRestartBurstCount = 0;
    this.lastRuntimeRestartAt = 0;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.frameUnsub?.();
    this.frameUnsub = null;
    this.faultUnsub?.();
    this.faultUnsub = null;
    this.restartUnsub?.();
    this.restartUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.transport = null;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    return previous;
  }

  /** 应用一帧；断档返回 true（调用方重订阅）。 */
  applyFrame(frame: SessionsIndexTopicFrame): boolean {
    const { state, gap } = applySessionsIndexFrame(this.state, frame);
    if (gap) return true;
    if (state !== this.state) {
      this.state = state;
      this.cachedList = null;
      this.emit();
    }
    return false;
  }

  /** 断档/重连时清空，等待新 snapshot。 */
  reset(): void {
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.emit();
  }

  /** 会话列表（默认按 lastActivityAt 降序；分组/pin 是更上层逻辑）。 */
  // [契约] 返回按 lastActivityAt 降序的稳定数组；分页切片与“下一页”游标由上层持有。
  // 本 store 不保存 listCursor：翻页不得改动 seq 水位，否则与增量流的水位语义冲突。
  // 排序只在缓存失效后的首次读取发生，调用方不要原地修改返回数组。
  getSessions(): SessionSummary[] {
    if (this.cachedList === null) {
      this.cachedList = [...this.state.sessions.values()].sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      );
    }
    return this.cachedList;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
