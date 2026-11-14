// ProductProjection 状态工厂与派生规则。
// 本文件只放纯函数：初始快照、availability/inputRouting 派生、revision 递进判定。
//
// 这些派生规则必须与 formal-proof 的裁决表、以及客户端 apply 语义逐条对齐：
// availability/inputRouting 是 UI 唯一可用性来源，禁止 renderer 按 phase 自行重算；
// revision 是命令 CAS 的水位，只有「行结构变化 + A 区变化」才记账，避免无状态变化的抖动。
// 所有函数都不读写外部状态，便于在 fixture、hydration 与 golden replay 中复用。
import type {
  ActionAvailability,
  ConversationDelta,
  ConversationSnapshot,
  GoalState,
  InputRouting,
  SessionActionAvailability,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 冷恢复合成事件的 traceId 哨兵。
 * 合成事件是「视图重建」而非权威用户动作：ModelSelected 等 config 类合成事件
 * 更新投影 config，但不得声明 种子权威（configModelTouchedByEvent）——
 * 否则历史最后一轮的模型会压掉 resume 回写的 runtime 真值（含草稿态选型）。
 */
export const HYDRATION_TRACE_ID = "hydrate-trace";

/**
 * 构造会话产品投影的初始快照（draft、无 row、usage 全零）。
 *
 * 输入：sessionId/logEpoch 决定日志代际；输出：A 区字段齐备的冻结合同形状。
 * 初值刻意是「draft + 无可见 delta」：SessionCreated 不产行，首个真实 TurnStarted
 * 才把 phase 推进到 running。availability/inputRouting 由同一份 context 派生，
 * 保证初始态与后续 state.updated 的口径一致。config.mode 以 core 默认 build 起步，
 * 持久化偏好由 seedConfig 在事件触碰前补入。纯函数，不 commit、不广播。
 */
export function createInitialConversationSnapshot(
  sessionId: string,
  logEpoch: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch,
    seq: 0,
    revision: 0,
    control: {
      // draft 裁决：会话实体已存在但尚无输入。
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: computeAvailability({
      phase: "draft",
      goalStatus: null,
      compacting: false,
      goalVerifying: false,
      queueLength: 0,
      autoDrain: true,
    }),
    inputRouting: computeInputRouting(
      {
        phase: "draft",
        goalStatus: null,
        compacting: false,
        goalVerifying: false,
        queueLength: 0,
        autoDrain: true,
      },
      "queue",
    ),
    meta: { title: "", titleSource: "default" },
    // mode 初值 = core 默认协作模式（session-mode-port getMode 的 "build" 回落）。
    // SessionCreated 事件虽带 mode，但 draft 语义要求无可见 delta（不 bump revision）；
    // 持久化偏好非 build 时以首条 SessionModeChanged 为准（TODO：draft 期免 revision 种子通道）。
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    // 软门禁：初始无待审核状态;activate() 上报后由投影写入。
    workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const ALLOWED: ActionAvailability = { allowed: true };

function denied(reasonCode: string): ActionAvailability {
  return { allowed: false, reasonCode };
}

/**
 * availability / inputRouting 的派生上下文。
 *
 * compacting / goalVerifying 不是独立 phase（10 §4.2.1 的 phase 是封闭枚举），
 * 必须从 activeWorks 与 goal.status 派生后传入；queueLength + autoDrain 决定
 * held 队列是否需要用户选择。字段口径与 controlPatch 的实时重算保持一致，
 * 任何新增派生维度都要先在这里显式建模，避免 UI 与 reducer 各自猜测。
 */
// guard 派生的输入面（与投影同源，P5-3）。compacting/goalVerifying 不是独立 phase
// （10 §4.2.1 phase 封闭枚举），从 activeWorks / goal.status 派生后传入。
// queueLength/autoDrain 用于 held 派生（heldQueueInputRequiresChoice，2026-07-05 裁决）。
export interface AvailabilityContext {
  phase: SessionControl["phase"];
  goalStatus: GoalState["status"] | null;
  compacting: boolean;
  goalVerifying: boolean;
  queueLength: number;
  autoDrain: boolean;
}

/**
 * 由上下文派生整份 SessionActionAvailability（fork/compact/模型与模式切换/
 * queue 操作/goal 操作）。裁决表与 formal-proof 的 evaluate 逐条对齐，reasonCode
 * 即 product-protocol guard id，UI 不得自行按 phase 推断按钮可用性。
 * 关键边界：compacting 一律锁 compact/fork/sendQueuedNow；draft 无稳定 fork 目标且
 * 无上下文可压；goal 的 pause/resume 按底层 target 状态而非是否存在 abort controller。
 * 纯函数；返回全新的整份对象，调用方以 state.updated 整键替换。
 */
// 裁决表与 packages/formal-proof/src/model.ts 的 evaluate 逐条对齐
// （黄金测试 formal-proof-consistency 背书）；reasonCode = product-protocol guard id。
export function computeAvailability(context: AvailabilityContext): SessionActionAvailability {
  const { phase, goalStatus, compacting } = context;
  const running = phase === "running" || phase === "prewarming";
  const compact = compacting
    ? // formal-proof: duplicateCompactRejected —— running/queued compact 操作锁去重。
      denied("compactOperationLock")
    : phase === "draft"
      ? // formal-proof: idleCannotCompact —— 没有可压缩上下文。
        denied("idleCannotCompact")
      : // running/goal verifier 时命令进入 typed FIFO，completed 时立即执行或进入 held queue。
        ALLOWED;
  return {
    fork: compacting
      ? denied("compactOperationLock")
      : phase === "draft"
        ? denied("forkTargetNotStable")
        : ALLOWED,
    compact,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: compacting
      ? denied("compactOperationLock")
      : running
        ? ALLOWED
        : denied("sendQueuedNowRequiresRunning"),
    // 独立 pauseGoal 改变 target 产品态；verifier/notSatisfied 期间底层 target 仍是 active，
    // 因此也允许暂停，不能要求当前一定存在 provider abort controller。
    pauseGoal:
      goalStatus === "active" || goalStatus === "verifying" || goalStatus === "notSatisfied"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToPause" : "goalNotActive"),
    // resumeGoal = stopPausesActiveGoalTarget 的逆操作：仅 paused 可恢复。
    resumeGoal:
      goalStatus === "paused"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToResume" : "goalNotPaused"),
  };
}

/**
 * 派生用户输入的下一跳路由：startNow | enqueue | guide | reject | choice。
 *
 * 优先级（顺序即语义）：compacting 与 goal verifier 都只是维护/阻塞工作，输入是
 * 未来意图 → enqueue，不能打断；running/prewarming 时按 followupMode 选 guide 或
 * enqueue（core 在 goal verifier 期间没有 steerable activeTurn，必须提前分流）；
 * completed 且 queue>0 且 autoDrain=false 时返回 choice，让客户端显式 clear/keep，
 * 而不是静默入队。reject 由命令层使用，本函数不产出。
 * 纯函数；结果与 availability 同源，调用方以 state.updated 整键替换。
 */
export function computeInputRouting(
  context: AvailabilityContext,
  followupMode: "queue" | "guide",
): InputRouting {
  // formal-proof: compactingAcceptsFutureInput
  // —— compact 是维护步骤，输入是未来意图 → 入队，不打断 compact。
  if (context.compacting) {
    return { mode: "enqueue", reasonCode: "compactingAcceptsFutureInput" };
  }
  // goal verifier 是 completion-blocking active work，但不是普通
  // assistant active turn；只看 phase=running 会在 guide 模式下尝试 steer，
  // core 此时没有 steerable activeTurn，导致用户输入既不进 queue 也不进历史。
  if (context.goalVerifying) {
    return { mode: "enqueue", reasonCode: "goalVerifierAcceptsFutureInput" };
  }
  if (context.phase === "running" || context.phase === "prewarming") {
    return { mode: followupMode === "guide" ? "guide" : "enqueue" };
  }
  // completed + queue>0 + autoDrain=false 时，输入不静默入队；
  // 客户端呈现 clear/keep 选择，disposition 随 command 上行。
  const completed =
    context.phase === "completedSuccess" || context.phase === "completedInterrupted";
  if (completed && context.queueLength > 0 && !context.autoDrain) {
    return { mode: "choice", reasonCode: "heldQueueInputRequiresChoice" };
  }
  return { mode: "startNow" };
}

// revision 递进规则（封闭定义）：行结构变化 + A 区（usage/pendingCommands 除外）变化各 +1。
// `workflowRuns` **刻意不在列**，归入 usage/pendingCommands 的豁免类：它是高频派生数据
// （每个节点约 5 次迁移）、自带单调 revision 字段、且没有任何 command 的
// baseRevision CAS 读它——列入会让 run 在飞期间的每次节点迁移都抖动 conversation revision，
// 徒增 CAS 假失败。
const REVISION_BEARING_PATCH_KEYS: ReadonlyArray<keyof StatePatch> = [
  "control",
  "availability",
  "inputRouting",
  "meta",
  "config",
  "queue",
  "pendingInteractions",
  "backgroundWorks",
  "subagents",
  "goal",
  "plan",
];

/**
 * 判定一条 delta 是否推进 conversation revision（命令 CAS 水位）。
 *
 * 封闭规则：row.appended / row.upserted / row.removed 必 +1；row.delta（纯追加）
 * 不 +1；state.updated 仅当 patch 命中 REVISION_BEARING_PATCH_KEYS。
 * usage、pendingCommands、workflowRuns 以及 live-only 的 pluginUi/workflowRun
 * 键级增量刻意豁免：它们是高频派生数据且无人用 baseRevision 读，列入只会造成
 * CAS 假失败。row.removed 的截断语义由客户端按 fromRowId 执行，不在本函数补算法。
 */
export function deltaBumpsRevision(delta: ConversationDelta): boolean {
  switch (delta.op) {
    case "row.appended":
    case "row.upserted":
    case "row.removed":
      return true;
    case "row.delta":
      return false;
    case "state.updated":
      return REVISION_BEARING_PATCH_KEYS.some((key) => delta.patch[key] !== undefined);
    case "pluginUi.resourceUpdated":
    case "pluginUi.resourceListChanged":
    case "pluginUi.instanceClosed":
    case "pluginUi.appToolCall":
    // live-only 通知不改快照，不记账。
    // 键级增量与整键 `workflowRuns` patch 同一条豁免（见上面的注释）：它们表达的就是那个键的变化，
    // 换个编码不该换记账规则——列入会让一条在飞的 run 每次节点迁移都抖动 conversation revision。
    case "workflowRun.updated":
    case "workflowRun.removed":
      return false;
  }
}
