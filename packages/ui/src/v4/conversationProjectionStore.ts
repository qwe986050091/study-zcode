/**
 * ============================================================================
 * ui/v4/conversationProjectionStore.ts —— 单会话投影的只读客户端 store
 * ============================================================================
 *
 * 【定位】每个 conversation topic 一个 store；唯一写入方是订阅推送，UI 只读。
 *   snapshot 原子替换，delta 按 seq 连续 apply，optimistic overlay 只用于
 *   "命令已上行、服务端尚未确认"的临时展示。
 *
 * 【三条客户端纪律（不能放宽）】
 *   1) snapshot → 整体替换，绝不 merge；
 *   2) delta 帧只在区间衔接（frame.fromSeq === snapshot.seq）时 apply；
 *      断档不猜、不缓存补偿，携当前水位重订阅，由服务端裁决 resume/snapshot；
 *   3) base 与状态同生共死——断档时状态未被污染。
 *
 * 【runtime 回收退避】CUA Helper 冷启动等场景会回收 agent runtime，在途
 *   subscribe 被 rejectAll 打断。这里按有界退避（250/1000/3000ms）重连；
 *   不能把瞬态失败定格成 status="error"，否则懒启动的 agent 可能无人拉起。
 *
 * 【半开通道自愈】accepted ACK 后若 2s 内仍看不到权威输入投影，只恢复订阅，
 *   不重放命令；命令重放必须由 commandId 幂等与 query 裁决，不能靠客户端补发。
 *
 * 【事实边界】除 optimistic overlay 外，本 store 不产生任何 conversation 事实；
 *   所有业务状态以服务端 projection 为唯一真相。
 * ============================================================================
 */
/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机，拆分会重新引入跨对象竞态。 */
// 模块定位：每个 conversation topic 一个只读客户端 store，唯一写入方是订阅推送，UI 侧只读。
// 数据流：snapshot 原子替换 → delta 按 seq 连续合并 → optimistic overlay 仅作未确认展示。
// 设计权衡：投影行按值共享，用一次比较换取十几份大字符串不重复常驻 renderer 堆。
// 事实边界：除 optimistic overlay 外本文件不产生 conversation 事实，业务状态以服务端投影为准。
// INV-01 不变量：snapshot 帧整体替换投影，不与会话旧行做 merge；守住位置：applyFrame 的 payload.kind 为 snapshot 分支；改错故障：已删除行被旧值复活，时间线出现重复气泡。
// INV-02 不变量：delta 帧仅在 fromSeq 等于本地 seq 时合并，断档一律重订阅；守住位置：applyFrame 的衔接判定；改错故障：帧被错拼到旧水位，消息顺序与内容错位。
// INV-03 不变量：ACK 的 snapshot 模式不构成 applied base，需等真正首帧；守住位置：connect 尾部对 subscriptionHasAppliedBase 的赋值；改错故障：新 epoch 的 delta 拼到旧投影，会话内容整体错乱。
// INV-04 不变量：订阅代际单调递增，过期 ACK 必须立即退订；守住位置：connect 中 generation 比对分支；改错故障：服务端残留无人消费的订阅，帧流被重复投递。
// INV-05 不变量：connectInFlight 计数在途连接，available 通知不得叠加新订阅；守住位置：handleRuntimeAvailable 的提前返回；改错故障：同 topic 双订阅互相替换，面板可能永久停在无快照。
// INV-06 不变量：runtime 换代失败按 250/1000/3000ms 有界退避，不直接落 error；守住位置：scheduleRuntimeRecycleReconnect；改错故障：懒启动的 agent 无人拉起，面板只能等用户手点重连。
// INV-07 不变量：退避额度耗尽才落 error，必须留下可点击的重连入口；守住位置：handleRuntimeUnavailable 的末尾状态；改错故障：connecting 且无定时器，面板永久转圈且无法手动恢复。
// INV-08 不变量：recovery flight 单飞，同一时刻至多一个 resync 在途；守住位置：requestRecovery 对 existing 的分支；改错故障：多个 resync 竞争同一订阅，ACK 与帧归属错配。
// INV-09 不变量：内容确定性失败跳过 resume 阶梯，直接强制 snapshot；守住位置：handleAssemblyFault 的 isDeterministicContentFault 分支；改错故障：同一批坏 delta 被反复投递并反复拒绝，订阅被烧空。
// INV-10 不变量：recovery 内容失败标记一经置位，后续瞬态 fault 不得洗白；守住位置：requestRecovery 对 existing 内容的标记；改错故障：遥测把版本失配读成网络抖动，重连策略随之误判。
// INV-11 不变量：recovery 帧看门狗超时先升级 snapshot，再超时才失败；守住位置：settleRecovery 的 frameDeadline 回调；改错故障：recovery 静默悬挂，投影停在水位不再推进。
// INV-12 不变量：plan 目录 revision 随 snapshot 与终态 ExitPlanMode 递增；守住位置：shouldInvalidatePlanDirectory；改错故障：旧分支计划目录继续显示，用户看到已废弃的计划。
// INV-13 不变量：导航目录终态需 logEpoch 与 directoryRevision 双匹配；守住位置：loadAllOlder 的缓存命中判定；改错故障：同一 epoch 内新增问题后终态永久命中，导航栏缺轮次。
// INV-14 不变量：turn navigator 仅在 real-user userInput 增删时递增 revision；守住位置：shouldInvalidateTurnNavigatorDirectory；改错故障：流式文本每帧触发重探测，历史补拉被反复拉起。
// INV-15 不变量：optimistic overlay 只在服务端投影出现同 commandId 后退场；守住位置：reconcileOptimistic；改错故障：命令失败后气泡永久残留，或未确认就闪退。
// INV-16 不变量：accepted input 宽限窗口内未见权威投影只恢复订阅，不重放命令；守住位置：expectAcceptedInputProjection 的定时器；改错故障：命令被重复执行，用户看到两条相同消息。
// INV-17 不变量：投影行按值共享，快照替换时复用池中旧引用；守住位置：shareSnapshotRows 与 shareDeltaRows；改错故障：同一长文本在上百份快照中各存一份，renderer 内存线性膨胀。
// INV-18 不变量：行池只登记不替换 delta 行，避免流式逐帧深比较；守住位置：shareDeltaRows 的 remember 分支；改错故障：流式输出期间每帧全窗口比对，输入明显卡顿。
// INV-19 不变量：close 之后所有回调、定时器与监听必须短路，不再写状态；守住位置：close 的清退序列与各处 closed 早退；改错故障：已卸载面板收到迟到帧，React 报更新已卸载组件。
// INV-20 不变量：liveProjectionStores 构造时登记、close 时移除，行数统计随之收敛；守住位置：构造函数与 close 首段；改错故障：内存诊断常驻虚高，无法判断真实窗口增长。
import {
  applyConversationDeltas,
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * runtime 换代打断 subscribe 后的退避节奏。
 *
 * CUA Helper 冷启动就绪会 recycleUntilStable → disposeWorkspace 回收 agent
 * runtime，在途 subscribe 被 rejectAll 打断。若把这次瞬态失败定格成 status="error"，
 * 懒启动的 agent 在 dispose 后可能无人拉起，onRuntimeRestart 就不会到达，面板只能靠用户
 * 手点「重新连接」。subscribeConversationV4 走 start-if-needed，重订阅自身会拉起 runtime，
 * 所以这里按 sessionsIndexStore 的既定模式做有界退避。
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * accepted ACK 后等待权威输入投影的宽限期。
 *
 * Core admission 的 ACK 不等待 TurnStarted/QueueItem/userInput 投影；正常情况下这两条
 * 路径只相差一个 renderer/network round-trip。把窗口设为 2s 可以覆盖正常 desktop/mobile
 * 延迟，又能尽快从“CLI 继续工作、订阅完全静默”的半开通道自愈。超时只恢复订阅，不重放命令。
 */
export const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText", "editUserQuery"]);

export function requiresAcceptedInputProjection(type: string): boolean {
  return ACCEPTED_INPUT_COMMAND_TYPES.has(type);
}

/** 退避耗尽时展示给用户的 lastError（无底层 error 对象可引用的换代路径）。 */
const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime 已被回收，重连未成功";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * 是否为 runtime 换代/回收导致的瞬态 subscribe 失败。
 *
 * 已知文案都来自同一次回收：transport 关闭时 ZCodeProtocolClient.rejectAll 打断在途请求
 * （transport closed），复用已回收 client 时 assertNotDisposed 早退（client disposed），
 * 以及 runtime 尚未重新拉起时的 fail-fast（runtime is not running）。
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // 冷订阅可能亲自拉起新 runtime；restart 令在途 ACK 失效后仍须有界重订，不能停在 error。
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // subscribe 在途（首连或断档重订阅）。
  | "connecting"
  // 已订阅且帧连续。
  | "live"
  // subscribe 失败，等待 retry()。
  | "error"
  // 已释放（SessionDataLayer 退订后），不再接受任何操作。
  | "closed";

/** optimistic overlay 条目：命令已上行、服务端尚未在投影中确认。 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** 首次 conversation subscribe 的低频 Host/CLI timing；不进入 snapshot 事实。 */
  openTiming?: ConversationOpenTiming;
  /** Renderer 首帧 timing；与 snapshot 一起通知，避免 UI 读取到半更新的诊断状态。 */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** loadOlder 在途标记（自动预取防重入）。 */
  loadingOlder: boolean;
  /** CLI 完整有效 projection 返回的终态计划目录。 */
  sessionPlans: readonly ToolCallRow[];
  /** 只用于触发计划目录只读 query，不属于 conversation 协议事实。 */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * 问题导航目录（turn navigator）的失效代际。
   * not-enough-queries 终态过去只以 logEpoch 判定有效，但
   * "是否已有 ≥2 条可导航 query"是随增量变化的派生条件，logEpoch 表示日志代际而非
   * 内容静止。real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
   * 或 row.removed 截断分支）与 snapshot 整体替换时递增此 revision，使终态缓存失效。
   */
  turnNavigatorDirectoryRevision: number;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/**
 * 问题导航目录是否需要失效。
 * not-enough-queries 终态曾只以 logEpoch 判定，导致同一 epoch
 * 内追加 real-user query 后永久命中缓存。判定条件：
 * - snapshot 整体替换 → true（全新状态，终态作废）；
 * - row.removed → true（rewind/分支裁剪改变可导航 query 集合）；
 * - row.appended/row.upserted 命中 realUser userInput → true（新增/变更用户问题）；
 * - 其余 delta（assistant text、tool、reasoning 流式）→ false，不触发重探测。
 */
// 不变量：只有 real-user userInput 的增删才递增导航 revision，其余帧不触发。
// 失败路径：漏判会让 not-enough-queries 终态跨内容变化命中，导航栏永久缺轮次。
// 设计权衡：assistant 文本与工具帧被排除，用精度换掉每帧重探测的开销。
function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // 交互 bug 的根因位于订阅快照交接，不在 React DOM；仅在 Agent 运行集变化时
  // 记录轻量身份与水位，使本地复现能区分合法终态和迟到快照覆盖。
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * 还有更早历史可拉 ⇔ 窗口首行不是全序首行（firstRowId 判定）。
 * 纯函数供 store/组件共用；快照缺失/空窗口/未知 firstRowId 一律 false。
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * 冷快照尾窗是否从一个 turn 的中间截断。turnHeader 是完整 turn 的权威起点；首行允许是
 * lightBoundary，因此不能只判断首行 kind，必须检查首个 turn 在当前窗口里是否已有 header。
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）。
 */
// 不变量：只收 rowId 小于窗口首行的行，按 rowId 升序前插保持全序。
// 失败路径：无可并入行返回 null，调用方据此不换引用以免无谓重渲染。
// 边界：空窗口把首行视为正无穷，首屏补拉因此可以整体并入。
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * 外部 store（useSyncExternalStore 兼容：subscribe + getState 返回稳定引用）。
 * 生命周期由 SessionDataLayer 管（引用计数 + keep-warm），组件不直接 new。
 */
// 内存诊断计数器：统计存活 store 数与其 rows.window 行数之和，
// 用于观察窗口数据的内存增长。构造时加入、close() 时移除。
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  /** live-only 增量（插件资源通知）的旁路监听；只在 delta 帧应用后触发，快照帧不触发。 */
  private readonly liveDeltaListeners = new Set<(deltas: readonly ConversationDelta[]) => void>();
  private observedModelTransitionEventId: string | null = null;
  // 订阅代际：并发 connect 只认最新一代，过期结果立即退订防服务端悬挂。
  private generation = 0;
  // 首次订阅尚未拿到 ACK 时，runtime available 只是当前启动流程的正常完成信号；
  // 记录在途数量，避免生命周期通知再次启动 connect，制造同 topic 的订阅替换竞态。
  private connectInFlight = 0;
  /**
   * subscribe ACK mode 持久到该代首个 logical frame；不能只依赖同步 activate 栈，
   * 因为 notification 可在 ACK Promise resolve 后异步到达。
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** 当前 subscription 是否已由旧 applied base 或本代 logical frame 证明水位有效。 */
  private subscriptionHasAppliedBase = false;
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
    /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，不混进瞬态统计。 */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /** accepted input 的 projection confirmation watchdog；不承载命令，也不生成本地事实。 */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // hydrated/not-enough-queries 终态缓存。过去仅以
  // logEpoch 判定有效，同一 epoch 内追加 real-user query 后仍永久命中。现追加
  // directoryRevision——real-user query 增删会递增该 revision，使终态失效重探测。
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  private closed = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
    // 行结构共享池（docs/performance/conversation-row-structural-sharing.md）；
    // SessionDataLayer 注入跨 store 共享的池，独立构造时退化为 store 内共享。
    private readonly rowPool: ConversationRowPool = new ConversationRowPool(),
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // runtime 换代（CLI 进程换代）按 sessionsIndexStore 的约定优先走 lifecycle：dispose
    // 当场只有 unavailable 可观测，onRuntimeRestart 要等新进程 spawn——懒启动下可能永不到达。
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // proxy handoff 不是 runtime 换代，只有 restart 通道携带该语义——
      // ReplaceableConversationTransport.replace() 只广播 runtimeRestartListeners，不发任何
      // lifecycle 事件。若这里因"二选一"完全放弃 restart 通道，远程 workspace 的 proxy 换代
      // 就无人接收：replace() 已 best-effort 退订旧 proxy 的订阅，store 却停在 live + 旧
      // subscriptionId，帧流静默中断且不自愈。
      // 只认 transportReplaced 即可两不重叠：底层 runtime restart 经 bindRuntimeRestartListener
      // 转发时调的是 listener()（reason 为 undefined），已由 lifecycle 的 available 接管。
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 订阅每一帧应用后的增量列表。用途是 live-only 的 `pluginUi.*` 增量（它们不改行、不进快照），
   * 常规行状态仍以 subscribe + getState 为准。
   */
  onLiveDeltas(listener: (deltas: readonly ConversationDelta[]) => void): () => void {
    this.liveDeltaListeners.add(listener);
    return () => this.liveDeltaListeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * 发起/重发订阅。base 取自当前 snapshot 水位（水位不变量：仅当真持有该时刻
   * 一致状态才携带）；forceSnapshot 用于 resume 续传帧仍断档的兜底，丢 base 要全量。
   */
  // 不变量：订阅 base 只在快照与订阅时刻同源时携带，forceSnapshot 一律丢 base。
  // 失败路径：initialFrameStagingOverflow 只允许自动重试一次，防止异常对端造成重试风暴。
  // 并发：generation 自增后立即比对 ACK，陈旧一代的订阅当场退订不留给服务端悬挂。
  // 事务语义：ACK 成功先落 subscriptionId 再 activate，activate 才能同步释放同 read 内的 initial。
  // 失败路径：runtime 换代类错误交给有界退避，其余错误才落 error 暴露手动重连。
  // 资源：finally 恒减 connectInFlight，异常路径不会让在途计数永久虚高。
  async connect(
    options: {
      forceSnapshot?: boolean;
      retryInitialization?: string;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
        ...(options.retryInitialization
          ? { retryInitialization: options.retryInitialization }
          : {}),
      });
      if (generation !== this.generation || this.closed) {
        // 过期代际：这份订阅已无人消费，立即退订。
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // 线上 fault.subscription.notOwned 卡死的根因：connect() 只在发起时
      // discardRecovery，subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery；
      // 而 host scope 在新 ACK remember() 时已按 ownershipKey 静默驱逐旧订阅，该 recovery
      // 的在途 resync 注定被 notOwned 拒绝。换代成功即丢弃旧 recovery——新订阅的 initial
      // 会原子替换整个投影，旧恢复流已无意义；否则其迟到失败会把 live 的新订阅打成 error。
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // 公共 result 已是 ACK-only；initial 与 online 统一走 notification。
      // subscriptionId 必须先入 store，activate 才能同步释放同一 read 中暂存的 own initial。
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // ACK 前 physical batch 已残缺，active same-sub 尚不存在；只能 fresh
        // subscribe 强制 snapshot。最多自动一次，避免异常 peer 造成重试风暴。
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * runtime 换代导致的 subscribe 失败：保持 connecting 并有界退避重连。
   * 返回 true 表示已接管本次失败，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * 有界退避重连。重订阅走 start-if-needed（zcodeAgentService.subscribeConversationV4），
   * 自身即可把懒启动的 runtime 拉起来——这是 available 永不到达时唯一的自愈路径。
   * 返回 true 表示已接管，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // 保留旧 snapshot：换代期间投影未被污染，重连成功会原子替换。
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** workspace-dispose 当场：旧 runtime 已死，新的尚不存在，不可重订阅。 */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // 旧 subscriptionId 属于已死 runtime，不得再 unsubscribe（host 侧 owner 已失效）。
    this.setState({ status: "connecting", subscriptionId: null });
    // 不能只 dormant 等 available：agent 懒启动，dispose 后无人拉起时该信号永不到达，
    // 面板会永久转圈。退避重连自身会拉起 runtime；available 先到则复位计数并即时重连。
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // 退避额度耗尽（runtime 反复回收）：必须落 error 暴露「重新连接」入口，
    // 否则 connecting 无 timer 就是永久转圈，连手动重试都没有。
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** 新 runtime 就绪：与 onRuntimeRestart 同义，携原水位重订阅。 */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // 冷启动 spawn 会在首次 subscribe ACK
      // 返回前广播 available。若这里立即再 connect，服务端会按同一 connection/topic
      // 替换旧订阅；旧 ACK 随即被本地代际防护退订，首帧交接存在竞态，面板可能永久无快照。
      // 当前在途 connect 已经负责完成这次启动，不需要重复重订阅。
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** 订阅失败后的手动重试入口（pane 层「重新连接」按钮落点）。 */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    const initialization = this.state.snapshot?.runtimeInitialization;
    return this.connect(
      initialization?.status === "failed" ? { retryInitialization: initialization.attemptId } : {},
    );
  }

  /** row command/query 的 epoch/entity authority 失效，复用 same-sub recovery 收敛。 */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** SessionDataLayer 帧路由入口。 */
  // 代际防护：subscriptionId 与当前状态不符的迟到帧直接丢弃，不进入任何分支。
  // 事务语义：只有 deliveryKind 为 initial 的帧才消费 awaitingInitial，recovery 帧优先清除它。
  // 失败路径：deltas 帧在无 applied base 时请求 recovery，绝不把新 epoch 拼到旧投影。
  // 并发：recovery 期间到达的 online 只登记 postRecoveryGapPending，不在 flight 内重复应用。
  // 边界：online 的完整 snapshot 可建立 applied base，但不冒充 recovery delivery 收口 flight。
  // 失败路径：帧断档交由 requestRecovery 或换代重订阅，本函数不做任何补偿性猜测。
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际防护：旧订阅的迟到帧直接丢弃。
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC 时序无法证明帧用途。只有 publisher 标记的 initial 才消费
    // awaitingInitial；recovery 必须优先清除此状态，避免 recovery gap 被误判为
    // original subscribe gap 而换新 subId。迟到 online duplicate 不得消费任何闸门。
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // online overflow snapshot 本身是完整权威状态，可建立 applied base；但它不冒充
      // recovery delivery，flight 仍等待自己的 recovery frame/ACK 收口。
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // recovery reservation 之后的 online 可能与 ACK 同 read 到达；在 recovery
      // logical frame 已 apply 后看到非重复 online，ACK 收口时必须再开 successor flight。
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) 不构成 applied base；initial 丢失后即便数值 fromSeq 恰好
      // 对上旧 projection，也不能把新 epoch delta 拼到旧状态。
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  // 不变量：snapshot 分支整体替换并同步递增两个目录 revision，派生缓存随事实一起作废。
  // 失败路径：toSeq 不大于本地水位视为迟到或重复帧，只收口 recovery 不重复合并。
  // 失败路径：fromSeq 不衔接时按 subscribeMode 分流，resume 首帧断档则强制全量防循环。
  // 事务语义：delta 合并后一次性 setState 提交，行、目录 revision 与水位在同一引用内可见。
  // 生命周期：snapshot 替换后立即对账 overlay 与 accepted 看门狗，避免覆盖后状态悬空。
  // 设计权衡：首帧只播种 modelTransition 观察基线，迟到的持久事件不冒充实时通知。
  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      const snapshot = this.shareSnapshotRows(frame.payload.snapshot);
      logSubagentProjectionTransition(this.topic, this.state.snapshot, snapshot, "snapshot");
      // 规则 1：整体替换，扔掉手里的一切换新的（行对象按值复用旧引用，语义仍是整体替换）。
      this.setState({
        snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // snapshot 整体替换后 real-user query 集合可能已变，终态缓存必须失效。
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(snapshot);
      this.reconcileAcceptedInputProjection(snapshot);
      // Bug 原因：initial 丢失时，publisher 允许完整 online snapshot 建立首个
      // applied base；其中的持久 transition 可能早于本次订阅，不能冒充实时新事件。
      // 首帧只播种观察基线，后续 online 跃迁才通知 pane。
      this.observeModelTransition(snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // 规则 2a：迟到/重复 logical frame 永远静默丢弃。若它是 ACK 后的 aligned
    // recovery `(N,N]`，则只收口 flight，不重复 apply。
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // 规则 2：断档不猜。状态本身仍是 seq=current.seq 时刻的一致投影（这帧没碰它），
      // 所以 base 仍合法——重订阅让服务端裁决续传或全量；若断档发生在 subscribe 的
      // resume 续传帧上（服务端已裁决过一次仍不衔接），丢 base 强制 snapshot 防循环。
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // fresh subscribe 的 resume initial 仍断档，换代订阅强制 snapshot；active
        // subscription 的 online/recovery gap 则保持 same-sub。
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq 是快照对齐水位（R-03），delta 帧应用完推进到帧右端点。
    const next = this.shareDeltaRows({ ...applied, seq: frame.toSeq }, frame.payload.deltas);
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    this.setState({
      snapshot: next,
      // row.removed 已给出权威裁剪边界，可以同步删掉缓存目录中的旧分支计划；
      // 完整 query 继续负责补回 wire tail 之外、但仍属于当前分支的早期计划。
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
      // 或 row.removed 截断分支）递增导航目录 revision，使终态缓存失效允许重新探测。
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
    for (const listener of this.liveDeltaListeners) listener(frame.payload.deltas);
  }

  /**
   * Bug 原因：整份 snapshot 的行全是新反序列化对象，历史 snapshot 被闭包链留住时每份各持
   * 一套大字符串（同一 inputText 上百份）。这里把值相等的行 / 子值换回池中旧引用。
   */
  /** rows/range 补拉的历史行与池中仍存活的旧行共享（冷打开后往上翻时常见）。 */
  private shareRows(rows: readonly ConversationRow[]): ConversationRow[] {
    return rows.map((row) => this.rowPool.shareRow(this.topic, row));
  }

  private shareSnapshotRows(snapshot: ConversationSnapshot): ConversationSnapshot {
    const window = this.rowPool.shareWindow(
      this.topic,
      snapshot.rows.window,
      this.state.snapshot?.rows.window,
    );
    return window === snapshot.rows.window
      ? snapshot
      : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  /** row.upserted / row.appended 的新行做共享；row.delta 只登记，避免流式逐帧深比较。 */
  // 不变量：只有 upsert 与 append 的行做共享，delta 行仅登记不下沉深比较。
  // 资源：窗口引用只在确有替换时才复制，未命中的帧保持原快照对象。
  // 失败路径：窗口为空或全未命中时原样返回，调用方可按引用相等跳过通知。
  // 设计权衡：流式逐帧深比较代价高于收益，故对 delta 行只登记不替换。
  private shareDeltaRows(
    snapshot: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
  ): ConversationSnapshot {
    const shareIds = new Set<number>();
    const rememberIds = new Set<number>();
    for (const delta of deltas) {
      if (delta.op === "row.upserted" || delta.op === "row.appended") shareIds.add(delta.row.rowId);
      else if (delta.op === "row.delta") rememberIds.add(delta.rowId);
    }
    if (shareIds.size === 0 && rememberIds.size === 0) return snapshot;
    let window: ConversationRow[] | null = null;
    snapshot.rows.window.forEach((row, index) => {
      if (shareIds.has(row.rowId)) {
        const shared = this.rowPool.shareRow(this.topic, row);
        if (shared !== row) {
          window ??= [...snapshot.rows.window];
          window[index] = shared;
        }
      } else if (rememberIds.has(row.rowId)) {
        this.rowPool.remember(this.topic, row);
      }
    });
    return window === null ? snapshot : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // 持久 transition 会随 initial/recovery snapshot 重放；若只在 toast 时记 ID，
    // 后续普通 online snapshot 会把旧 fallback 误当新事件。所有合法帧都更新观察基线，
    // 只有首次实时 online 跃迁才通知当前客户端。
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** physical assembly fault：旧 projection 保持可见，active sub 上 single-flight 恢复。 */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会把同一批 delta 再投一遍，
    // 必然再被拒；deliveryKind 也不改变结论——本端读不懂这份内容。唯一可能产出不同字节的是
    // 强制 snapshot，所以直接跳到它，它再被内容拒绝就停手，不把订阅烧在必然失败的重试上。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // 缺失/伪 deliveryKind 会以 undefined typed fault 到达；若 recovery 已在途，
    // 必须 fail closed/升级，不能把坏 recovery 当普通 burst 后永远等待。
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  // 并发：已有 flight 时只升级标记或复用，不新开 resync 以避免双流竞争。
  // 失败路径：无 subscriptionId 时退化成携水位 fresh subscribe，而不是原地等待。
  // 事务语义：内容失败标记写进现有 flight，终态归类不被后续瞬态错误覆盖。
  // 失败路径：forceSnapshot 的 flight 再收到 recovery 事件即 fail-closed，不无限升级。
  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 里出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault 可早于 ACK Promise continuation；记住升级意图，
      // ACK=resume 后立即 force snapshot。普通 burst gap 不设置此标记。
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
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  // 不变量：未建立 applied base 时强制 snapshot，base 只在水位可证时携带。
  // 事务语义：每次 resync 前清空 ACK、帧与升级标记，旧 flight 的残留状态不复用。
  // 失败路径：resync 返回的 subscriptionId 不符即按世代错配失败，防止接错订阅。
  // 资源：then 与 catch 先比对 recovery 身份再写状态，被替换的 flight 不污染新订阅。
  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
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
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // 线上事件：notOwned 表示某一层已不认这份 subscription
          // ownership（scope 换代静默驱逐、错位 unsubscribe 等状态分歧），是确定性失效
          // 而非瞬态故障；停在 error 等手动重连会让会话永久卡死。本地 snapshot 仍是一致
          // 投影，携当前水位 fresh subscribe 由服务端裁决 resume/snapshot（04-sync 规则 3），
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  // 不变量：收口要求 ACK 已到且无在途请求，缺一条件即返回等待。
  // 并发：升级意图优先于已见帧，resume 模式先升级 snapshot 再收口。
  // 失败路径：升级时 ACK 非 resume 即 fail-closed，避免在不支持的档位上打转。
  // 失败路径：帧看门狗超时先升级一次 snapshot，再超时才算确定性失败。
  // 资源：deadline 句柄在收口、升级与丢弃三处都要清空，防止定时器泄漏。
  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
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
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
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

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，即使本次
   * flight 起因是内容失败，也不该被重标成 contentRejected——那会连带取消一次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // 内容确定性失败与传输失败必须可区分：前者重连不会变好，遥测按 code 聚合时也不该把一次
    // 版本失配读成网络抖动（reasonCode 词表见 wire-fault.ts）。
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // transport 已先失效旧 ownership/assembler；旧 transport/runtime subId 不得再 unsubscribe，
    // 直接 fresh subscribe，保留旧 snapshot 直到新 snapshot 原子替换。
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // proxy handoff 不等于 CLI runtime 重启；强制 snapshot 会把用户已加载的
    // older rows 替换回 tail window。handoff 保留一致 projection 水位，由服务端按
    // logEpoch/seq 裁决 resume 或 snapshot；真实 runtime restart 仍保持 full subscribe。
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder：以窗口首行为游标向上拉一窗历史行并前插。
   * - 单飞：在途期间重复调用 no-op（loadingOlder 防重入）；
   * - 陈旧读防护：atLogEpoch ≠ 当前快照 epoch 的结果整体丢弃（跨 CLI 重启）；
   * - 合并以 rowId 为键：与订阅流的 row.upserted/removed 天然一致，
   *   在途期间到达的 delta 帧不受影响（它们只动 ≥ 窗口首行的行）。
   */
  // 不变量：单飞标记在途期间重复调用直接返回，避免同游标并发拉取。
  // 失败路径：结果 logEpoch 与当前快照不符整体丢弃，跨 CLI 重启的旧页不得复活。
  // 事务语义：写回前复核窗口首行游标，被移除或整体替换的窗口不作合并。
  // 设计权衡：合并只收窗口首行之前的行，与订阅流的 upsert 和 remove 天然不冲突。
  // 资源：finally 只在未关闭时复位标记，close 之后不再触碰状态。
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      // 在途期间游标失效（row.removed 截断 / snapshot resync 整体替换）→ 结果作废，
      // 防止把权威侧已移除的历史行复活；下次触发按新窗口重新拉。
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, this.shareRows(result.rows));
      if (window === null) return;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    } catch (error) {
      // query 只读且可重发：失败不进 error 态，留给下次触发重试。
      logger.warn(
        `[v4-store] rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * 完整问题目录：沿既有 rows/range 游标把当前有效分支一次补齐。
   *
   * 问题导航过去直接扫描 renderer 的 tail window，因此 1000 轮会话只显示
   * 已加载的几十轮。这里按协议上限分页读取，但等全部页成功后只换一次 snapshot，
   * 避免每 200 行重建一次 timeline render units 与两个 virtualizer。
   */
  // 不变量：终态缓存需 logEpoch 与 directoryRevision 同时匹配才可复用。
  // 并发：loadingOlder 在途时直接返回 stale，不与首页补拉抢同一游标。
  // 失败路径：任一页 epoch 或首行游标漂移即整批丢弃，不写入半截历史。
  // 失败路径：游标未推进视为对端异常，返回 retryable-failure 而不是原地循环。
  // 设计权衡：全部分页成功才换一次快照，避免每页重建时间线与虚拟列表。
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // 终态必须同时匹配 logEpoch 与 directoryRevision。logEpoch 表示日志代际，
    // 不表示内容静止——real-user query 增删会递增 revision 使终态失效，允许重新探测。
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] 完整问题目录开始补拉历史 rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn("[v4-store] 完整问题目录补拉期间投影游标失效，整批丢弃", {
            currentBeforeRowId: current?.rows.window[0]?.rowId,
            expectedBeforeRowId: initialBeforeRowId,
            resultLogEpoch: result.atLogEpoch,
            sessionId,
          });
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn("[v4-store] 完整问题目录 rows/range 未推进游标，停止补拉", {
            beforeRowId,
            hasMore: result.hasMore,
            sessionId,
          });
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const window = mergeOlderRows(current.rows.window, this.shareRows(olderRows));
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // navigator 已经拿到补齐首轮所需的权威 rows，必须在隐藏 rail 前先提交它们。
          logger.debug("[v4-store] 完整问题目录不足两条 query，保留首轮补齐 rows", {
            loadedRows: window.length,
            pages: pages.length,
            sessionId,
          });
        }
        // wire snapshot 只保留最后 60 rows，tail 中的 0/1 条 query 不能证明
        // 完整分支也是单 query。宽屏必须探测到分支起点；确认不足两条后不合并探测页，
        // 避免为一个不会显示的 rail 把完整历史常驻 renderer projection。
        logger.debug("[v4-store] 完整问题目录探测后不足两条 query", {
          pages: pages.length,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const window = mergeOlderRows(current.rows.window, this.shareRows(olderRows));
      if (window === null) return stale(initialLogEpoch);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      logger.debug("[v4-store] 完整问题目录历史 rows 补拉完成", {
        loadedRows: window.length,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] 完整问题目录 rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * 按本地失效 revision 合并并发的计划目录查询。
   * 旧计划可能早于 snapshot tail；同时 edit/retry 的 row.removed 会让在途
   * query 立刻过期，必须以 revision + epoch 双重校验，不能把旧分支计划重新写回 UI。
   */
  // 并发：在途查询把后续请求折叠成 pending，收尾后只补跑一次。
  // 失败路径：epoch 或 revision 变化即在途结果作废，旧分支计划不得写回。
  // 不变量：写回前同时校验 generation、logEpoch 与 planDirectoryRevision。
  // 资源：finally 复位在途标记，异常路径不会让计划目录永久 loading。
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** 命令上行前登记 overlay（pending/stopping 展示用）。 */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * ACK accepted/duplicate 后登记“必须能在权威投影中看见”的输入命令。
   *
   * command RPC 与 conversation topic 是两条独立通路；只有收到后续
   * delta 才能发现 gap，若 topic 在 ACK 后完全静默，CLI 继续工作但 UI 永远等不到 user row。
   * 这里不伪造消息，只在有限窗口后复用既有 same-sub recovery；权威 projection 一旦出现
   * queue/user row，watchdog 立即收口。
   */
  // 不变量：同一 commandId 只登记一个看门狗，重复调用直接返回。
  // 失败路径：窗口内仍无权威投影时只请求同订阅 recovery，不重发命令。
  // 事务语义：定时器触发后先摘除自身再判定，避免收口与超时双触发。
  // 资源：命令 settle 时必须清掉对应定时器，防止残留回调写已关闭 store。
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !requiresAcceptedInputProjection(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** 命令被拒/失败等本地收口时移除 overlay。 */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // 服务端投影出现同 commandId（pendingCommands / userInput.sourceCommandId 锚点）即代表权威侧已接管展示，overlay 条目退场。
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      requiresAcceptedInputProjection(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** 内存诊断：当前 rows.window 行数；只读。 */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** 退订并终结本 store（仅 SessionDataLayer 调用）。 */
  // 生命周期：close 先置关闭位再释放监听与定时器，迟到回调全部短路。
  // 资源：所有 accepted 看门狗、退避定时器与 recovery deadline 在此统一清退。
  // 事务语义：状态先落 closed 再退订，UI 不会在退订往返期间读到 live。
  // 失败路径：unsubscribe 失败只记日志不抛出，本地资源已释放即可接受。
  // 资源：从内存诊断集合移除后，行数统计不再包含已关闭实例。
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} 失败（忽略）: ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
