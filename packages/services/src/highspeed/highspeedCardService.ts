import {
  resolveHighspeedProviderId,
  resolveHighspeedDrawProviderId,
  highspeedDrawResponseSchema,
  HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
  type HighspeedCardApi,
  type HighspeedCardUsage,
  type HighspeedCardSnapshot,
  type HighspeedDrawRequest,
  type HighspeedDrawResponse,
  type HighspeedPrepareFallbackReason,
  type HighspeedPrepareTurnParams,
  type HighspeedPrepareTurnResult,
  type HighspeedServiceSnapshot,
  type HighspeedTurnExecution,
  type ModelSelection,
} from "@zcode/shared";
import type { IHighspeedCardService } from "./highspeedCard.js";

// 透传 HTTP transport 工厂，保持 highspeed 模块对外入口集中在本文件，调用方无需深入子路径。
export { createHighspeedHttpTransport } from "./highspeedHttpTransport.js";

// transport 是唯一的外部副作用出口（draw/healthy），便于测试注入假实现；
// 服务本身只负责卡的获取、缓存与过期判定，所有网络 IO 都由注入的 transport 完成。
export interface HighspeedServiceTransport {
  draw(request: HighspeedDrawRequest): Promise<HighspeedDrawResponse>;
  healthy(cardId: string): Promise<HighspeedCardUsage>;
}

/**
 * 加速推理的动态鉴权材料。加速走 /api/v1/highspeed/ 网关，与 draw 复用同一套 Coding Plan
 * 双 JWT 契约：zcode JWT 标识会话身份，Coding Plan 业务 JWT + Team 身份头校验套餐权益。
 * 这些字段必须来自同一次 selected connection 解析，禁止跨 Family 拼接
 * （ZAI JWT 配 BigModel key 只会在服务端取号时被拒）。
 */
export interface HighspeedInferenceAuth {
  zcodeJwt: string;
  family: "zai" | "bigmodel";
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}

// 依赖注入项全部可选：now/wait 供确定性测试控制时间，其余 resolver 缺省为宽松放行，
// 保证 mock 与既有单测语义不变；生产装配必须显式提供真实 resolver。
export interface HighspeedCardServiceOptions {
  transport: HighspeedServiceTransport;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /**
   * 加速推理动态鉴权材料。加速卡按账号 Family 拆分，不跨 Family 静默迁移；必须与 draw
   * 复用同一次 selected connection 解析。缺省夹具仅服务本地测试。
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** Mock 抽中只验证业务状态，消息继续走 session 当前的普通推理路由。 */
  inferenceMode?: "highspeed" | "session-default";
  /** draw 只对 Coding Plan 用户开放；缺省视为支持，保持 mock 与既有测试语义。 */
  resolveCodingPlanSupported?: () => Promise<boolean>;
  /**
   * 会话模型必须属于所选 Coding Plan Provider 的模型目录才允许发起新 draw（spec §3 规则 14）；
   * 缺省视为覆盖，保持 mock 与既有测试语义。判定异常按不通过处理，避免陈旧组合打到 draw 接口。
   */
  resolveModelCovered?: (providerId: string, modelId: string) => Promise<boolean>;
}

// 单次 prepareTurn 的默认发送预算：超时只结束本轮等待（降级普通发送），不取消已发出的请求。
// 取值偏短是产品取舍——用户可感知的等待上限优先于抽卡成功率。
const DEFAULT_WAIT_BUDGET_MS = 1000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** 让一段 await 与本次 prepareTurn 的发送预算竞速；预算耗尽只结束等待，不取消该请求。 */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan 双 JWT + Team 身份头。draw 与加速推理走同一个 /api/v1/highspeed/ 网关、同一套
 * 鉴权中间件：两者必须携带完全一致的 Coding Plan 凭据，加速推理只是额外附带卡 ID。
 */
// 纯函数：校验并归一化双 JWT 与 Team 身份头，缺失或 Team 字段不全时直接抛错。
// 只做 shape 校验，不解析 token 内容；调用方负责保证字段来自同一次 connection 解析。
export function buildHighspeedCodingPlanAuthHeaders(params: {
  zcodeJwt: string;
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}): Record<string, string> {
  // 两份凭据都先 trim 再判空：凭据库可能存裸 token 或夹带换行，直接拼进 header 会被网关当成空串。
  const zcodeJwt = params.zcodeJwt.trim();
  // codingPlanAuthorization 单独归一化：它与 zcodeJwt 来自不同存储，缺哪份都要单独报错，不能互相顶替。
  const codingPlanAuthorization = params.codingPlanAuthorization.trim();
  // zcode JWT 缺失立刻抛错而不是返回降级：buildHighspeedTurnExecution 必须拿到完整凭据才允许发请求。
  if (!zcodeJwt) throw new Error("highspeed request requires zcode jwt");
  if (!codingPlanAuthorization) throw new Error("highspeed request requires Coding Plan jwt");
  // TEAM 身份要求 organizationId 与 projectId 同时存在；少一个服务端会按个人套餐处理，权益校验必然失败。
  if (params.targetType === "TEAM" && (!params.organizationId || !params.projectId)) {
    throw new Error("highspeed team request requires organization and project");
  }
  return {
    Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
    // 接口契约要求 Bearer 前缀；凭据库可能存裸 token，这里统一归一化。
    "X-Bigmodel-Authorization": /^Bearer\s/i.test(codingPlanAuthorization)
      ? codingPlanAuthorization
      : `Bearer ${codingPlanAuthorization}`,
    // targetType 是网关选择套餐表的键；PERSONAL 与 TEAM 传反会把请求路由到另一套权益。
    "Bigmodel-Target-Type": params.targetType,
    ...(params.targetType === "TEAM"
      ? {
          "Bigmodel-Organization": params.organizationId!,
          "Bigmodel-Project": params.projectId!,
        }
      : {}),
  };
}

// 服务端 snake_case 契约 → 内部 camelCase 快照，隔离 API 字段命名对外泄漏。
function toSnapshot(card: HighspeedCardApi): HighspeedCardSnapshot {
  return {
    // cardId 与 taskId 原样透传：服务端靠这两个字段定位卡与归属，改名会让后续 invalidateCard 匹配失效。
    cardId: card.card_id,
    taskId: card.task_id,
    provider: card.provider,
    model: card.model,
    issuedAt: card.issued_at,
    // expiresAt 保留服务端毫秒原值，不在解析层加偏移；本地过期判定与网关必须用同一刻度。
    expiresAt: card.expires_at,
  };
}

/**
 * 构造一次加速执行的选择与动态鉴权材料。Endpoint、API 形态和模型能力等静态事实由
 * ZCode Built-in Provider Config 提供，禁止再随单次发送下发 provider 定义。
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * 抽卡时的提交选择（会话原模型 + 思考档位）。加速只换端点不换模型，execution 选择沿用它的档位，
   * 否则 CLI Registry 会因缺档位拒绝本轮；它同时是降级的退回目标，必须随 selectionFallback 下发。
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  // family 只决定 builtin Provider 前缀，模型仍取卡里回显的 model；拿 family 当模型会直接跑错模型。
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // 卡回显的是请求时提交的 model：加速来自换端点，不换模型。
      modelId: params.card.model,
      // execution 作用域的选择必须完整：带上会话档位，否则 CLI Registry 会因缺档位拒绝本轮。
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    // apiKey 是 Anthropic 兼容字段，headers 才是网关真正校验的凭据；两者必须来自同一份 auth。
    requestAuth: {
      // Anthropic 兼容客户端会发送 x-api-key；服务端仍以 Authorization、Coding Plan 双 JWT 与卡 ID 裁决。
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug 原因：加速推理曾只发 zcode JWT + 卡 ID，而它与 draw 走同一 highspeed 网关、同一
        // 鉴权中间件，缺少 Coding Plan 双 JWT + Team 身份头时网关无法校验套餐权益，返回
        // 401 auth_failed。这里复用与 draw 完全一致的 Coding Plan 头，再附加本次执行的卡 ID。
        ...buildHighspeedCodingPlanAuthHeaders({
          zcodeJwt: params.auth.zcodeJwt,
          codingPlanAuthorization: params.auth.codingPlanAuthorization,
          targetType: params.auth.targetType,
          ...(params.auth.organizationId ? { organizationId: params.auth.organizationId } : {}),
          ...(params.auth.projectId ? { projectId: params.auth.projectId } : {}),
        }),
        "X-Highspeed-Card-ID": params.card.cardId,
      },
    },
    // 加速请求任何失败都退回会话模型跑完本轮（spec §2.2）：规则按序匹配，卡过期（3402）单独给出
    // 原因以便 Renderer 区分提示；兜底规则不带错误码，覆盖鉴权、限流、5xx、网络、超时、流中断。
    // CLI 只按声明匹配，不自行解释错误码；带该声明的执行句柄在适配层 0 次重试，首次失败即退回。
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Bug 根因：退回目标曾只依赖 CLI 内存里的会话常驻选择。桌面重启后冷恢复若落在 Registry 刚就绪、
      // 账号权益未解析的窗口内，持久化选择校验失败不绑定；之后只发加速轮也不会再绑定，卡过期（3402）
      // 时降级静默跳过，整轮按 "highspeed card is invalid" 失败弹错。发起方在这里明确知道原模型，
      // 必须把它作为退回目标随声明下发（spec §2.2），不再押注 runtime 状态。
      target: structuredClone(params.sessionSelection),
    },
  };
}

// 每个实例只持有一张有效卡与一个 in-flight draw：并发 prepareTurn 共享同一请求，
// 卡按 taskId 归属校验，跨任务只读不抢占；状态全部驻留内存，进程重启后由新实例重建。
export class HighspeedCardService implements IHighspeedCardService {
  private readonly transport: HighspeedServiceTransport;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly resolveInferenceAuth: () => Promise<HighspeedInferenceAuth>;
  private readonly inferenceMode: "highspeed" | "session-default";
  private readonly resolveCodingPlanSupported: () => Promise<boolean>;
  private readonly resolveModelCovered: (providerId: string, modelId: string) => Promise<boolean>;
  private card: HighspeedCardSnapshot | null = null;
  private nextDrawAt: number | null = null;
  private inFlightDraw: Promise<HighspeedDrawResponse> | null = null;

  constructor(options: HighspeedCardServiceOptions) {
    // transport 是唯一副作用出口，必填且不设默认：默认实现会把网络请求悄悄变成 no-op。
    this.transport = options.transport;
    // now 与 wait 只供测试注入；缺省走真实时钟与 setTimeout，生产路径没有额外抽象层。
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.resolveInferenceAuth =
      options.resolveInferenceAuth ??
      (async () => ({
        zcodeJwt: "mock-zcode-jwt",
        family: "zai",
        codingPlanAuthorization: "mock-coding-plan-jwt",
        targetType: "PERSONAL",
      }));
    // 三个 resolver 缺省都宽松放行，只服务本地 mock；生产漏注入时不会拦请求，但无凭据请求仍会被网关拒。
    this.inferenceMode = options.inferenceMode ?? "highspeed";
    // 套餐能力缺省视为支持，保持既有单测语义；生产装配必须显式注入真实判定，否则等于放开 draw。
    this.resolveCodingPlanSupported = options.resolveCodingPlanSupported ?? (async () => true);
    this.resolveModelCovered = options.resolveModelCovered ?? (async () => true);
  }

// 决策顺序固定：自动化 → 现有卡 → 冷却 → provider 白名单 → 门禁 → draw。
// 前面的同步分支不注册计时器，只有真正可能阻塞的 await 才进入发送预算。
// 任何失败都以 fallback 结果返回而不是抛错，让上层始终能按会话模型完成本轮。
  async prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult> {
    // Bug 原因：定时任务是后台输入轮，不应参与面向用户主动发送的抽卡；门禁必须只看
    // 本轮 automationId，不能读取 Task 上粘性的 cronAutomationId，否则同会话手动输入也会失去加速。
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    // 本轮只取一次 now：过期判定与预算截止共用它，避免中途时钟跳变让有效的卡被判过期。
    const now = this.now();
    this.expireCard(now);
    // Bug 根因：1s 预算曾只包住 draw 等待，门禁判定（模型目录要等 Provider Runtime 初始化）与
    // 加速鉴权解析都在预算外单独 await，Registry 未就绪或凭据解析卡住时发送被无限期挂起。
    // 预算从进入 prepareTurn 起算，所有 await 共享同一截止时间（spec §3 规则 12）。
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    // 已有卡直接复用，不再走门禁与 draw：卡能否用只由 expiresAt 与 taskId 决定，重复抽卡白扣额度。
    if (this.card) {
      return this.prepareWithCard(this.card, params, withinBudget);
    }
    // 冷却只挡新 draw 不挡已有卡：抽卡节奏与用卡节奏分开，否则连抽失败会把正在用的卡一起冻住。
    if (this.nextDrawAt !== null && now < this.nextDrawAt) {
      return { kind: "fallback", reason: "cooldown", nextDrawAt: this.nextDrawAt };
    }

    // draw body 的 provider 契约是服务端白名单里的 Coding Plan builtin 身份
    // （builtin:zai-coding-plan / builtin:bigmodel-coding-plan）；Start/Off-Peak/API Key/
    // 自定义 Provider 解析不出白名单值，直接降级，不打必被服务端拒绝的请求。
    // 回归约束：禁止把会话选择的完整 providerId（如 account:bigmodel-team-coding-plan）
    // 或账号 Family（bigmodel）透传进 body，两者都会被白名单以 3001 参数错误拒绝。
    const drawProviderId = resolveHighspeedDrawProviderId(params.providerId);
    if (!drawProviderId) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }

    // 门禁只拦新 draw；in-flight 是之前合法发起的请求，不受门禁影响。
    // 门禁只拦新 draw；in-flight 是已通过门禁的请求，重复判定会把同一请求拒第二次。
    if (!this.inFlightDraw) {
      const gate = await withinBudget(this.checkDrawGates(params.providerId, params.model));
      // 门禁超出预算按未就绪降级（规则 14），不发起 draw；判定本身不取消，完成后预热下一轮。
      if (gate.kind === "timeout") {
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
      if (gate.value) {
        return { kind: "fallback", reason: gate.value, nextDrawAt: this.nextDrawAt };
      }
    }

    const draw = this.inFlightDraw ?? this.startDraw(params, drawProviderId);
    const outcome = await withinBudget(draw);
    if (outcome.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", nextDrawAt: this.nextDrawAt };
    }

    this.applyDrawResponse(outcome.value);
    if (!this.card) {
      return { kind: "fallback", reason: "draw-miss", nextDrawAt: this.nextDrawAt };
    }
    return this.prepareWithCard(this.card, params, withinBudget);
  }

// 读取前先按当前时间清理过期卡，保证快照与 prepareTurn 使用同一套过期判据。
  async getSnapshot(): Promise<HighspeedServiceSnapshot> {
    // 读取前先按当前时间清理：快照与 prepareTurn 必须用同一过期判据，否则 UI 会展示一张下一轮注定被拒的卡。
    this.expireCard(this.now());
    return {
      card: this.card,
      nextDrawAt: this.nextDrawAt,
      // drawing 由 inFlightDraw 推导，不额外维护布尔量；两处状态写不同步会让 UI 一直转圈。
      drawing: this.inFlightDraw !== null,
    };
  }

// 仅按 cardId 匹配才作废，旧事件不会误删随后抽到的新卡；冷却计时保持不变。
  async invalidateCard(cardId: string): Promise<boolean> {
    this.expireCard(this.now());
    if (this.card?.cardId !== cardId) return false;
    // Bug 根因：创建期发现加速 Provider 已从 Registry 下架时，卡仍留在服务里，Renderer 会继续
    // 锁定模型选择器。按事件携带的 cardId 作废当前卡，旧事件不能误删随后抽到的新卡；冷却时间不变。
    this.card = null;
    return true;
  }

  healthy(cardId: string): Promise<HighspeedCardUsage> {
    // 直接转发用量查询不做缓存：配额是服务端事实，缓存会让 UI 显示已经失效的额度。
    return this.transport.healthy(cardId);
  }

  /**
   * 新 draw 的门禁：规则 14 模型目录、规则 11 Coding Plan 支持，按序判定，返回 fallback 原因，
   * 全部通过返回 null。判定异常按不通过处理；不改变卡、冷却与 in-flight 状态。
   * 会话恢复出的陈旧（coding-plan provider, 已下线模型）组合会照常通过 provider 白名单，
   * 必须由模型目录拦下，避免把无效组合或无效凭据打到 draw 接口。
   */
  private async checkDrawGates(
    providerId: string,
    modelId: string,
  ): Promise<Extract<HighspeedPrepareFallbackReason, "unavailable" | "no-coding-plan"> | null> {
    // 先查 isModelCovered 再查套餐：目录不覆盖时连凭据都没必要解析，少一次可能卡住的外部调用。
    // 返回原因而不是布尔值：上层要按规则区分 unavailable 与 no-coding-plan，才能给出不同提示。
    if (!(await this.isModelCovered(providerId, modelId))) return "unavailable";
    if (!(await this.isCodingPlanSupported())) return "no-coding-plan";
    return null;
  }

  /**
   * 截止时间在进入 prepareTurn 时固定；计时器按需懒创建且只建一次，后续各段 await 复用，
   * automation / 冷却 / 白名单外等同步降级路径不注册计时器。
   */
  private createSendBudget(startedAt: number, budgetMs: number): SendBudget {
    // 截止时间在进入 prepareTurn 时算定，后续每段 await 都相对它判断剩余量，而不是各自重新计时。
    const deadline = startedAt + budgetMs;
    let expired: Promise<{ kind: "timeout" }> | null = null;
    return <T>(task: Promise<T>) => {
      // 剩余量用 max(0, ...) 兜底：已经超时的调用也要立刻拿到 timeout，而不是负数延时。
      expired ??= this.wait(Math.max(0, deadline - this.now())).then(() => ({
        kind: "timeout" as const,
      }));
      // race 的 task 侧先包成 settled：超时后任务仍可能成功，但结果不再被采纳，卡由下一轮重新读取。
      return Promise.race([task.then((value) => ({ kind: "settled" as const, value })), expired]);
    };
  }

  private async isCodingPlanSupported(): Promise<boolean> {
    try {
      // resolver 抛错由外层 catch 转成 false：一次 provider 调用失败只该降级本轮，不该把 prepareTurn 整个打成异常。
      return await this.resolveCodingPlanSupported();
    // 这里吞掉异常且不记日志：调用方只看布尔结果，按每轮发送刷日志只会淹没真正原因。
    } catch {
      return false;
    }
  }

  private async isModelCovered(providerId: string, modelId: string): Promise<boolean> {
    try {
      // 模型目录依赖 Provider Runtime 初始化；初始化未完成时抛错，按不覆盖处理只降级本轮。
      return await this.resolveModelCovered(providerId, modelId);
    // 与 isCodingPlanSupported 分开包装：失败语义相同但排查入口不同，合并会丢掉 providerId 与 modelId 上下文。
    } catch {
      return false;
    }
  }

// in-flight 去重：同一时刻只允许一个 draw，后续调用复用该 Promise 而非重复扣额度。
// finally 中以引用比较清理，避免较晚完成的旧请求清掉新请求的引用。
  private startDraw(
    params: HighspeedPrepareTurnParams,
    drawProviderId: string,
  ): Promise<HighspeedDrawResponse> {
    // 先构造 Promise 并挂 then/finally，再赋给 inFlightDraw：同步段内不会出现请求已发出但未登记的窗口。
    const draw = this.transport
      .draw({ task_id: params.taskId, provider: drawProviderId, model: params.model })
      // 先落地卡与冷却再返回：调用方拿到 response 时下一轮已能读到卡，不用再等事件循环同步。
      .then((response) => {
        this.applyDrawResponse(response);
        return response;
      })
      .finally(() => {
        if (this.inFlightDraw === draw) this.inFlightDraw = null;
      });
    // 引用相等才清理：慢的旧请求结束时不会把后来新请求的 inFlightDraw 引用一并清掉。
    this.inFlightDraw = draw;
    return draw;
  }

// 先按 schema 校验再落地状态，避免畸形响应把卡/冷却写成不可用值；落地后立即按当前时间清理过期卡。
  private applyDrawResponse(response: HighspeedDrawResponse): void {
    // 先 schema 校验再写状态：畸形响应会让 next_draw_at 变成 undefined，宁可本轮没卡也不能写坏冷却。
    const parsed = highspeedDrawResponseSchema.parse(response);
    this.nextDrawAt = parsed.data.next_draw_at;
    this.card = parsed.data.card ? toSnapshot(parsed.data.card) : null;
    this.expireCard(this.now());
  }

  private expireCard(now: number): void {
    // 用 <= 判定：expiresAt 与 now 同毫秒即视为过期，服务端不会在边界上再多给一次机会。
    if (this.card && this.card.expiresAt <= now) this.card = null;
  }

// 卡只能服务抽卡时的同一 taskId，跨任务返回 foreign-card 并带回卡快照供上层展示。
// session-default 模式只验证卡存在，推理仍走会话默认路由，供 mock/灰度使用。
  private async prepareWithCard(
    card: HighspeedCardSnapshot,
    params: Pick<HighspeedPrepareTurnParams, "taskId" | "providerId" | "model" | "reasoningLevel">,
    withinBudget: SendBudget,
  ): Promise<HighspeedPrepareTurnResult> {
    // 先校验归属再解析鉴权：跨任务用卡会被服务端按越权拒绝，提前降级能省掉一次无意义的凭据读取。
    if (card.taskId !== params.taskId) {
      return { kind: "fallback", reason: "foreign-card", card, nextDrawAt: this.nextDrawAt };
    }
    // session-default 只验证卡存在、不返回 execution：推理继续走会话默认路由，供 mock 与灰度使用。
    if (this.inferenceMode === "session-default") {
      return {
        kind: "accelerated",
        card,
        nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      };
    }
    // 鉴权解析也计入发送预算：凭据库卡住时本轮不能无限等待，超时按 draw-timeout 降级。
    const auth = await withinBudget(this.resolveInferenceAuth());
    // 鉴权解析超出预算：本轮普通发送，复用 draw-timeout 语义（「卡未能在预算内就绪」）；
    // 卡保留且随结果带回，下一轮鉴权就绪后直接复用加速。
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
    }
    // 退回目标就是本次提交的会话选择（provider / model / 档位）：它与卡无关，也不依赖 CLI 运行态。
    const sessionSelection: ModelSelection = {
      providerId: params.providerId,
      modelId: params.model,
      ...(params.reasoningLevel ? { options: { reasoningLevel: params.reasoningLevel } } : {}),
    };
    return {
      // execution 与 card 一起返回：调用方没有 execution 只能按普通轮次发送，卡仍留在缓存等下一轮。
      kind: "accelerated",
      card,
      // nextDrawAt 为空时退回卡过期时间：UI 才不会显示无冷却而立刻触发一次必然失败的 draw。
      nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      execution: buildHighspeedTurnExecution({ card, auth: auth.value, sessionSelection }),
    };
  }
}
