// automation 管理面：在 repo 之上承担 cron 校验、归一化与生命周期重算。
// 所有写入口都先做领域校验，再落库。
import { assertValidAutomationScheduleRule } from "#src/session/automationCronValidation.js";
export { InvalidAutomationScheduleRuleError } from "#src/session/automationCronValidation.js";
import type {
  ProjectExecutionSnapshot,
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationRun,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  assertValidAutomationIntervalCarrier,
  forceIntervalCarrierRecurring,
} from "#src/session/automationIntervalCarrier.js";
export { InvalidAutomationIntervalCarrierError } from "#src/session/automationIntervalCarrier.js";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeAutomationNextRunAt,
  inferMinuteIntervalScheduleRule,
  isValidCronExpr,
  scheduleRuleDefinition,
} from "#src/session/automationCron.js";

/** 写/单查操作的 workspace 归属；用于跨 workspace 隔离校验。 */
export interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope → workspaceKey；缺省返回 undefined（不加归属过滤，供 scheduler/host 跨 workspace 用）。 */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** 无效 cron 表达式错误（供管理层向 UI 返回可展示信息）。 */
// cron 非法错误携带原始表达式，便于 UI 直接提示。
// 与 scheduleRule 校验错误分开，调用方可按类型区分处理。
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`非法的 cron 表达式：${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** 非法的有限次数更新错误；用于阻止矛盾状态写入并误结束仍在运行的任务。 */
// 清空 maxRuns 必须与 recurring=true 同批提交，否则会静默结束仍在运行的任务。
// 默认文案已覆盖最常见误用。
export class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "清空 maxRuns 时必须在同一次更新中设置 recurring=true") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** 相对延迟只用于一次性任务，并由服务端真实时钟生成调度规则。 */
// 相对延迟只允许一次性语义，且必须由服务端时钟换算。
// 与客户端自算绝对 cron 明确区分。
export class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`非法的相对时间定时任务：${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

/**
 * automation 管理服务：包 AutomationRepo，负责 cron 语义（校验 / 下次时间计算）+ 生命周期重算。
 * 仓库只做存储；这里承载「create 时算 next_run_at」「改 cron_expr 重算」「改 recurring/max_runs 重算生命周期」
 * 「restart 重算」等 cron 相关业务，供 UI 管理面 / RPC 调用。
 */
// 构造函数注入 repo 与项目执行快照解析器，便于测试替换。
// prepareProjectExecution 缺失时创建项目型自动化会直接失败。
export class AutomationService {
  constructor(
    private readonly repo: AutomationRepo = new AutomationRepo(),
    private readonly prepareProjectExecution?: (
      projectId: string,
    ) => Promise<ProjectExecutionSnapshot>,
  ) {}

// 创建流程：参数校验 → carrier 归一化 → cron 校验 → 首次下次时间 → 项目执行准备 → 落库。
// 任一步失败都不写库。
  async create(params: ZCodeAutomationCreateParams): Promise<ZCodeAutomation> {
    const createdAt = Date.now();
    const relativeDelayMinutes = params.relativeDelayMinutes;
    if (
      relativeDelayMinutes !== undefined &&
      (!Number.isInteger(relativeDelayMinutes) ||
        relativeDelayMinutes < 1 ||
        relativeDelayMinutes > 525_600)
    ) {
      throw new InvalidAutomationRelativeDelayError("delayMinutes 必须是 1-525600 的整数");
    }
// 相对延迟与循环互斥。
    if (relativeDelayMinutes !== undefined && params.recurring) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务必须设置 recurring=false");
    }
// 相对延迟固定只运行一次，不接受上限。
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务固定只运行一次，不能设置 maxRuns");
    }
// 两种时间表达方式不能同时出现，避免语义冲突。
    if (relativeDelayMinutes !== undefined && params.scheduleRule) {
      throw new InvalidAutomationRelativeDelayError("不能同时提交 delayMinutes 和 scheduleRule");
    }
// carrier 校验放在相对延迟校验之后，两者互斥关系先行判定。
    const intervalUnit = params.intervalUnit;
    const interval = params.interval;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: params.scheduleRule,
      relativeDelayMinutes,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
    });
    // carrier 只用于本次归一化，不能透传到 repository 形成未定义的持久化字段。
    const {
// carrier 与相对延迟字段只参与归一化，不能透传成持久化字段。
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // 模型只知道日期时会自行猜测当前时刻，把“3 分钟后”算成两小时后或过去时间。
    // 相对时间必须由领域层基于真实 Date.now() 建立锚点，不能信任模型换算的绝对 cron。
// 相对时间统一在领域层用真实时钟换算，不信任模型给出的绝对 cron。
// 归一时强制 recurring=false。
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // 会话侧自定义重复 carrier 归一化：把 intervalUnit+interval + 兼容 cron 组装成权威 scheduleRule，
    // 真实间隔由 scheduleRule 承载，cronExpr 仅作展示。锚点用服务端真实创建时刻（同 relativeDelay）。
// carrier 归一化：真实间隔写入 scheduleRule，cronExpr 仅作展示。
// 锚点使用服务端创建时刻，避免客户端时钟偏差。
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // carrier 必须无限循环，避免旧客户端 / 内部调用写出首次派发即完成的矛盾状态。
            recurring: true,
            maxRuns: undefined,
            scheduleRule: buildIntervalScheduleRule(
              intervalUnit,
              interval,
              relativeNormalizedParams.cronExpr,
              createdAt,
            ),
          }
        : relativeNormalizedParams;
// 兼容展示用的 cron 也必须合法，否则 UI 无法渲染。
    if (!isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    // computeScheduleRuleNextRunAt 曾静默修正 interval=0，并在超大间隔下返回 null，
    // 使非法规则仍被持久化为 active。写库前必须在领域层拒绝，不能依赖 UI 选择器兜底。
// 写库前必须再次校验规则，不能依赖 UI 选择器兜底。
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // 标准 `*/N` cron 会对齐墙钟刻度，11:46 创建“每 10 分钟”会在 11:50
    // 提前触发。产品语义是从创建时刻计时，因此缺少显式规则时在领域层补上分钟锚点。
// 已有规则统一重置 anchorAt 为创建时刻。
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // 五段 cron 不含年份；一次性固定月日任务若在创建过程中刚错过目标分钟，
    // 普通 nextRun 会滚到下一年。首次计算只补偿小于一分钟的跨分钟误差，陈旧目标在写库前拒绝。
// 首次触发时间允许 1 分钟内的跨分钟补偿，更陈旧的目标会抛错。
    const nextRunAt = computeInitialAutomationNextRunAt(createParams, createdAt);
// 首次触发已晚于 endAt 时，任务创建即完成，不进入调度。
    const endedBeforeFirstRun =
      createParams.endAt !== undefined && (nextRunAt ?? Infinity) > createParams.endAt;
    let execution: ProjectExecutionSnapshot | undefined;
// 项目型自动化与任务绑定互斥，且必须能解析项目执行快照。
// 快照包含 host/additionalDirectories 等执行作用域。
    if (createParams.projectId) {
      if (createParams.targetTaskId) throw new Error("project.bound-task");
      if (!this.prepareProjectExecution) throw new Error("project.creation-unavailable");
      execution = await this.prepareProjectExecution(createParams.projectId);
    }
// 落库时把执行快照展开到任务参数，并显式给出首次触发与生命周期。
    return this.repo.create(
      { ...createParams, ...execution },
      {
        nextRunAt: endedBeforeFirstRun ? null : nextRunAt,
        ...(endedBeforeFirstRun ? { lifecycleStatus: "completed" as const } : {}),
      },
    );
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    return this.repo.list(scope);
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    return this.repo.hasTaskBinding(scope);
  }

  async get(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    return this.repo.get(automationId, resolveScopeKey(scope));
  }

// 更新流程：读取旧值 → carrier/规则归一化 → cron 与生命周期重算 → 落库。
// 旧值不存在时返回 null，不创建新行。
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;

// 直传规则与 carrier 二选一；两者都先做领域校验再归一化。
    if (params.scheduleRule) assertValidAutomationScheduleRule(params.scheduleRule);

    // 会话侧自定义重复 carrier 校验：intervalUnit+interval 必须配对且限定为 1–200，并与直传 scheduleRule 互斥。
// scheduleRule 单独取出：undefined 与 null 语义不同，不能混入 restParams。
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // `undefined` 表示不修改，`null` 表示显式清除已有规则；两者不能在解构后混为一谈。
    // 用 `??` 合并会把 `scheduleRule: null` 当作未传，导致用户无法恢复普通 cron 调度。
// 只有 undefined 表示未提供；null 是显式清除。
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
// carrier 已通过配对校验，此处仅判断是否本次提交。
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // 把 maxRuns=null 转成 undefined 后又按一次性任务上限 1 计算，
    // 会将已运行过的有限次任务静默改成 completed。清空上限必须与切换无限循环原子提交。
// 清空上限必须同时切到无限循环，否则已运行任务会被误判完成。
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

// 计算更新后的循环语义：carrier 恒为 true。
    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError("无限循环任务不能设置有限次数 maxRuns");
    }

    // 有限任务只提交 recurring=true 时，旧 maxRuns 会被 repo.update 原样保留，
    // 形成“无限循环 + 有限上限”的矛盾隐藏状态。领域层统一补 null，兼容旧客户端并原子清除旧上限；
    // 同时顺手修复历史上已经存在的同类脏数据。
// carrier 更新强制 recurring=true、maxRuns=null。
// 非 carrier 的“切循环但未给上限”场景补 null，顺带修复历史脏数据。
    const normalizedParams: ZCodeAutomationUpdateParams = hasIntervalCarrier
      ? forceIntervalCarrierRecurring(restParams)
      : nextRecurring &&
          restParams.maxRuns === undefined &&
          (restParams.recurring === true || existing.maxRuns !== undefined)
        ? { ...restParams, maxRuns: null }
        : restParams;

// 更新选项只包含需要重算的字段；未设置表示保持原值。
    const options: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
      resetRetry?: boolean;
    } = {};

    // 改 cron_expr：校验 + 以 now 重算 next_run_at + 清 retry 态。
// cron 是否变化决定是否需要重算 nextRunAt。
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
// 未提交 cron 时沿用旧表达式作为归一化输入。
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // 会话侧长间隔 carrier 归一化：把 intervalUnit+interval + 兼容 cron 组装成权威 scheduleRule。
    // carrier 场景必须重新锚定（anchorAt=updatedAt），后续 explicitScheduleRule 的「规则未变保留旧锚点」
    // 判断对 carrier 无意义——carrier 提交即代表用户要重设间隔，统一走本次保存重新计时。
// carrier 提交即代表重设间隔，锚点固定为本次保存时间。
    const carrierScheduleRule = hasIntervalCarrier
      ? buildIntervalScheduleRule(intervalUnit, interval, effectiveCron, updatedAt)
      : undefined;
    const effectiveDirectScheduleRule = hasDirectScheduleRule
      ? directScheduleRule
      : carrierScheduleRule;
    const normalizedWithSchedule: ZCodeAutomationUpdateParams =
      effectiveDirectScheduleRule !== undefined
        ? { ...normalizedParams, scheduleRule: effectiveDirectScheduleRule }
        : normalizedParams;
    if (effectiveDirectScheduleRule) {
      assertValidAutomationScheduleRule(effectiveDirectScheduleRule);
    }
// 规则内容未变时保留旧 anchorAt，避免保存其它字段导致计时漂移。
    const explicitScheduleRule = effectiveDirectScheduleRule
      ? {
          ...effectiveDirectScheduleRule,
          // 规则内容没变只是保存其它字段时保留原锚点；真正修改频率才从本次保存重新计时。
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // cron 改变但调用方没有显式 scheduleRule 时，旧规则不能继续覆盖新 cron；分钟间隔以本次
    // 修改时间重新锚定，其它 cron 则清空旧规则并恢复日历 cron 语义。
    const inferredScheduleRule =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? inferMinuteIntervalScheduleRule(effectiveCron, updatedAt)
        : undefined;
// 生效规则优先级：显式规则 > cron 变化后的推断规则 > 旧规则。
    const effectiveScheduleRule =
      effectiveDirectScheduleRule === undefined
        ? cronChanged
          ? inferredScheduleRule
          : existing.scheduleRule
        : (explicitScheduleRule ?? undefined);
    const updateParams =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? { ...normalizedWithSchedule, scheduleRule: inferredScheduleRule ?? null }
        : effectiveDirectScheduleRule === undefined
          ? normalizedWithSchedule
          : { ...normalizedWithSchedule, scheduleRule: explicitScheduleRule ?? null };
    if (
      cronChanged ||
      normalizedParams.endAt !== undefined ||
      effectiveDirectScheduleRule !== undefined
    ) {
      options.nextRunAt = computeAutomationNextRunAt(
        {
          cronExpr: effectiveCron,
          scheduleRule: effectiveScheduleRule,
        },
        updatedAt,
      );
// 重算触发时间同时清理重试态，避免旧失败记录影响新计划。
      options.resetRetry = true;
    }

// endAt 的 undefined 表示不修改，null 表示清除。
    const effectiveEndAt =
      normalizedParams.endAt === undefined ? existing.endAt : (normalizedParams.endAt ?? undefined);
    if (
      effectiveEndAt !== undefined &&
      (options.nextRunAt ?? existing.nextRunAt ?? Infinity) > effectiveEndAt
    ) {
      options.nextRunAt = null;
      options.lifecycleStatus = "completed";
    } else if (
      normalizedParams.endAt !== undefined &&
      (existing.lifecycleStatus === "completed" || existing.lifecycleStatus === "failed")
    ) {
      options.lifecycleStatus = "active";
    }

    // 改 recurring / max_runs：重算生命周期。
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount 是 Card 的累计展示数，包含 manual run；若用它重算有限计划，
      // 用户只要手动执行过就可能在编辑 maxRuns 时把任务提前改成 completed。
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
// 读不到计划执行次数说明任务已被删除，中止更新。
      if (scheduledRunCount === null) return null;
      // 与 markDispatched 口径一致：有限次任务未显式设 max_runs 时按一次性任务(上限 1)处理。
// [契约] maxRuns 只对比 getScheduledRunCount：手动执行无数次也不会把 max_runs 用尽。
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // 原为终态，编辑后又变得可跑 → 复活为 active 并重算 next_run_at。
        options.lifecycleStatus = "active";
        if (options.nextRunAt === undefined) {
          options.nextRunAt = computeAutomationNextRunAt(
            {
              cronExpr: effectiveCron,
              scheduleRule: effectiveScheduleRule,
            },
            updatedAt,
          );
        }
      }
    }

// 仓库负责原子写入并返回更新后的完整记录。
    return this.repo.update(automationId, updateParams, options, workspaceKey);
  }

// delete 是物理删除；scope 不匹配时返回 false，而不是抛错。
// 运行记录的级联清理由 repo/表约束负责，本层不重复判断。
  async delete(automationId: string, scope?: AutomationWorkspaceScope): Promise<boolean> {
    return this.repo.delete(automationId, resolveScopeKey(scope));
  }

  /** 暂停 / 恢复。 */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** 失败任务手动重跑：回 active、清计数，按 cron 重算下次时间。 */
// 手动重跑只允许 failed 任务，完成态不可复活。
// 重跑会按当前 cron 重新计算下一次触发时间。
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed 是有限次计划自然耗尽后的终态，不能被旧 UI/RPC restart 复活；
    // 只有 failed 代表可恢复异常，允许用户手动重排下一次运行。
// completed 是有限计划的正常终点，不能被 restart 改写。
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** 立即运行：创建供当前 host 直接派发的 manual run，不修改原 cron 计划。 */
// 立即运行创建一次 manual run，不修改原计划与 nextRunAt。
// 返回 null 表示任务不存在或作用域不匹配。
  async runNow(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<{ automation: ZCodeAutomation; run: ZCodeAutomationRun } | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;
    return this.repo.runNow(automationId, { now: Date.now() }, workspaceKey);
  }

// 运行记录按创建时间倒序返回，作用域与任务查询一致。
  async listRuns(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomationRun[]> {
    return this.repo.listRuns(automationId, resolveScopeKey(scope));
  }
  async deleteRun(runId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    return this.repo.deleteRun(runId, resolveScopeKey(scope));
  }
}
