// INV-01 轮询必须单飞：同一时刻只允许一个 tick 在跑；守住位置：tick 入口的 disposed、schedulerReady、ticking 三条件与 finally 里的复位；改错故障：两轮并发认领同一 automation，同一时刻派发两次或写重 run 台账。
// INV-02 唤醒只能排队不能重入；守住位置：requestTick 在未就绪或 ticking 时只置 tickRequested；改错故障：定时器回调与消息回调各自起一轮，单飞闸门失效。
// INV-03 轮末必须补跑被排队的唤醒；守住位置：tick 尾部 while 条件 tickRequested 且未 disposed；改错故障：结算回调的唤醒被丢弃，手动触发要再等满 20 秒周期。
// INV-04 每轮固定「认领-派发-上报」顺序；守住位置：tick 内 claimDue、claimManualRuns、offPeak 认领、countActive 四步的书写次序；改错故障：先上报计数后认领，main 的 keep-awake 判断永远落后一轮。
// INV-05 轮内异常不得终止调度循环；守住位置：tick 内层 try/catch 只记录日志；改错故障：一条坏数据中断整轮，同轮后续 automation 与 off-peak 全部饿死。
// INV-06 misfire 判定必须同时要求非重试且超出宽限；守住位置：handleClaimed 的 missed 表达式；改错故障：休眠后积压任务被全部补跑，或正常到点被误判为错过窗口。
// INV-07 一次性任务错过即终态；守住位置：missed 分支的 isOneShotAutomation 与 finalize 时 nextRunAt 传 null；改错故障：只跑一次的提醒在后续周期反复触发。
// INV-08 重试任务永不进入 misfire 跳过；守住位置：isRetry 取自 dispatchAttempts 大于 0；改错故障：退避中的重试因超过宽限被当成错过窗口，任务静默丢失。
// INV-09 runId 在重试期间必须稳定；守住位置：resolveScheduledAt 优先取 nextRunAt 与 buildRunId 的拼接；改错故障：重试换了 runId，inFlight 与 run 台账错位，结算落到别的记录。
// INV-10 必须先落 run 台账再派发；守住位置：handleClaimed 里 upsertRunClaimed、inFlight 写入、postDispatchRequest 的先后；改错故障：main 回报早于台账，结算找不到 run 而丢状态。
// INV-11 modelSelection 不在 scheduler 侧提前冻结；守住位置：upsertRunClaimed 只写 trigger，派发时才读 run 上的固定值；改错故障：目标 Host 的首次选择被抢占，重试带着过期模型继续跑。
// INV-12 manual 与 schedule 必须分流结算；守住位置：settleDispatchResult 的 trigger 判定及手动认领结算；改错故障：手动 run 推进 next_run_at 或 max_runs，手动触发语义被破坏。
// INV-13 结算入口先取上下文再删 inFlight；守住位置：settleDispatchResult 开头两步的次序；改错故障：重复回报走到兜底分支，或退出时对已结算 run 重复释放认领。
// INV-14 上下文丢失时要能凭 runId 还原；守住位置：automationId 取冒号分段的首段、trigger 由 runId 是否含手动标记推断；改错故障：重启后的迟到回报定位不到 automation，结算写空或直接抛错。
// INV-15 失败要按 failureKind 分档重排；守住位置：settleDispatchResult 失败分支拼装 markDispatchFailed 参数处；改错故障：transient 达上限仍按原计划重试，形成无限重试或跳错周期。
// INV-16 退出路径必须释放所有在途认领；守住位置：dispose 遍历 inFlight 时按 trigger 分别走手动与计划释放；改错故障：下次启动要等认领过期才能回收，任务空转数分钟。
// INV-17 dispose 必须幂等且顺序正确；守住位置：dispose 开头的 disposed 早退，以及清定时器、停遥测、释放认领、关库的先后；改错故障：重复释放认领，或定时器残留导致退出后仍有写库。
// INV-18 闲时任务退避与在途集合各司其职；守住位置：handleOffPeakClaimed 的 retryAt 比较释放，以及 offPeakInFlight 的增删；改错故障：退避任务每轮被空认领空释放，或退出时漏掉在途任务长期停在 running。
//
// 模块职责：常驻 cron 调度进程，只读写 tasks-index，把到期的 automation、手动 run 与闲时任务翻译成派发请求发给 main，并按回报结算。
// 状态所有权：派发在途表 inFlight、闲时退避表、单飞标志与定时器句柄全部归本进程；automation 与 run 的事实状态归仓内 Repo，任务执行归 workspace host。
// 阅读顺序：先看常量与状态区，再沿 tick 的单飞循环读到 handleClaimed 的 misfire 分支，最后看 settleDispatchResult 的四条结算路径与 dispose 的清理次序。
// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责（tasks-index 属主方案）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - 轮询 automation_runs 里的 manual run，手动触发累计 run_count，但不推进 next_run_at / max_runs / lifecycle
//   - 维护派发状态机：misfire 跳过、single-flight 认领、成功结算、失败退避重试
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行 createTask+sendPrompt）
//   - 收到 main 回报后结算 automation + automation_runs
//   - 闲时任务（off_peak_tasks）：启动回收中断任务，认领 schedulable=1 的 queued 任务派发；
//     与 automation 表/消息/常量全部独立，⚠ 无 misfire-skip 语义（顺延不丢弃）
// 本进程只读写 tasks-index，不碰 UI / agent runtime；createTask 由 host 域执行。
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

// [资源] POLL_INTERVAL_MS 是唯一轮询节拍，定时器只在 bootstrap 成功后创建一次，避免多处 setInterval 叠加。
// MISFIRE_GRACE_MS 必须明显大于一轮正常轮询延迟，同时覆盖短暂卡顿；调小会把普通迟到误判为关机错过。
// 两个常量都不落库，改动只影响本进程，重启即按新值生效。
// [权衡] 采用固定 20 秒轮询而非按 next_run_at 精确睡眠：实现简单、不养大量定时器，代价是触发最多晚一个周期。
// misfire 宽限只作用于计划触发，手动 run 与闲时任务都不走这条判定。
// 常量变化会同时影响积压规模与 main 侧 keep-awake 的响应延迟，调整需成对评估。
// [失败路径] 定时器回调不会捕获异常，因此被调用的 requestTick 必须同步且不抛。
/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

// repo 与 offPeakRepo 分别持有 tasks-index 的两个域，本进程是 automation 派发状态的唯一写入者。
// [并发] inFlight 以 runId 为键，只在两条认领处理里写入，在结算与退出路径删除。
// inFlight 只是进程内缓存，丢失不致命：认领时的僵尸回收与 runId 还原共同兜底。
// offPeakRetryAt 与 offPeakRetryAttempts 是进程内退避表，重启即重置，退避时长不跨进程延续。
// offPeakInFlight 只服务退出时的认领释放，结算凭任务 id，不依赖该集合。
// [权衡] 退避状态留在内存而非写库：省掉每轮一次 `AutomationRepo` 写，代价是重启后归零。
// ticking、tickRequested、schedulerReady、disposed 共同构成单飞状态机，只允许 tick 与 requestTick 读写。
const repo = new AutomationRepo();
/** runId → 在途派发上下文；等 main 回报后结算。scheduler 重启丢失时靠 claimDue 的僵尸回收兜底。 */
const inFlight = new Map<string, InFlight>();

// ---- 闲时任务（off-peak）----
const offPeakRepo = new OffPeakTaskRepo();
/** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。scheduler 重启即重置，无害。 */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
const offPeakInFlight = new Set<string>();

let ticking = false;
let tickRequested = false;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 资源遥测：本进程唯一的自采定时器。 */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

// [并发] 入口三条件任一成立即返回，这是全部派发路径的唯一闸门。
// ticking 置位后由 finally 复位，轮内抛错也不会把进程卡在永久忙碌。
// 内层 try/catch 吞掉整轮异常只写日志，保证单次坏数据不终止调度循环。
// [事务] 每轮固定顺序：先认领 automation，再认领手动 run，最后认领闲时任务。
// 认领结果逐条 await 处理，单条失败会跳过同轮后续条目，剩余部分等下一轮重来。
// 执行中计数上报放在轮末，用差量驱动 main 的 keep-awake 决策。
// [并发] do-while 以 tickRequested 为条件补跑，覆盖结算期间到达的唤醒而不必等定时器。
// requestTick 在未就绪或正在轮询时只置标记，绝不并发进入 tick，单飞由此收口。
async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run);
        }
        const offPeakClaimed = await offPeakRepo.claimDue(now);
        for (const task of offPeakClaimed) {
          await handleOffPeakClaimed(task, now);
        }
        // keep-awake：上报执行中计数，main 据此 + 设置决定 powerSaveBlocker。
        await reportOffPeakActiveCount();
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
      // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  // scheduledAt 优先取计划时间，重试期间保持不变，runId 才能稳定复用到同一台账行。
  // [失败路径] missed 要求非重试且计划时间早于 now 减宽限，重试任务永远进不了跳过分支。
  // missed 分支走跳过重排，写入跳过原因与重算后的下次时间，不产生任何派发请求。
  // 一次性任务的 finalize 为真时下次时间传 null，把错过视为终态而非下一周期。
  // 非一次性任务从 now 重算下次时间，避免把休眠期间的积压一次性补跑。
  // [事务] 正常派发必须按「落台账 → 登记 `inFlight` → 发请求」三步走，次序不可换。
  // workspaceKey 统一由 resolveWorkspaceKey 算出，本地与远程的身份规则只此一处。
  const isRetry = automation.dispatchAttempts > 0;

  // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
  const missed =
    !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
  if (missed) {
    // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
    // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
    // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // 正常派发：先落/更新 run 台账（claimed），再把请求发回 main。
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    projectId: automation.projectId,
    hostId: automation.hostId,
    additionalDirectories: automation.additionalDirectories,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
): Promise<void> {
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey: resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    }),
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

/** 执行中计数上报（keep-awake）：仅在值变化时发消息，减噪。 */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- 闲时任务派发 ----

/**
 * 认领后派发闲时任务。退避中的任务立即释放认领等下轮（进程内退避表；每轮 claim+release
 * 两次写，任务数小、WAL 下开销可忽略——若退避任务成规模再把退避下沉进 claimDue）。
 */
async function handleOffPeakClaimed(task: ZCodeOffPeakTask, now: number): Promise<void> {
  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  if (!task.modelSelection) {
    // 仓库只认领 schedulable=1 的任务，而清空 Selection 时会同步写 schedulable=0，
    // 所以这里理论上不可达；保留守卫是为了不把"待修复"任务派发成无模型的 run。
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    log(
      "warn",
      `off-peak task claimed without model selection, released task=${task.offPeakTaskId}`,
    );
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    projectId: task.projectId,
    hostId: task.hostId,
    additionalDirectories: task.additionalDirectories,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

// 先读上下文再删在途记录，重复回报的第二次读不到上下文，只能走 runId 兜底路径。
// automationId 与 trigger 在上下文缺失时从 runId 推断，用于调度器重启后的迟到回报。
// [事务] 成功分支按 trigger 分流：手动只标 run 已派发并结算手动认领，不推进计划时间。
// 计划触发成功时先标 run 为已派发，再重算下次时间并写回 automation。
// [失败路径] 失败时统一先把 run 标成未派发成功，保证台账看得到失败而不是停在已认领。
// 手动失败只释放手动认领，不退避也不改 automation 的派发尝试计数。
// 计划失败把 failureKind 交给仓内结算，transient 与 permanent 的重排策略在仓库单点决定。
// 结算完成后由回调主动唤醒一轮，手动 run 因单飞暂时认领不到时也能尽快补跑。
async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // transient 达上限后循环任务跳下一个正常 next_run_at。
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

// [资源] 先置 disposed 再清定时器与遥测，之后任何唤醒请求都成为空操作。
// [事务] 遍历在途表按 trigger 分别走手动与计划释放，避免下次启动等到认领过期。
// 每条释放单独兜底，退出路径尽力而为，单条失败不阻断其余清理。
// 闲时 `inFlight` 逐条释放后清空，少量残留由启动时的中断恢复兜底。
// 两个仓各自关库兜底，最后以 0 码结束进程。
// [失败路径] 清理阶段不重试也不写日志：退出时消息通道可能已断，写日志本身可能失败。
async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  inFlight.clear();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  try {
    offPeakRepo.close();
  } catch {
    // 忽略。
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
        // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    requestTick();
  }
});

// 先等仓就绪再置 schedulerReady 并启动轮询，保证首轮认领时表结构已建好。
// 启动时把上个实例残留的执行中任务改回排队，会话信息保留供续跑。
// [失败路径] 恢复失败只记 error 不阻断启动，残留任务留给后续轮次自然处理。
// 定时器与资源遥测都在就绪之后创建，bootstrap 异常由末尾兜底记录并以非零码退出。
async function main(): Promise<void> {
  await repo.ensureReady();
  // 闲时任务中断恢复：scheduler 是 app 单例、先于任何派发启动——此刻 DB 里的
  // running 必属上一个 app 实例残留，安全置回 queued（session 保留供 resume 续跑）。
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
