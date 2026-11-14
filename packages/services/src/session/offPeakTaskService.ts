/* eslint-disable max-lines -- off-peak 任务编排服务集中维护 创建/取消/暂停/继续/删除、
   轮询同步（offPeakTaskSync）、终态核销 outbox 与 3102 续跑重取号，稳定后再按职责拆分。 */
/* off-peak 任务编排服务（host 域，仿 automationService 形态）。
   职责：
   - 创建即取号（POST /ticket 成功才落库，§4.1）；3103/3101 抛类型化错误给 UI
   - 取消/暂停/继续/删除/编辑 的状态守卫编排（D29-3/D30-7/D30-10）
   - offPeakTaskSync：有非终态任务才批量轮询 /ticket/status（轮询触发服务端晋级，D25/D26），
     写回 schedulable/位次/next_poll_at；expired 且非 paused → 同 task_id 自动重取号（D26/D27）
   - 终态核销 outbox：终态即 settle、失败随轮询周期捎带补报、启动扫描（D22/§7.7）
   - 3102 续跑：host 终态回写识别标记后调 handleTicketExpiredDuringRun → 回队重取号（§4.6） */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  isOffPeakTerminalStatus,
  resolveWorkspaceKey,
  type ProjectExecutionSnapshot,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { isOffPeakBoundSessionConflict, type OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import { OffPeakServerError, type OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@zcode/provider";
import { OffPeakResidentExecutions } from "./offPeakResidentExecutions.js";

/** 轮询下限/上限与失败退避（服务端 next_poll_after 优先，钳制防打爆/防饿死）。 */
export const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
// 上限 5 分钟，防止长时间不刷新导致位次与票状态陈旧。
export const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;
// 失败退避基数 10 秒，按 2^n 递增。
const SYNC_FAILURE_BASE_MS = 10_000;

export interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  prepareProjectExecution?: (projectId: string) => Promise<ProjectExecutionSnapshot>;
  client: OffPeakServerClient;
  /** 与 ticket/runtime 共用 resolver 后的脱敏结果，供 renderer 创建门控。 */
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  /** 只返回安全 hostname；解析失败返回空串，不能影响创建业务结果。 */
// 只返回安全 hostname，解析失败返回空串。
  resolveTelemetryProviderName: () => Promise<string>;
  /** 用当前完整 Registry 解析并校验固定 Off-Peak Provider 的选择。 */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  /** schedulable 翻 1 后立即唤醒 scheduler tick（缺省等 20s 轮询）。 */
// 不注入 requestSchedulerWake 时靠 syncTimer 轮询兜底，翻 1 到开跑会晚一个轮询间隔。
  requestSchedulerWake?: () => void;
  /** 取消 running 任务时中止其 agent loop（host 注入；best-effort）。 */
// cancelled 先落库再停 loop，residentExecutions.cancel 或 stopRunningTask 失败只记 warn。
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  /** 列表变化广播钩子（UI 刷新）。 */
// 列表变化广播，UI 据此刷新。
  onTasksChanged?: () => void;
  /** 测试注入时钟。 */
  now?: () => number;
  /** disposeAll 附加清理（如关闭 mock 网关）。 */
  onDispose?: () => void;
}

// 创建入口的权限模式白名单与 session 权限模型保持一致。
// 未知模式直接判客户端校验失败，不做静默降级。
const VALID_CREATE_PERMISSION_MODES = new Set([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

// 只做「能否进入取号」的形态校验，语义校验交给 Registry。
// projectId 与 workspacePath 至少一个非空，否则无法定位执行环境。
function isValidCreateParams(params: ZCodeOffPeakTaskCreateParams): boolean {
  return (
    typeof params.title === "string" &&
    params.title.trim().length > 0 &&
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    ((typeof params.projectId === "string" && params.projectId.trim().length > 0) ||
      (typeof params.workspacePath === "string" && params.workspacePath.trim().length > 0)) &&
    typeof params.permissionMode === "string" &&
    VALID_CREATE_PERMISSION_MODES.has(params.permissionMode)
  );
}

// 失败分类是跨 RPC 的唯一稳定契约：UI 只认 category 与 code。
// errorCategory 与 errorCode 是跨 RPC 的稳定契约，raw error 与响应体只写日志，不进返回值。
export function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
// 客户端校验失败不携带服务端码。
  if (failureStage === "client_validation") {
    errorCategory = "client_validation";
// 落库失败单独归类，便于 UI 提示「重试即可」。
  } else if (failureStage === "local_persist") {
    errorCategory = "local_persist";
// 只有服务端错误才可能带业务码。
  } else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
// 3101/3103 是用户可理解的两类拒绝，单独暴露。
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
// 响应结构不符归为 invalid_response，而不是网络错误。
  } else if (error instanceof ZodError) {
    errorCategory = "invalid_response";
  } else {
    // ticket client 内的 credential/RPC/fetch/abort 都可能以普通 Error 跨层抛出；
    // 它们仍属于 ticket_request，不能靠 raw message 猜测或泄漏服务端响应。
    errorCategory = "network";
  }
  return { failureStage, errorCategory, errorCode };
}

// 绑定会话冲突在所有入口共用同一份失败描述。
// 预检与 INSERT 冲突两条路径必须给出完全一致的分类。
const OFF_PEAK_SESSION_BOUND_FAILURE = {
  failureStage: "client_validation",
  errorCategory: "client_validation",
  errorCode: "session_bound",
} as const;

export class OffPeakTaskService implements IOffPeakTaskService {
  readonly residentExecutions: OffPeakResidentExecutions;
// 同一任务的并发重取号去重，复用同一个 Promise。
  private readonly retakes = new Map<string, Promise<void>>();
// 待释放票据集合，随时间盒轮询捎带重试。
  private readonly releasedTicketOutbox = new Set<string>();
// syncTimer 是单例，ensureSyncScheduled 重排前先 clearTimeout 旧定时器，不会有两个 tick 并存。
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
// 防止上一轮未结束时重入。
  private syncRunning = false;
// 默认停止，startSync 之前不会自动排期。
  private syncStopped = true;
// 连续失败次数用于指数退避。
  private consecutiveSyncFailures = 0;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {
// renew 走 handleTicketExpiredDuringRun，takeover 只清调度快照，release 进 outbox 重试。
// 续票走统一入口，接管只清调度快照，释放走 outbox。
    this.residentExecutions = new OffPeakResidentExecutions({
      renew: (taskId, current) => this.handleTicketExpiredDuringRun(taskId, current),
      takeover: async (taskId) => {
        await this.deps.repo.markRunning(taskId, { startedAt: this.now() });
        await this.deps.repo.updateSchedulingSnapshot(taskId, {
          schedulable: false,
          queuePosition: null,
          now: this.now(),
        });
        this.emitChanged();
      },
      release: (ticketId) => this.releaseExecutionTicket(ticketId),
    });
  }

  /** 释放票据不改变任务终态；失败捎带现有 sync 重试，不增加计时器或持久化凭据。 */
// 先入 outbox 再发送，失败保留到下一轮，避免丢票。
  private async releaseExecutionTicket(ticketId: string): Promise<void> {
    this.releasedTicketOutbox.add(ticketId);
    try {
      await this.deps.client.settle(ticketId);
      this.releasedTicketOutbox.delete(ticketId);
    } catch (error) {
// 4xx 视为服务端已无此票，重试没有意义。
      if (error instanceof OffPeakServerError && error.httpStatus < 500)
        this.releasedTicketOutbox.delete(ticketId);
      else
        this.deps.logger.warn(
          `off-peak execution ticket release failed ticket=${ticketId}:`,
          error,
        );
    }
  }

// 统一时钟入口，测试可注入固定时间。
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

// 广播失败不影响业务结果，只记日志。
  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onTasksChanged 回调失败:", error);
    }
  }

  // ---- 管理操作 ----

// getCodingPlanSupport 原样返回 resolveCodingPlanSupport()，支撑度判定不在本层做。
  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  /** Host 派发前的窄检查；最终执行仍由目标 Agent ModelFactory 重新校验。 */
// 只比对 providerId 与 modelId，reasoningLevel 允许 Registry 归一。
  async validateDispatchModelSelection(selection: ModelSelection): Promise<boolean> {
    const resolved = await this.deps.resolveModelSelection({
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { reasoningLevel: selection.options.reasoningLevel }
        : {}),
    });
    return (
      resolved.ok &&
// Provider 必须匹配固定 Off-Peak Provider，避免跨 provider 派发。
      resolved.selection.providerId === selection.providerId &&
      resolved.selection.modelId === selection.modelId
    );
  }

// 额度查询直接走 client，不缓存，保证门控实时。
// getTakeNumberAvailability 直接返回 client 结果，UI 据此决定创建按钮是否禁用。
  async getTakeNumberAvailability() {
    return this.deps.client.getTakeNumberAvailability();
  }

  /** 创建即取号（取号成功才落库）；失败只返回稳定分类，绝不跨 RPC 返回 raw error。 */
  async createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
// providerName 只用于埋点；解析失败保持空串。
// 它不得影响创建、toast 或执行结果。
    let providerName = "";
    try {
      providerName = await this.deps.resolveTelemetryProviderName();
    } catch {
      // provider_name 只是埋点维度；解析失败不得改变创建、toast 或任务执行。
    }
// 形态校验失败在取号前返回，零额度消耗。
    if (!isValidCreateParams(params)) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const selection = await this.deps.resolveModelSelection({
      modelId: params.modelSelection.modelId,
      ...(params.modelSelection.options?.reasoningLevel
        ? { reasoningLevel: params.modelSelection.options.reasoningLevel }
        : {}),
    });
// 选择无法解析同样属于客户端校验失败。
    if (!selection.ok) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
// projectId 路径需要先准备执行快照（仓库/分支等）。
// 已绑定会话的任务不允许再走项目准备。
    let execution: ProjectExecutionSnapshot | undefined;
    if (params.projectId) {
      try {
// 绑定会话与项目执行互斥，防止同一会话被两套 runtime 争用。
// 缺注入同样视为不可用，统一转客户端校验失败。
        if (params.boundSessionId || !this.deps.prepareProjectExecution)
          throw new Error("project.creation-unavailable");
        execution = await this.deps.prepareProjectExecution(params.projectId);
      } catch (error) {
        return {
          ok: false,
          ...classifyOffPeakCreateFailure(error, "client_validation"),
          providerName,
        };
      }
    }
// 规范化参数合并执行快照与校验后的 Selection。
    const normalizedParams: ZCodeOffPeakTaskCreateParams = {
      ...params,
      ...execution,
      modelSelection: selection.selection,
    };
    // 绑定会话已有未终态任务即拒，先于取号避免浪费额度；
    // 并发穿过预检的一方由 idx_off_peak_bound_active 在 INSERT 时拒绝（见下方 local_persist 分支）。
    if (
      params.boundSessionId &&
      (await this.deps.repo.hasActiveBoundTask(
        resolveWorkspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
        params.boundSessionId,
      ))
    ) {
      return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
    }
// 先定 task_id 再取号：票据与任务共用同一标识。
// 取号失败不会产生任何本地行。
    const offPeakTaskId = `offpeak-${randomUUID()}`;
// 取号是唯一消耗额度的动作，失败直接返回分类。
    let ticket;
    try {
      ticket = await this.deps.client.takeTicket(offPeakTaskId);
    } catch (error) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "ticket_request"),
        providerName,
      };
    }
// 落库成功才认为创建完成。
    let created: ZCodeOffPeakTask;
    try {
      created = await this.deps.repo.create(normalizedParams, {
        offPeakTaskId,
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
        // 取号即 ready（低峰空闲直接晋级）时随建随派
// 位次只在服务端返回时写入，避免伪造 0。
        schedulable: ticket.state === "ready",
      });
// ticket.nextPollAfterMs 存在就写 nextPollAt，首轮同步不必等默认间隔。
      if (ticket.nextPollAfterMs !== undefined) {
        await this.deps.repo.updateSchedulingSnapshot(created.offPeakTaskId, {
          nextPollAt: this.now() + ticket.nextPollAfterMs,
        });
      }
    } catch (error) {
// 并发预检穿透：唯一索引拒绝后按同一份冲突描述返回。
      if (isOffPeakBoundSessionConflict(error)) {
        // 已取的票随任务作废，服务端按过期回收；不为此加释放接口。
        return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
      }
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "local_persist"),
        providerName,
      };
    }
    this.deps.logger.info(
// 创建成功先写日志再广播，便于按 id 检索。
      `off-peak task created id=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    this.emitChanged();
    this.ensureSyncScheduled(0);
// 取号即 ready 时唤醒调度器，实现随建随派。
    if (ticket.state === "ready") {
      try {
        this.deps.requestSchedulerWake?.();
      } catch (error) {
        this.deps.logger.warn("off-peak scheduler wake failed after create:", error);
      }
    }
    return {
      ok: true,
      task: created,
      ticketInitialState: ticket.state,
      ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
      providerName,
    };
  }

  /**
   * 取消（任意非终态）：先落终态再停 loop——顺序保证 loop 的 stopped 迟到回写
   * 被终态守卫丢弃，不会覆盖 cancelled（幂等）。
   */
// 终态先落库：后续 loop 的迟到回写会被状态守卫丢弃。
// 取消对终态任务幂等，直接返回当前快照。
  async cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
// 未知任务返回 null，终态任务返回原值。
    if (!existing || isOffPeakTerminalStatus(existing.status)) return existing;
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
    });
    if (!cancelled) return this.deps.repo.get(offPeakTaskId);
// 有驻留执行时走生命周期取消，能同时停 loop 与票据。
// 否则退化为按会话停止，兼容未注册执行的旧任务。
    if (this.residentExecutions.has(offPeakTaskId)) {
      try {
        await this.residentExecutions.cancel(offPeakTaskId);
      } catch (error) {
        this.deps.logger.warn(`off-peak lifecycle cancel failed task=${offPeakTaskId}:`, error);
      }
    } else if (
      existing.status === "running" &&
      existing.conversationId &&
      this.deps.stopRunningTask
    ) {
      try {
        await this.deps.stopRunningTask({
          conversationId: existing.conversationId,
          workspacePath: existing.workspacePath,
          ...(existing.workspaceIdentity ? { workspaceIdentity: existing.workspaceIdentity } : {}),
        });
      } catch (error) {
        this.deps.logger.warn(`off-peak cancel stop loop failed task=${offPeakTaskId}:`, error);
      }
    }
    this.emitChanged();
// 核销是 best-effort，不阻塞取消返回。
    void this.settleOne(cancelled);
    return cancelled;
  }

  /** Pause：停止本地派发，票留服务端队列继续排。 */
// pauseTask 只把 paused 置真，服务端票继续排队，而 setPaused 不调用 client。
// paused 不参与 claimDue，恢复后需重新确认票。
  async pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const paused = await this.deps.repo.setPaused(offPeakTaskId, true, {
      now: this.now(),
    });
    if (paused) this.emitChanged();
    return paused;
  }

  /**
   * Continue：票活着 = 恢复派发（零成本）；票已废（expired/not_found/无票）= 此刻手动
   * 重取号回队尾（额度消耗必须由用户显式动作触发）。
   */
// continueTask 先 batchStatus 确认 serverTicketId 仍有效，再决定恢复派发还是重取号。
// 票已废时必须由用户动作触发重取号，避免隐式消耗额度。
  async continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const resumed = await this.deps.repo.setPaused(offPeakTaskId, false, {
      now: this.now(),
    });
    if (!resumed) return null;
// serverTicketId 为空时 ticketAlive 保持 false，直接进重取号分支。
    let ticketAlive = false;
    if (resumed.serverTicketId) {
      try {
        const status = await this.deps.client.batchStatus([resumed.serverTicketId]);
        // 必须按 ticketId 匹配，不能取 tickets[0]——批量应答顺序/内容不保证与请求一致。
// 按 ticketId 匹配，批量应答顺序不作保证。
        const entry = status.tickets.find((t) => t.ticketId === resumed.serverTicketId);
        ticketAlive =
// expired/not_found 都视为废票。
          entry !== undefined && entry.state !== "expired" && entry.state !== "not_found";
        if (entry && ticketAlive) {
          await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
            schedulable: entry.state === "ready",
            queuePosition: entry.position ?? null,
            now: this.now(),
          });
        }
      } catch (error) {
        // 状态查询失败按票活处理，交给轮询兜底；不在 Continue 上白耗一次取号额度。
        this.deps.logger.warn(
          `off-peak continue status check failed task=${offPeakTaskId}:`,
          error,
        );
// 查询失败按票活处理，交给轮询兜底，不在 Continue 上白耗额度。
        ticketAlive = true;
      }
    }
// 唯一会重取号的入口之一，且由用户显式动作触发。
    if (!ticketAlive) {
      await this.retakeTicket(offPeakTaskId);
    }
    this.emitChanged();
    this.ensureSyncScheduled(0);
    return this.deps.repo.get(offPeakTaskId);
  }

  /** 删除：非终态先按取消处理（停 loop + settle），再删行；终态直接删。 */
// 非终态先取消再删行，保证 loop 与票据都被收口。
// 终态任务直接物理删除。
  async deleteTask(offPeakTaskId: string): Promise<void> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return;
    if (!isOffPeakTerminalStatus(existing.status)) {
      await this.cancelTask(offPeakTaskId);
    }
// 此时 loop 已停、票据已核销，删行不会留下悬挂执行。
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  /** Delete history：仅写本地可见性标记，任务与会话继续保留。 */
// 只隐藏列表展示，任务与会话保留。
// 隐藏后仍可被直接 get 读取。
  async deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  /** 编辑（queued/paused 全字段可编辑；票只锁队列身份，prompt 派发时才读）。 */
// 编辑只在 queued/paused 生效，running 起锁定。
  async updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return null;
// running 起锁定编辑，终态只读。
    if (existing.status !== "queued" && existing.status !== "paused") {
      // running 起锁定编辑（仅取消），终态只读。
      return null;
    }
    // 闲时任务必须保存一个可由当前 Registry 解析的明确模型；清空模型不能退化成
    // “稍后取第一个”，否则编辑时看到的选择和真正派发的模型会发生漂移。
// 不允许清空模型，否则编辑看到的选择与真正派发的模型会漂移。
    if (params.modelSelection === null) return null;
// 未传选择时沿用原值。
    const candidate = params.modelSelection ?? existing.modelSelection;
    if (!candidate) return null;
    const selection = await this.deps.resolveModelSelection({
      modelId: candidate.modelId,
      ...(candidate.options?.reasoningLevel
        ? { reasoningLevel: candidate.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) return null;
// 落库前替换为 Registry 归一后的 Selection。
    const normalizedParams: OffPeakUpdateTaskParams = {
      ...params,
      modelSelection: selection.selection,
    };
    const updated = await this.deps.repo.updateEditableFields(offPeakTaskId, normalizedParams, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

// list 读库后过 projectModelSelectionIssues 派生诊断，诊断只存在返回值里，不写库。
  async list(): Promise<ZCodeOffPeakTask[]> {
    return this.projectModelSelectionIssues(await this.deps.repo.list());
  }

// 单条读取走同一诊断投影，保证与列表一致。
  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    if (!task) return null;
    return (await this.projectModelSelectionIssues([task]))[0] ?? null;
  }

  /**
   * 只派生当前配置诊断，不写数据库；旧字段仅由 migration 处理。
   */
  private async projectModelSelectionIssues(
    tasks: readonly ZCodeOffPeakTask[],
  ): Promise<ZCodeOffPeakTask[]> {
// 逐条派生可用性，不修改入参对象。
// 终态任务不再检查模型，避免无意义的重解析。
    const repaired: ZCodeOffPeakTask[] = [];
    for (const task of tasks) {
      if (task.modelSelection) {
        // 读取时把当前账号不可用写成 NULL，会永久丢掉原选择并诱发旧字段重绑。
        // 新结构只派生诊断，不写任务或 Ticket；终态不再使用模型，无需重新检查。
// 只有 queued/paused/running 需要确认模型仍可解析。
        const usable =
          isOffPeakTerminalStatus(task.status) ||
          (await this.validateDispatchModelSelection(task.modelSelection));
        repaired.push(
          usable
            ? task
            : {
                ...task,
                schedulable: false,
                modelSelectionIssue: {
                  code: "repair-required",
                  legacyModelId: task.modelSelection.modelId,
                  legacyReasoningLevel: task.modelSelection.options?.reasoningLevel,
                },
              },
        );
        continue;
      }
      // 数据库迁移无法确定旧 Provider 时保持缺失；读取不补迁、不重绑 Ticket。
// 缺 Selection 的历史行禁止派发，等待迁移或人工修复。
      repaired.push({ ...task, schedulable: false });
    }
    return repaired;
  }

  // ---- 3102 续跑（host 终态回写识别标记后调用）----

  /** 票据过期（active 3h 到期/ready 废票）：回队保 session → 同 task_id 重取号。 */
// 3102 续跑入口：先回队，再同 task_id 重取号。
// retakeGuard 在回队与重取号前后各查一次，用户接管后 current() 为假就放弃续跑。
  async handleTicketExpiredDuringRun(
    offPeakTaskId: string,
    current = this.residentExecutions.retakeGuard(offPeakTaskId),
  ): Promise<void> {
    if (!current()) return;
// 回队成功后立即重取号，保证同一 task_id 继续排队。
    const requeued = await this.deps.repo.requeueForContinuation(offPeakTaskId, {
      now: this.now(),
    });
    if (!current()) {
      if (this.residentExecutions.isUserOwned(offPeakTaskId))
        await this.deps.repo.markRunning(offPeakTaskId, { startedAt: this.now() });
      return;
    }
// 非 running 的迟到通知直接丢弃。
    if (!requeued) {
      this.deps.logger.info(
        `off-peak ticket-expired requeue dropped (not running) task=${offPeakTaskId}`,
      );
      return;
    }
    await this.retakeTicket(offPeakTaskId);
    this.emitChanged();
    this.ensureSyncScheduled(0);
  }

  /** 同 task_id 重新取号（已确认允许多次），失败留给轮询周期重试。 */
// 并发去重：同任务同一时刻只允许一次取号请求。
// 守卫在执行前再确认一次，避免为已终态任务消耗额度。
  private async retakeTicket(offPeakTaskId: string): Promise<void> {
    const existing = this.retakes.get(offPeakTaskId);
    if (existing) return existing;
    const current = this.residentExecutions.retakeGuard(offPeakTaskId);
    if (!current()) return;
// finally 清理去重表，失败也允许下轮重试。
    const pending = this.runRetakeTicket(offPeakTaskId, current).finally(() => {
      this.retakes.delete(offPeakTaskId);
    });
    this.retakes.set(offPeakTaskId, pending);
    return pending;
  }

// 取号后必须复核任务仍存在且未终态，否则立即释放票据。
  private async runRetakeTicket(offPeakTaskId: string, current: () => boolean): Promise<void> {
    try {
      const ticket = await this.deps.client.takeTicket(offPeakTaskId);
// 取号后重读任务，确认未被并发删除或终态化。
      const task = await this.deps.repo.get(offPeakTaskId);
// 三种失效情形共用一条释放路径。
      if (!current() || !task || isOffPeakTerminalStatus(task.status)) {
        await this.releaseExecutionTicket(ticket.ticketId);
        return;
      }
      await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        schedulable: ticket.state === "ready",
// 与创建路径同一判定：ready 才可立即派发。
// 位次随新票一起写回，缺省写 null。
        queuePosition: ticket.position ?? null,
        ...(ticket.nextPollAfterMs !== undefined
          ? { nextPollAt: this.now() + ticket.nextPollAfterMs }
          : {}),
        now: this.now(),
      });
      if (!current()) {
        await this.releaseExecutionTicket(ticket.ticketId);
// 写回期间被接管：新票必须释放，不能留给下一位用户。
        if (this.residentExecutions.isUserOwned(offPeakTaskId)) {
          await this.deps.repo.markRunning(offPeakTaskId, { startedAt: this.now() });
          await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
// 用户接管后把任务恢复为 running，并回退到旧票据快照。
            serverTicketId: task.serverTicketId,
            schedulable: false,
            now: this.now(),
          });
        }
        return;
      }
      if (ticket.state === "ready") this.deps.requestSchedulerWake?.();
      this.deps.logger.info(
        `off-peak re-take ticket task=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
      );
    } catch (error) {
      // 取号失败（额度/网络）不终态化——任务留在 queued，下个轮询周期发现无有效票再补取。
// 失败只告警，任务保持 queued 等下个周期。
      this.deps.logger.warn(`off-peak re-take ticket failed task=${offPeakTaskId}:`, error);
    }
  }

  // ---- offPeakTaskSync：批量轮询 + 晋级写回 + 核销 outbox ----

// 幂等启动：重复调用不重置已有定时器。
  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // 启动即扫一次未核销终态（host 启动扫描）。
    this.ensureSyncScheduled(0);
  }

// 停止后不再自动排期，显式 runSyncCycle 仍可用。
  stopSync(): void {
    this.syncStopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** disposeServiceResources 钩子：host 退出统一回收（停轮询 + 附加清理）。 */
// disposeAll 顺序固定：先 residentExecutions.dispose，再 stopSync，最后 onDispose。
  disposeAll(): void {
    this.residentExecutions.dispose();
    this.stopSync();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onDispose 清理失败:", error);
    }
  }

// 重排前清旧定时器，保证全进程只有一个待触发任务。
  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    // Node 定时器不阻止进程退出（host 生命周期由外部管理）。
// unref 让定时器不阻止进程退出。
    this.syncTimer.unref?.();
  }

  /** 单次同步周期；显式调用（测试/启动扫描）不受 stopSync 影响，仅自动重排循环受控。 */
// 单轮：补报核销 → 重试交接 → 轮询状态 → 计算下次间隔。
// 任何异常都只影响间隔，不影响进程存活。
  async runSyncCycle(): Promise<void> {
// 重入保护：上一轮未结束直接放弃本轮。
    if (this.syncRunning) return;
    this.syncRunning = true;
    let nextDelay = OFF_PEAK_SYNC_MAX_INTERVAL_MS;
    try {
      // 1) 核销 outbox 捎带补报（不新增计时器）。
// 先补报终态核销，避免 outbox 无限增长。
      await this.flushSettleOutbox();
// 票据释放集合同样随时间盒重试。
      for (const ticketId of this.releasedTicketOutbox) await this.releaseExecutionTicket(ticketId);
      try {
// 未确认的换票命令重试，失败不影响其它任务。
        await this.residentExecutions.retryPendingTickets();
      } catch (error) {
        // 交接确认失败保留原票，下个同步周期继续；不能阻断其他任务轮询与票据释放。
        this.deps.logger.warn("off-peak ticket confirmation pending:", error);
      }
      // 2) 有非终态任务才轮询。
// 只轮询非终态任务，终态无需再晋级。
      const nonTerminal = await this.projectModelSelectionIssues(
        await this.deps.repo.listNonTerminal(),
      );
// isUserOwned 为真的任务被 withTickets 过滤掉，不再随 batchStatus 更新票状态。
      const withTickets = nonTerminal.filter(
        (task) => task.serverTicketId && !this.residentExecutions.isUserOwned(task.offPeakTaskId),
      );
      // 无票的 queued 任务（重取号失败残留）：补取号。
// 无票的 queued 行是重取号失败残留，本轮补取。
      for (const task of nonTerminal) {
        if (!task.serverTicketId && task.status === "queued") {
          await this.retakeTicket(task.offPeakTaskId);
        }
      }
// withTickets 与 nonTerminal 都为空时清零 consecutiveSyncFailures 并 return，不再自动排期。
      if (withTickets.length === 0 && nonTerminal.length === 0) {
        // 无任务：不再自动重排，等下一次 create/continue 触发。
        this.consecutiveSyncFailures = 0;
        return;
      }
// batchStatus 一次带上 withTickets 里所有 serverTicketId，本轮只发一个请求。
      if (withTickets.length > 0) {
        const status = await this.deps.client.batchStatus(
          withTickets.map((task) => task.serverTicketId!),
        );
// 只有状态翻为可派发才需要唤醒调度器。
        let anyBecameSchedulable = false;
        for (const task of withTickets) {
// status.tickets 里找不到对应 ticketId 就 continue，缺项按无变化处理。
          const entry = status.tickets.find((t) => t.ticketId === task.serverTicketId);
          if (!entry) continue;
          anyBecameSchedulable =
            (await this.applyTicketStatus(task, entry.state, entry.position)) ||
            anyBecameSchedulable;
        }
        if (anyBecameSchedulable) this.deps.requestSchedulerWake?.();
// 服务端间隔优先，缺省用下限避免空转。
        if (status.nextPollAfterMs !== undefined) {
          nextDelay = status.nextPollAfterMs;
        } else {
          nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
        }
        this.emitChanged();
      } else {
        nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
      }
      this.consecutiveSyncFailures = 0;
    } catch (error) {
      // 轮询失败退避重试：期间不派发、在跑不受影响。
// 指数退避，上限固定为最大间隔。
      this.consecutiveSyncFailures += 1;
// 2^n 退避从 10s 起，避免持续打爆服务端。
      nextDelay = Math.min(
        SYNC_FAILURE_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.deps.logger.warn(
        `off-peak sync cycle failed (attempt ${this.consecutiveSyncFailures}):`,
        error,
      );
    } finally {
// finally 统一复位并排下一轮，异常也不会漏排。
      this.syncRunning = false;
// 下一次间隔钳制在 [min, max] 之间。
      const clamped = Math.min(
        Math.max(nextDelay, OFF_PEAK_SYNC_MIN_INTERVAL_MS),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.ensureSyncScheduled(clamped);
    }
  }

  /** 单票状态映射（两轴）：返回是否翻为可派发。 */
// applyTicketStatus 只写调度字段，任务终态由 host 回写，映射里不改。
// 返回的布尔只表示本轮 schedulable 是否翻为真，不代表任务成功或失败。
  private async applyTicketStatus(
    task: ZCodeOffPeakTask,
    state: string,
    position: number | undefined,
  ): Promise<boolean> {
    const now = this.now();
// ready / queued / active / expired 四种状态各自写回不同字段。
    switch (state) {
      case "ready": {
// 只有 queued 且此前不可派发才算新晋级。
        const became = task.schedulable !== true && task.status === "queued";
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: true,
          queuePosition: position ?? null,
          nextPollAt: now + OFF_PEAK_SYNC_MIN_INTERVAL_MS,
          now,
        });
        return became;
      }
// 排队中：撤销可派发标记，只更新位次。
      case "queued":
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: false,
          queuePosition: position ?? null,
          now,
        });
        return false;
// 客户端 loop 在跑，服务端状态不驱动本地状态机。
      case "active":
        // 客户端 loop 在跑（或派发在途）；快照不动状态机，仅清位次展示。
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          queuePosition: null,
          now,
        });
        return false;
// 排队中的过期票同 task_id 重取；paused 留待用户 Continue。
      case "expired": {
        // 任何 expired → 同 task_id 重新取号续排（统一口径）；
        // 例外：paused 停在原地等手动 Continue；running 的 3h 到期
        // 由 messages 400/3102 路径触发，这里只处理排队中的废票。
// running 的 3h 到期由 3102 路径处理，这里不重复。
        if (task.status === "queued") {
          await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
            schedulable: false,
            queuePosition: null,
            now,
          });
          await this.retakeTicket(task.offPeakTaskId);
        }
        return false;
      }
// settled 与 not_found 都返回 false，本地不再写调度字段，等服务端回收。
      case "settled":
      case "not_found":
      default:
        return false;
    }
  }

  /** 终态未核销任务补报（幂等，永远失败也无害——服务端静默超时回收兜底）。 */
// 逐条补报，单条失败不影响后续。
  private async flushSettleOutbox(): Promise<void> {
    const unsettled = await this.deps.repo.listUnsettledTerminal();
    for (const task of unsettled) {
      await this.settleOne(task);
    }
  }

// 核销幂等：4xx 视为已释放，5xx/网络留到下轮。
  private async settleOne(task: ZCodeOffPeakTask): Promise<void> {
    if (!task.serverTicketId) {
      // 无票（mock 先行/取号从未成功）：无可核销对象，直接标记防止 outbox 永久滞留。
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
      return;
    }
    try {
      await this.deps.client.settle(task.serverTicketId);
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
    } catch (error) {
// 4xx 表示服务端已无此票，按核销成功处理。
      if (error instanceof OffPeakServerError && error.httpStatus < 500) {
        // 4xx（未知票等）按幂等 ack 处理：服务端已无此票可释放。
        await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
        return;
      }
      // 网络/5xx：保持未核销，下个周期捎带补报（不新增计时器）。
      this.deps.logger.warn(`off-peak settle failed ticket=${task.serverTicketId}:`, error);
    }
  }
}
