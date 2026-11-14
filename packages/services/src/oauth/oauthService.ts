// 深度注释：OAuth 会话生命周期与 provider 切换的唯一入口（运行在 Host 进程）。
//
// INV-01：所有凭据写入必须经 runSessionMutation 串行化；绕过队列的写入会插进 401 核对/清理窗口，
//  或在 logout 之后把凭据复活。守住位置：runSessionMutation、persistOAuthSession、refreshToken 写回，三处都必须先入队。
// INV-02：oauthSessionGeneration 是会话版本号，登录/登出/失效都会自增；后台任务必须捕获进入时
//   的版本并在每次写入前复核，否则会覆盖更新的登录选择。
//  守住位置：restoreCachedSessionState、invalidateExpiredCachedSession、saveBigModelCachedProfileMigration，三处写入前都必须复核 generation。
// INV-03：pendingState 只允许一个活动 flow；回调与 polling 落盘前必须复核 this.pendingState === pending，
//   防止迟到的结果覆盖新 flow。守住位置：runPendingSessionCompletion、handleCallback。
// INV-04：清理互斥 provider 必须在保存新 token 之前完成；反序会让 clearProvider 删掉共享的 zcodejwttoken。
//   守住位置：persistOAuthSession。
// INV-05：ZAI 与 BigModel 是互斥身份域，登录一方即清理另一方；两者共用 zcodejwttoken。
//   守住位置：resolveInactiveOAuthProvider 及其唯一调用点。
// INV-06：登出先撤销本地认证事实（清凭据 + fire signed-out），再清理派生 provider；
//   派生清理失败不能把 UI 留在伪登录态。守住位置：logoutActiveSession、invalidateExpiredCachedSession。
// INV-07：recentlyCompletedPollingState 是「轮询已成功」的去重窗口（30s），用于把迟到的 deep link
//   回调识别为 duplicate 并只补记归因；它必须同时校验 generation 与 state，缺一个就会误吞新登录。
//   守住位置：runPendingSessionCompletion、handleCallback。
// 说明：本文件不做刷新去重（单次交换由调用方持有），只保证刷新结果写回与其它会话写入互斥、
// 且写回时不会覆盖更晚的登录结果（先用 generation 复核再落盘）。
/* eslint-disable max-lines -- OAuthService 集中维护 OAuth 会话生命周期和 provider 切换边界，当前 review 修复只收窄后台迁移写入条件。 */
import { randomBytes } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthSessionState,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
  isCredentialDecryptError,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth 超时时间（5 分钟） */
// flow 的本地寿命上限（5 分钟）。服务端下发的 expires_at 更短时以服务端为准（见 timeoutMs 取 min），
// 因为浏览器侧已按服务端时间展示倒计时，本地活得更久只会让 pendingState 悬空。
// [资源] 该值直接决定 setTimeout 时长，clearPendingState 必须清掉它，否则泄漏定时器。
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
// 轮询成功后仍保留 state 的去重窗口：浏览器 deep link 可能在轮询成功之后才到达。
// 窗口太短会把迟到回调当「state 不匹配」抛错；太长会让同 state 的旧回调被误判成 duplicate。
// 判定还必须同时校验 generation 与 state（INV-07）。
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
// 跨 provider 共享的后端 JWT。两个 provider 共用同一个键，因此切换 provider 时
// 清理旧 provider 绝不能删除它（INV-04）。
// 本文件同时用它做启动恢复的登录门槛（ZAI 分支必须存在该 token）。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
// log 是带 pid 的裸输出，只用于本地排查；生产事件必须走下面的 serviceLog。
const log = (...args: unknown[]) =>
// console.log 不做分级也不落盘，因此不能出现在凭据相关路径上——会带出 state/token。
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
// serviceLog 是本文件唯一的分级日志出口，scope 固定为 oauthService；凭据相关路径只能走它。
const serviceLog = createServiceLogger("oauthService");

// 活动登录 flow 的全部状态。字段约束：
// - state 既是对外回调的校验值，也是 pendingState 的身份；
// - phase 只前进不回退（归因中转 → 等待授权码）；
// - polling 非空表示 Host 轮询型 flow，超时与去重都按 flowId 校验。
interface PendingState {
  // state 既是回调校验值也是 pendingState 的身份，同一字符串同时用于 URL 与去重。
  state: string;
  // provider 决定回调走哪个适配器；拿到 state 后必须回查这里，不能用回调入参覆盖。
  provider: OAuthProviderId;
  // timeout 是本地 flow 寿命定时器，clearPendingState 必须清掉它，否则泄漏（INV-03）。
  timeout: NodeJS.Timeout;
  // phase 只前进不回退：先等归因中转，再等授权码。
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  // completionPromise 让并发 handleCallback 共享同一次完成结果，避免重复交换授权码。
  completionPromise?: Promise<OAuthCallbackResult | null>;
  // polling 非空表示 Host 轮询型 flow：超时与去重都按 flowId 与 pollToken 校验。
  polling?: {
  // expiresAt 取服务端 expires_at 与本地 5 分钟的较小值，过期后不再轮询。
    expiresAt: number;
  // flowId 是服务端 flow 的唯一标识，轮询与取消都按它寻址。
    flowId: string;
  // nextPollAt 是下一次轮询的绝对时间；退避只改这个值，不改 pollIntervalMs。
    nextPollAt: number;
  // pollIntervalMs 保留服务端建议的间隔，用于计算退避上限，退避时不能改写它。
    pollIntervalMs: number;
  // pollToken 是轮询凭证，不能写进日志、事件负载或错误文案。
    pollToken: string;
  // pollUrl 由适配器拼好，service 层不再二次拼接，避免与 provider 规则分叉。
    pollUrl: string;
  };
}

// 服务端信封最小形状：只声明本文件实际读取的 code、msg、data 三个字段，其余一律忽略，不参与判断。
interface OAuthFlowEnvelope {
  // code 是业务状态码，非 0 时必须按 ApiError 抛出，不参与文本匹配。
  code?: unknown;
  // msg 只用于错误文案，不参与分支判断，否则文案改动会导致行为变化。
  msg?: unknown;
  // data 的结构由调用方按 flow 类型收窄，这里保持 unknown 不做假设。
  data?: unknown;
}

// 构造参数全部可选：生产走默认适配器与 process.env，测试必须注入时钟与环境。
interface OAuthServiceDependencies {
  // adapters 注入后仍会复制进 Map，调用方之后修改数组不影响本实例。
  adapters?: OAuthProviderAdapter[];
  // apiClient 同时传给适配器与 repo，保证鉴权与数据请求共用同一连接配置。
  apiClient?: ApiClient;
  // now 注入时钟：超时与去重窗口的测试要能推进时间，不能依赖真实 Date.now。
  now?: () => number;
  // env 注入环境：桌面与 CLI 的 redirect_uri 与 API 地址来自不同变量。
  env?: NodeJS.ProcessEnv;
  // onProviderLogout 由 Host 注入，用于清理 OAuth 命名空间之外的派生 provider。
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

// 只接受非空字符串：回调里的 code/state 可能是数组或空串，统一在这里收敛成 string|null。
function readTrimmedString(value: unknown): string | null {
  // trim 后为空按缺失处理，返回 null；调用方用 === null 判断，不能按 falsy 判断。
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 收窄成 Record 只判断「是对象且非 null」：数组也会通过，调用方读字段前仍需校验。
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  // 不检查原型与字段类型：OAuth 响应是不可信输入，字段级校验交给下游 schema。
  return typeof value === "object" && value !== null;
}

// 对外只暴露展示字段；rawProfile 不在这里透出，它可能含邮箱与第三方令牌。
function toUserInfo(profile: OAuthUserProfile): UserInfo {
// 把内部 profile 收窄成对外 UserInfo：只保留 id、username、displayName、avatarUrl 四个展示字段，其余必须留在白名单之外。
// 必须在这里做白名单拷贝，不能把 rawProfile 原样带出去，它可能含邮箱、第三方令牌等不该外泄的字段。
// avatarUrl 为空时用条件展开省略键，而不是写空字符串，避免 UI 拿到空值仍去渲染占位头像。
  return {
  // id 是 provider 侧稳定标识，参与凭据键，不能换成会变的 username。
    id: profile.id,
  // username 用于 UI 与日志关联，允许空串但不可为 undefined。
    username: profile.username,
  // displayName 缺失时由适配器回填 username，这里不做二次兜底。
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

// 用于「快照比对」：后台任务写入前要求当前 profile 与启动时读到的完全一致。
// rawProfile 用 JSON.stringify 比较而不是引用比较：profile 来自持久化还原，引用必然不同。
// 代价是键序敏感——两侧都来自同一序列化路径，因此可接受；不要用它比较不同来源的 profile。
function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
// 比较两份 profile 是否同一快照：后台迁移与过期清理在写入前都靠它确认身份没有被替换。
// 逐字段比较 id、username、displayName、avatarUrl，因为 profile 从持久化还原后引用必然不同，不能用引用相等。
// rawProfile 用 JSON 序列化比较，键序敏感但两侧来自同一序列化路径；判错的后果是误删新登录或旧迁移覆盖新 profile。
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

// ZAI 与 BigModel 互斥：登录其中一方即清理另一方（INV-05）。
// 返回 null 表示该 provider 没有互斥对象，调用方按「无需要清理」处理，不要当成同 provider。
// 只用 if 判断具体常量而没有映射表：provider 数量固定，映射表反而隐藏了「互斥」这层语义。
// 该函数是纯函数，只有 persistOAuthSession 调用它，所以审计清理范围时只需看这一处。
function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
// 返回与入参互斥的另一个身份域：ZAI 与 BigModel 共用共享 JWT，登录一方必须清另一方。
// 只有这两个 provider 存在互斥关系，其它 provider 返回 null，调用方不能把 null 当成同一个 provider。
// 保持纯函数且没有映射表：调用点固定为 persistOAuthSession，审计清理范围时只需看这一处。
  if (provider === ZAI_PROVIDER_ID) {
  // ZAI 登录后必须清理 BigModel：两者共用 zcodejwttoken，留着会造成身份双写（INV-05）。
    return BIGMODEL_PROVIDER_ID;
  }
  // 反向同理：BigModel 登录后必须清理 ZAI。
  if (provider === BIGMODEL_PROVIDER_ID) {
    // 返回的是要清理的一方，不是入参本身；调用方不能把它当 active provider 使用。
    return ZAI_PROVIDER_ID;
  }
  // 其它 provider 没有互斥对象，返回 null 让调用方跳过清理，不能当成同 provider。
  return null;
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 */
// 本类是 OAuth 凭据的唯一写者：外部只能通过 restore/start/callback/refresh/logout 改变状态。
// [并发] 三个并发控制点：
// 1) sessionMutationQueue：所有凭据写入串行化（INV-01）；
// 2) oauthSessionGeneration：会话版本号，用于判别后台任务是否已过期（INV-02）；
// 3) pendingState：同时只允许一个活动 flow（INV-03）。
// 三者都只防「进程内逻辑竞态」，不提供跨进程互斥：本实例必须由 Host 单例持有。
export class OAuthService implements IOAuthService {
// [并发] 事件在凭据队列之外同步 fire：订阅方不得在回调里 await 凭据写入，
// 否则通知顺序会与队列顺序解耦。
// fire 时机是「本地认证事实已落定」，不是「派生 provider 已清理完成」（INV-06）。
  private readonly sessionChanges = new Emitter<OAuthSessionState>();
  // 事件对外只读，订阅方拿不到 Emitter 本身，因此不能从外部 fire。
  readonly onDidChangeSession = this.sessionChanges.event;
  // 凭据读写全部经 credentialService，本类不直接碰 credentials.json。
  private readonly credentialService: ICredentialService;
  // repo 只管 OAuth 命名空间内的键；跨命名空间的派生清理必须回到本类。
  private readonly repo: OAuthCredentialRepo;
  // adapters 在构造时定型，之后不增删；getProviders 与查表都依赖这份不可变清单。
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  // 一律通过 this.now() 取时间，禁止直接调用 Date.now，否则测试无法推进超时。
  private readonly now: () => number;
  // onProviderLogout 可能抛错：调用点要逐 provider 捕获，不能让它中断登出主流程。
  private readonly onProviderLogout?: (
    // 第一个参数是 provider id，第二个是可选的账号身份，派生清理依赖它定位账号。
    provider: OAuthProviderId,
    // 返回 Promise：派生清理可能是异步 IPC，调用方必须 await 后再继续。
    accountIdentity?: string | null,
  ) => Promise<void>;
  // apiClient 可为空：只在需要远端校验的分支使用，空值时走纯本地路径。
  private readonly apiClient?: ApiClient;
  // env 是构造时快照，运行期不再重读 process.env，避免实例行为随环境漂移。
  private readonly env: NodeJS.ProcessEnv;
// 活动 flow 槽位。用「单槽 + 身份比较」而不是按 state 建 Map：
// 同一时刻只允许一条登录流程，多槽会让两个浏览器窗口同时登录时产生两套凭据写入。
// oauthFlowStartGeneration 单独存在（不复用 oauthSessionGeneration）：登录「发起」早于
// 「凭据写入」，发起竞态必须能在没有任何凭据变化时被识别。
// oauthFlowStartProvider 记录最近一次发起者，仅用于 logout(provider) 判断是否取消当前 flow。
// [资源] pendingState.timeout 必须由 clearPendingState 清理，否则泄漏定时器（INV-03）。
// 槽位与定时器都只在本类内部变更，外部只能通过 cancelPending 触发清理。
  private pendingState: PendingState | null = null;
  // 发起版本号与 oauthSessionGeneration 分开：登录「发起」早于「凭据写入」（INV-02）。
  private oauthFlowStartGeneration = 0;
  // 记录最近一次发起者，仅用于 logout(provider) 判断是否取消当前 flow。
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  // 会话版本号：登录、登出、失效都自增，后台任务写入前必须复核（INV-02）。
  private oauthSessionGeneration = 0;
  // 串行队列的队尾：所有凭据写入挂在它后面，绕过者会插进 401 清理窗口（INV-01）。
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  // 轮询成功后的去重窗口，把迟到的 deep link 回调识别成 duplicate（INV-07）。
  private recentlyCompletedPollingState: {
    // generation 必须与当前会话版本一致，旧 flow 的成功结果不能参与去重。
    generation: number;
    // expiresAt 是窗口截止时间，超时后同 state 的迟到回调重新按新回调处理。
    expiresAt: number;
    // provider 用于确认去重命中的是同一身份域。
    provider: OAuthProviderId;
    // state 与 generation 必须同时匹配，缺一个就会误吞新登录（INV-07）。
    state: string;
  } | null = null;

// repo 只负责 OAuth 命名空间内的读写；跨命名空间的派生清理必须回到本类。
// 本地凭据解密失败等价于强制 logout：先 fire signed-out 撤回 UI 的已登录态，再通知 provider 清理。
// 顺序不能反，否则清理期间 UI 仍认为已登录。
  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    // 依赖只做赋值不校验：类型由构造签名保证，运行期失败留给首次使用处暴露。
    this.credentialService = credentialService;
    // ?? 而不是 ||：注入的 now 返回 0 也必须生效。
    this.now = dependencies.now ?? Date.now;
    // 未注入时保持 undefined，调用点用可选链跳过，而不是退化成空函数。
    this.onProviderLogout = dependencies.onProviderLogout;
    // apiClient 为空表示只走本地路径，远端校验前必须判空。
    this.apiClient = dependencies.apiClient;
    // 环境快照只取一次，避免测试中途改 process.env 影响已建实例。
    this.env = dependencies.env ?? process.env;

// 适配器集合在构造时固定下来，之后不再增删，getProviders 与查表都依赖这份不可变清单。
    const adapters =
      dependencies.adapters ??
    // 默认适配器按运行时配置创建；注入 adapters 时整段跳过，保证测试不触网。
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      // 构造默认适配器也要带 apiClient，否则远端校验会另建一条连接。
        apiClient: dependencies.apiClient,
      });

// 按 providerId 建索引，重复 id 会后者覆盖前者，适配器工厂必须保证每个 provider 唯一。
    for (const adapter of adapters) {
    // 重复 providerId 后者覆盖前者：适配器工厂必须保证唯一，这里不做告警。
      this.adapters.set(adapter.providerId, adapter);
    }
    // repo 绑定同一份 credentialService 与 provider 清单，命名空间边界由它守住。
    this.repo = new OAuthCredentialRepo(credentialService, {
      // providerIds 传全量清单（含未启用），否则禁用 provider 的旧凭据无法被恢复读取。
      providerIds: adapters.map((adapter) => adapter.providerId),
      // 损坏会话清理回调：先 fire signed-out 撤回 UI 态，再清理派生 provider（INV-06）。
      onCorruptOAuthSessionCleared: async (providers) => {
        // fire 在清理之前：清理可能失败，但 UI 不能停留在「已登录」的假象里。
        this.sessionChanges.fire("signed-out");
        // 本地 OAuth 凭据解密失败后等价于强制 logout。
        // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  // 只返回 enabled 的 provider 并按 order 升序，保证 UI 顺序不随 Map 迭代漂移。
  async getProviders(): Promise<OAuthProviderMeta[]> {
// 对外只暴露启用中的 provider，并按 order 升序稳定排序，保证 UI 顺序不随 Map 迭代顺序漂移。
// 未启用的适配器仍留在 this.adapters 中，供恢复已登录会话等内部路径读取。
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  // 直接取 repo 的 active provider：本类不缓存，避免与凭据文件形成两个事实源。
  async getActiveProvider(): Promise<OAuthProviderId | null> {
    // 不做缓存：每次返回 repo 的当前值，避免与凭据文件形成两个事实源。
    return this.repo.getActiveProvider();
  }

// 兼容旧接口：只关心「是否已登录 + 用户信息」，需要区分「需要重新认证」的调用方不能用这个返回值。
// 应使用 restoreCachedSessionState，否则会把 jwt-expired 误降级成未登录。
// 返回值不含 jwt-expired 语义，这是兼容接口的既定契约，不要在这里扩展。
  async restoreCachedSession(): Promise<UserInfo | null> {
    // 复用缓存恢复的状态机，把三态收敛成 UserInfo | null。
    const result = await this.restoreCachedSessionState();
    // 只有 authenticated 返回用户；signed-out 与 reauthentication-required 都返回 null。
    return result.status === "authenticated" ? result.userInfo : null;
  }

// 启动首屏恢复：只读本地凭据，不发网络请求、不触发后台迁移（迁移另行 fire-and-forget）。
// 判定顺序：无 active provider → provider 已不可用 → 无缓存 profile → 本地 JWT 过期 → 成功。
// 使用「缓存 profile 即已登录」而不是远端 userinfo 校验：zai/bigmodel 的 access_token 生命周期
// 很短，强校验会把刚登录的用户误判成未登录。
// restoreGeneration 在整个流程开始时捕获，任何写入前都要复核（INV-02）。
// [权衡] 不在这里直接清理过期凭据：清理会写凭据，必须进队列并重新校验快照。
// [权衡] provider 已不可用分支只清 active provider，不删 token：适配器可能只是本次未启用。
// 该分支返回 signed-out 而不是抛错：配置导致的不可用不应让首屏崩溃。
  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    // 流程起点捕获版本号：之后每次写凭据前都要拿它复核，变了就整套放弃（INV-02）。
    const restoreGeneration = this.oauthSessionGeneration;
    // 先读 active provider：没有身份域就拼不出后续任何凭据键。
    const activeProvider = await this.repo.getActiveProvider();
    // 首次启动或用户已登出时为空，直接按未登录返回，不读任何 token。
    if (!activeProvider) {
      // 只记分支名，不记凭据：日志会进采集。
      log("restoreCachedSession skipped: no active provider");
      // 返回 signed-out 而不是抛错：启动期没有登录是正常状态。
      return { status: "signed-out" };
    }

    // 按 active provider 查适配器：查不到说明该 provider 已从构建中移除。
    const adapter = this.adapters.get(activeProvider);
    // 适配器被禁用等价于不可用：拿它的 token 恢复会让 UI 显示一个无法刷新的登录态。
    if (!adapter || !adapter.meta.enabled) {
      // 记下被清掉的 provider，便于排查「改配置导致掉登录」。
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      // 只清 active provider，不删 token：适配器可能只是本次未启用，删了就不可恢复。
      await this.repo.setActiveProvider(null);
      // 返回 signed-out：配置问题不应让首屏抛错。
      return { status: "signed-out" };
    }

// 缓存 profile 缺失即视为未登录，不做「用 token 反推用户」的兜底：拿不到身份就无法做账号隔离。
// 这里不调用 loadActiveTokenSet，避免把后台 profile 迁移与网络请求带回首屏链路。
// 同样的原因，下方的过期检查直接读原始凭据键而不走 repo 的聚合读取。
    const profile = await this.repo.loadActiveUserProfile();
    // 缓存 profile 缺失即视为未登录；不做「用 token 反推用户」的兜底，拿不到身份就无法隔离账号。
    if (!profile) {
      // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
      // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
      // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      // 声明式返回而非抛错：首屏恢复路径不允许因缓存缺失而崩。
      return { status: "signed-out" };
    }

    // 业务 JWT 过期而共享 JWT 仍有效时，旧实现会恢复伪登录态；直接读两个凭据做本地检查，
    // 不调用 loadActiveTokenSet，避免把后台 profile 迁移或网络请求带回首屏恢复链路。
// 直接读两个凭据键（共享 JWT + provider access_token）做本地过期检查。
// 顺序固定：[0] 是 zcodejwttoken，下游只按 tokens[0] 取它，重排会导致读错凭据。
// 业务 JWT 过期而共享 JWT 仍有效时，旧实现会恢复出伪登录态，这正是两个都要检查的原因。
    let tokens: { key: string; value: string }[];
    try {
      // 并发读两个键：串行读会在两次 IO 之间留下「一个成功一个失败」的窗口。
      tokens = await Promise.all(
        [ZCODE_JWT_TOKEN_KEY, `oauth:${activeProvider}:access_token`].map(async (key) => ({
        // 键名顺序固定，[0] 必须是 zcodejwttoken；下游用 tokens[0] 直接取，重排会静默取错。
          key,
        // 空串兜底：加载失败与键不存在都收敛成空串，让过期判定不依赖 undefined。
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
// 只有解密失败（凭据损坏）才进入清理路径，其它 IO 错误原样抛。
// 清理必须进队列并在队列内重读：旧恢复任务不能删除已经提交的新登录（INV-02）。
// cleared=false 说明期间会话已变化，重跑一次恢复以读取最新状态，而不是直接返回 signed-out。
      if (!isCredentialDecryptError(error)) throw error;
      // 清理走会话队列：队列外删除会与并发登录交错，删掉刚提交的新凭据（INV-01）。
      const cleared = await this.runSessionMutation(async () => {
        // 损坏凭据清理也是会话写入；旧恢复须在队列内重读，不能删除已提交的新登录。
        if (this.oauthSessionGeneration !== restoreGeneration) return false;
// 队列内重读：只有当前仍没有任何缓存 token 才算损坏清理成功，否则说明新登录已写入，必须放弃。
        const currentTokens = await this.repo.loadCachedSessionTokens(activeProvider);
        // 队列内重读：仍有缓存 token 说明新登录已写入，本次损坏清理必须放弃。
        if (currentTokens !== null) return false;
        // 自增版本号让所有在途任务失效，后续写入前复核都会失败。
        this.oauthSessionGeneration += 1;
        // true 表示确实清掉了损坏凭据，调用方据此返回 signed-out 而不是重跑。
        return true;
      });
      // cleared=false 说明期间会话已变：重跑恢复读取最新状态，不能直接判未登录。
      return cleared ? { status: "signed-out" } : this.restoreCachedSessionState();
    }
      // 两个键都参与过期判定：只查业务 JWT 会漏掉共享 JWT 过期，只查共享 JWT 会放过伪登录态。
    const expired = tokens.find(
      ({ value }) => value && resolveJwtExpiration(value, this.now()).kind === "expired",
    );
      // 单独取出共享 JWT：ZAI 分支要判断它是否存在，避免再读一次凭据。
    const zcodeJwtToken = tokens[0]?.value ?? "";
// [失败路径] 过期清理走 invalidateExpiredCachedSession：它内部复核 generation/provider/profile/JWT
// 四项必须同时成立，否则放弃清理并重跑恢复，避免误删新登录。
// invalidated=false 表示期间已发生变更，重新读取最新状态。
// 只有清理成功才返回 reauthentication-required，让 UI 明确引导重新登录。
    if (expired) {
      // 只记 provider 与键名，不记值：过期 JWT 仍是凭据。
      serviceLog.info("cached session invalidated because login JWT expired", {
      // provider 字段把日志归到身份域，便于排查多账号切换。
        provider: activeProvider,
      // credentialKey 指明是哪把凭据过期（共享 JWT 或 provider access_token）。
        credentialKey: expired.key,
      });
      // 清理内部做 generation、provider、profile、JWT 四元组复核，不成立就返回 false。
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        expired.value,
        expired.key,
      );
      // false 表示期间已发生变更：重跑恢复读取最新事实，而不是把用户判成未登录。
      if (!invalidated) {
      // 递归重跑而不是返回 signed-out：新登录可能已经生效，直接登出会误伤。
        return this.restoreCachedSessionState();
      }
      // reauthentication-required 让 UI 引导重新登录，与普通 signed-out 区分。
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

// BigModel 旧缓存 profile 的后台迁移：fire-and-forget，不能让首屏等待，也不能抛给调用方。
// 迁移必要性：旧版本持久化的 profile 缺少当前 schema 字段，补齐后 UI 才有完整信息。
// 迁移会读 token 并可能发请求，因此「读 token」与「写 profile」两步都包在 runSessionMutation 里，
// 并各自复核 generation（INV-02）。
// [权衡] 失败只记日志：迁移是纯增强，失败不应影响用户已经可用的登录态。
// 迁移成功也不 fire 事件：身份未变，只是字段补齐，触发 signed-in 会让 UI 无谓刷新。
// 只在 profile 变化时记日志，避免每次启动都产生噪声。
    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      // 迁移生成号单独捕获：迁移期间任何会话变更都要让本次迁移作废（INV-02）。
      const migrationGeneration = this.oauthSessionGeneration;
      // void 显式丢弃 Promise：迁移是纯增强，不阻塞首屏，也不允许把异常抛进恢复链路。
      void refreshLegacyBigModelCachedProfile({
      // 复用已解析的 adapter，避免迁移内部再走一次 provider 查表。
        adapter,
      // 传入缓存 profile：迁移只补 schema 字段、不改身份；判断是否同一身份必须依赖这份快照。
        cachedProfile: profile,
      // 读 token 的回调走队列内的复核版本，迁移里不直接碰 credentialService。
        loadTokenSet: () =>
      // 传入生成号与 profile 快照，队列内逐项比对后才返回 token。
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
      // 注入时钟：迁移里的过期判断必须与恢复流程用同一个时间源。
        now: this.now,
      // 适配器错误统一包装，迁移失败时仍然会区分网络失败与凭据失败，并保留原始 cause。
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
      // 写 profile 的回调同样带回快照，落盘前复核 generation 与 active provider。
        saveProfile: (nextProfile) =>
      // nextProfile 是补齐字段后的结果，只有当前缓存仍是旧快照时才允许覆盖。
          this.saveBigModelCachedProfileMigration(migrationGeneration, profile, nextProfile),
      })
        .then((migratedProfile) => {
// 迁移完成回调：只有 profile 真的变了才记日志，避免每次启动都刷同一条记录。
// 这里不 fire signed-in，身份没有变化，只是 schema 字段补齐，通知 UI 反而会造成无谓刷新。
          if (migratedProfile !== profile) {
            // 只在引用变化时记日志：migratedProfile !== profile 表示确实补了字段。
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
// 迁移是纯增强，失败只记日志并吞掉，不能让后台任务异常变成未处理的 Promise 拒绝。
// 只输出 message，避免把可能含凭据的完整错误对象写进日志。
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

// ZAI 额外要求共享 JWT 存在：只有缓存 profile 时，缺少 zcodejwttoken 会把实际不可用的状态
// 误判成已登录（sidebar 登录入口此前只看缓存 user_info，正是栽在这里）。
// 该门槛放在最后，避免为它提前读取 token。
    if (activeProvider === ZAI_PROVIDER_ID) {
      // ZAI 的登录态以共享 JWT 为准：有缓存 profile 但没有 zcodejwttoken 时按未登录处理。
      if (!zcodeJwtToken) {
        // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
        // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        // 返回 signed-out 而不是清 profile：JWT 缺失可能是暂时性写入失败，清掉会丢身份。
        return { status: "signed-out" };
      }
    }

      // 走到这里说明 provider 可用、profile 存在、token 未过期，可以恢复为已登录。
    log("restoreCachedSession restored:", activeProvider, profile.id);
      // 只透出展示字段：rawProfile 与 token 不进入返回值。
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

// 过期会话失效：队列内做四元组复核并清理，队列外取消 flow 与通知派生 provider。
// 清理（本地事实）与通知（派生状态）分开：通知可能走网络，不能占住凭据队列（INV-06）。
// 返回 false 表示「快照已变、什么都没做」，调用方应重跑恢复而不是当作已登出。
// 通知失败只 warn：主认证事实已失效，不能因派生清理失败把 UI 留在伪登录态。
// 清理后必须 cancelPending，否则仍在进行的 flow 会再次写回凭据。
  private async invalidateExpiredCachedSession(
    // expectedGeneration 是进入清理时的版本号，队列内必须与当前值相等。
    expectedGeneration: number,
    // expectedProvider 限定身份域：期间切到别的 provider 就放弃清理。
    expectedProvider: OAuthProviderId,
    // expectedProfile 用于逐字段比对，确认当前缓存仍是同一账号。
    expectedProfile: OAuthUserProfile,
    // expectedJwt 是判定过期的那个值：用户重新登录后 JWT 会变，变了就不能清。
    expectedJwt: string,
    credentialKey = ZCODE_JWT_TOKEN_KEY,
  ): Promise<boolean> {
// 四元组复核必须放在队列内，否则队列外读到的 generation、provider、profile、JWT 可能已被新登录改写。
    const invalidated = await this.runSessionMutation(async () => {
// 队列内重读磁盘上的当前事实，与进入时捕获的快照逐项比对；任一项不同必须放弃清理。
// 只有完全没有缓存 token 且 generation 未变时才算损坏清理成功，否则说明新登录已经写入。
      const currentProvider = await this.repo.getActiveProvider();
      // 队列内重读 provider：队列外读到的值可能已被新登录改写。
      const currentProfile = await this.repo.loadUserProfile(expectedProvider);
      // 重读 JWT 并 trim：与进入时的 expectedJwt 逐字符比较，任何刷新都视为新会话。
      const currentJwt = (await this.credentialService.load(credentialKey))?.trim() ?? "";
      // 任一项不符即放弃：这是正常竞态，不是错误，因此返回 false 而不是抛错。
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // 启动恢复读取过期凭据后，新登录或 provider 切换可能已经完成；
        // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
        serviceLog.info("skipped stale expired JWT session invalidation", {
        // 只记 provider，不记 profile 或 JWT：日志会进采集，不能带凭据。
          provider: expectedProvider,
        });
        // false 表示什么都没做，调用方据此重跑恢复而不是判未登录。
        return false;
      }
      // 复核通过才自增 oauthSessionGeneration：先失效在途任务，再写盘，否则写入会被旧任务覆盖。
      this.oauthSessionGeneration += 1;
      // 清 active session 是本地事实的变更，必须在队列内完成。
      await this.repo.clearActiveSession();
      // fire 在队列内：UI 状态必须与磁盘事实同时翻转，不能出现「已清盘但仍显示登录」。
      this.sessionChanges.fire("signed-out");
      // true 表示清理生效，队列外还要取消 flow 并通知派生 provider。
      return true;
    });
    // 快照已变：直接返回 false，不做取消与通知，避免影响新会话。
    if (!invalidated) {
      // 与上面一致：false 不是失败，是「本次不适用」。
      return false;
    }
// false 只表示快照已变、本次什么都没清，调用方应重跑恢复读取最新状态，而不是直接判未登录。
    await this.cancelPending(expectedProvider);
    try {
// 清理与派生通知分开：通知可能走网络，不能占住凭据队列，失败也不影响已失效的本地事实。
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
      serviceLog.warn("expired JWT derived provider cleanup failed", {
      // 只记 provider 与错误对象；派生清理失败不影响已失效的本地事实。
        provider: expectedProvider,
        error,
      });
    }
    // 返回 true：本地认证事实已失效，调用方据此返回 reauthentication-required。
    return true;
  }

// 迁移用的 token 读取：目标固定是 BigModel，因此必须读 BigModel 命名空间。
// 发请求前复核 active provider 仍是 BigModel：切到 ZAI 后把别的 provider token 发给 BigModel，
// 既是鉴权失败也是凭据泄露。
// 返回 null 表示迁移应放弃，调用方按「无 token」处理。
  private async loadBigModelCachedProfileMigrationTokenSet(
    // generation 快照：队列内比对，期间任何登录或登出都会让迁移放弃。
    expectedGeneration: number,
    // profile 快照：确认缓存仍是迁移开始时那一份，避免把旧结果的 token 发给新账号。
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
// 读 token 也进会话队列，与迁移写入同域，避免读到一半被登出或 provider 切换插队。
    return this.runSessionMutation(async () => {
      // 版本不符立即退出：此时读到的 token 已不属于本次迁移。
      if (this.oauthSessionGeneration !== expectedGeneration) {
      // 只记分支，不读凭据：迁移放弃不会报错，属于正常竞态。
        log("restoreCachedSession skipped stale BigModel token migration");
      // null 表示无 token，调用方按「迁移条件不满足」处理。
        return null;
      }

      // 队列内重读 active provider：切到 ZAI 后不能继续用 BigModel 的键。
      const activeProvider = await this.repo.getActiveProvider();
      // 读的是 BigModel 命名空间的 profile，不能换成 active provider 的 profile。
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      // 三个条件任一不符就放弃：provider 不对、profile 缺失、或已被新登录覆盖。
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
        // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
// 版本一致还不够，必须确认 active provider 与缓存 profile 仍是迁移开始时那份。
// 目标固定是 BigModel，token 也只能读 BigModel 命名空间，混用会把令牌发给错误的身份域。
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
      // null 而不是抛错：竞态可预期，调用方只需跳过迁移。
        return null;
      }

      // 只读 BigModel 命名空间：混用会把令牌发给错误身份域，既是鉴权失败也是泄露。
      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

// 迁移结果落盘：要求 generation、active provider、当前 profile 三者必须都与迁移开始时一致。
// 期间用户可能 logout、切到 ZAI 或重新登录 BigModel，旧结果一律丢弃（INV-02）。
// [权衡] 用「profile 完全相等」而不是「时间戳更新」判断，因为持久化没有版本号可用。
// 三个条件任意一条不满足都静默 return：这是正常竞态，不是错误。
  private async saveBigModelCachedProfileMigration(
    // 落盘前同样要生成号快照：写 profile 属于会话写入。
    expectedGeneration: number,
    // expectedCachedProfile 是启动时的旧快照，用于确认没有被新一轮登录覆盖。
    expectedCachedProfile: OAuthUserProfile,
    // nextProfile 是迁移产物，只在快照仍匹配时才写入。
    nextProfile: OAuthUserProfile,
  ): Promise<void> {
    // 写 profile 必须进队列：与 logout、provider 切换串行，避免旧迁移写回已清理的 user_info。
    await this.runSessionMutation(async () => {
      // 版本不符直接丢弃：旧迁移结果不得覆盖新会话。
      if (this.oauthSessionGeneration !== expectedGeneration) {
      // 只记分支：丢弃属于正常竞态，不能抛错。
        log("restoreCachedSession skipped stale BigModel profile migration");
        // 直接 return：旧迁移结果不得覆盖新会话。
        return;
      }

      // 队列内重读 active provider：迁移期间用户可能已切到 ZAI。
      const activeProvider = await this.repo.getActiveProvider();
// 写 profile 同样进队列，并在队列内重读 generation 与 active provider，任一不符就丢弃旧迁移结果。
// 只有当前缓存仍是启动时那份旧 profile 才允许覆盖，避免旧结果盖掉新一轮登录写入的 profile。
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
      // 只记 provider：profile 含身份字段，不进日志。
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
      // 丢弃属于正常竞态，不能抛错，否则会把首屏恢复搞崩。
        return;
      }

      // 读当前 profile 用于逐字段比对，不能只看 provider 相同。
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
// 当前 profile 与期望快照完全一致才允许覆盖，防止旧迁移结果盖掉新一轮登录写入的 profile。
// 用 isSameOAuthProfile 的完全相等判断而不是时间戳，因为持久化没有版本号可用。
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
        // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
        log("restoreCachedSession skipped outdated BigModel profile migration");
      // 快照不一致即放弃：旧迁移结果不得盖掉新一轮登录写入的 profile。
        return;
      }

      // 三步复核全部通过才落盘，写入的是补齐 schema 后的 profile。
      await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile);
    });
  }

// [并发] 所有凭据写入的唯一入口。串行化的必要性：
// 一次登录会跨多个凭据键（token / profile / active provider）写入，底层不是事务，
// 交错执行会留下半套身份。
// 队列本身吞掉上一个任务的失败，否则一次失败会让后续所有写入永久 reject；
// 调用方拿到的仍是自己的 Promise，失败会照常传播，只是不污染队列。
// 队列不设超时：用超时掩盖慢写入只会让「写入是否生效」变得不确定。
  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
    // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    // 队尾只记 settled 结果：失败已由调用方处理，队尾再 reject 会让后续写入永久失败。
    this.sessionMutationQueue = next.catch(() => undefined);
    // 返回给调用方的是自己的 Promise，异常照常传播，不污染队列。
    return next;
  }

// 登录成功后的多点写入。步骤顺序即不变量：
// 1) 先读全部旧值，供回滚使用；
// 2) 自增 generation，让所有在途旧任务立即失效（INV-02）；
// 3) 清理互斥 provider，必须在写新 token 之前完成（INV-04）；
// 4) 写 token → 写 profile → 写 active provider，每步后复核 flow 是否仍有效；
// 5) 最后 fire signed-in（INV-06）。
// [事务] 这不是原子事务：任何一步失败都靠 rollback 显式补偿，补偿失败只能记日志。
// [事务] 崩溃/断电时可能残留半套凭据，下次启动会因 profile 或 token 缺失而按未登录处理。
  private async persistOAuthSession(
    // provider 决定写哪一组凭据键，也决定互斥对象是谁。
    provider: OAuthProviderId,
    // tokenSet 是即将落盘的完整令牌，写之前不再做二次校验。
    tokenSet: OAuthTokenSet,
    // profile 会先过 withProviderProfileSchema，补齐 provider 特有字段。
    profile: OAuthUserProfile,
    // isStillCurrent 由调用方提供：本函数不读 pendingState，刷新与登录复用同一套回滚语义。
    isStillCurrent?: () => boolean,
  ): Promise<void> {
// 登录成功后的唯一写入点：先把所有将被改动的旧值读成快照，后面任一步失败都靠它补偿。
// 读取顺序固定，快照必须覆盖 token、profile、互斥 provider 和 active provider 四类键。
    const inactiveProvider = resolveInactiveOAuthProvider(provider);
    // 快照必须覆盖四类键：token、profile、互斥 provider 的 token 与 profile、active provider。
    const previousTokenSet = await this.repo.loadTokenSet(provider);
    // token 与 profile 分开读：回滚时缺失的那一项要 clear 而不是写空值。
    const previousProfile = await this.repo.loadUserProfile(provider);
    // 互斥 provider 只在 ZAI 与 BigModel 之间存在；其它 provider 为 null。
    const previousInactiveTokenSet = inactiveProvider
      // 互斥方的 token 也要快照，回滚时按原样写回。
      ? await this.repo.loadTokenSet(inactiveProvider)
      // 三元的两支必须成对：有互斥方才读，否则保持 null。
      : null;
      // 互斥方的 profile 同上：回滚需要原值，不能只恢复 token。
    const previousInactiveProfile = inactiveProvider
      // 读的是互斥方命名空间的 profile，不是入参 provider 的。
      ? await this.repo.loadUserProfile(inactiveProvider)
      // null 表示本次不涉及互斥方，回滚分支会跳过它。
      : null;
    // active provider 也要快照：切换失败时必须恢复到原来的身份域。
    const previousActiveProvider = await this.repo.getActiveProvider();
// 显式补偿：把本次改动的 credentialService 键还原为进入前的值，有则写回、无则清除。
// 覆盖范围必须与写入范围一致，否则回滚后会残留「半套身份」。
// 回滚本身也可能失败；此时错误向上传播，由调用方决定是否重新登录。
// [权衡] 先快照再写入而不是先写后查：写入路径无法回读「旧值」，只有快照能还原。
    const rollback = async () => {
// 回滚按与写入相反的顺序还原本次动过的每个键：先 token、再 profile、最后 active provider。
// token 有快照就写回、没有快照必须 clear，留空字符串会让下游把空 token 当成可用凭据。
// 互斥 provider 的旧值也要还原，否则回滚后旧身份域被清空、新身份域也没写成，用户直接掉登录。
// 回滚自身失败不吞异常：它说明本地凭据可能停在半套状态，调用方需要重新登录而不是继续使用。
      if (previousTokenSet) await this.repo.saveTokenSet(provider, previousTokenSet);
      // 没有旧 token 时必须 clear：写空串会让下游把空凭据当成可用 token。
      else await this.repo.clearProvider(provider);
      // profile 同理：有旧值写回，没有则清除，不能留下本次写入的新 profile。
      if (previousProfile) await this.repo.saveUserProfile(provider, previousProfile);
      // clearUserProfile 只清 profile 键、不动 token，回滚时不能连带删掉刚写回的 token。
      else await this.repo.clearUserProfile(provider);
      // 只有存在互斥方才需要恢复它的两组键；否则本函数没动过它。
      if (inactiveProvider) {
      // 有旧 token 就原样写回，恢复切换前的身份域。
        if (previousInactiveTokenSet)
        // saveTokenSet 重建互斥方的 token 键；与下面的 clearProvider 分支互斥。
          await this.repo.saveTokenSet(inactiveProvider, previousInactiveTokenSet);
        // 没有旧 token 则清空该 provider，避免留下半套身份。
        else await this.repo.clearProvider(inactiveProvider);
      // 互斥方 profile 同样按「有则写回、无则清除」处理。
        if (previousInactiveProfile)
        // 写回旧 profile 后，互斥方的身份才算完整恢复。
          await this.repo.saveUserProfile(inactiveProvider, previousInactiveProfile);
        // 没有旧 profile 就清掉，不能保留本次登录写入的 profile。
        else await this.repo.clearUserProfile(inactiveProvider);
      }
      // active provider 最后恢复：它决定 UI 认哪个身份域，必须等两组键都就位。
      if (previousActiveProvider) await this.repo.setActiveProvider(previousActiveProvider);
      // 原本没有 active provider 时回滚成 null，而不是保留本次写入的 provider。
      else await this.repo.setActiveProvider(null);
    };
    // 每个写盘步骤前调用：失效即回滚已写部分再抛错，避免留下半套身份。
    const assertCurrent = async () => {
// 每次落盘前复核 flow 是否仍有效；失效就先回滚已写部分再抛错，避免留下半套身份。
// 判断函数由调用方传入，这里不自己读 pendingState，刷新与登录可以复用同一套回滚语义。
      if (isStillCurrent && !isStillCurrent()) {
        // 回滚必须在抛错前完成：调用方收到错误时磁盘不应停在半写状态。
        await rollback();
        // 文案固定，调用方按 catch 分支识别「已取消」。
        throw new Error("OAuth flow 已取消");
      }
    };
    // 先自增版本号：所有在途后台任务立即失效，后续写入前复核都会失败。
    this.oauthSessionGeneration += 1;
    // 互斥 provider 的清理必须早于写新 token，否则会误删共享的 zcodejwttoken（INV-04）。
    if (inactiveProvider) {
        // 清互斥方前复核：flow 已取消时不能再去动另一个身份域。
      await assertCurrent();
      // ZAI 与 BigModel 是互斥身份域。切换 provider 时必须先清旧 provider，
      // 再保存当前 token；反序会让 clearProvider 误删共享的 zcodejwttoken。
      await this.repo.clearProvider(inactiveProvider);
    }
    // 写 token 前复核：排队等锁期间 flow 可能已被取消。
    await assertCurrent();
    // token 是新会话的核心事实；写入失败会走回滚，不会留下 profile 与 token 不一致。
    await this.repo.saveTokenSet(provider, tokenSet);
    // 写 profile 前复核：token 已落盘，取消时必须回滚掉它。
    await assertCurrent();
    // withProviderProfileSchema 补齐 provider 特有字段，避免旧 profile 缺字段导致 UI 渲染失败。
    await this.repo.saveUserProfile(provider, withProviderProfileSchema(provider, profile));
    // 写 active provider 前最后一次复核：写错会让用户看到别人的账号。
    await assertCurrent();
    // active provider 最后写：前两类键都就位后才切换身份域。
    await this.repo.setActiveProvider(provider);
    // 最后再查一次：active provider 写入无法被底层 IO 取消，只能写后补偿。
    if (isStillCurrent && !isStillCurrent()) {
      // active provider 写入无法被底层 credential IO 取消；失效 flow 不能仅按
      // provider 清理，否则同 provider 的新 flow 可能被旧 flow 误删。
      await rollback();
      // 回滚而不是只清 provider，否则同 provider 的新 flow 可能被旧 flow 误删。
      throw new Error("OAuth flow 已取消");
    }
    // 凭据是认证事实源；同账号重登也必须通知，不能等 renderer 的设置更新或成功计数。
// 凭据是认证事实源，因此同账号重登也必须通知：
// 不能等 renderer 的设置更新或成功计数，否则 UI 会在重登后仍显示旧状态。
    this.sessionChanges.fire("signed-in");
  }

// 兑换 + 落盘的统一收口，polling 与 deep link 都从这里进入。
// 三个关键复核点：
// 1) 入队后复核 pendingState 仍是自己（迟到的 flow 不能落盘，INV-03）；
// 2) 保存归因后必须再复核一次 pending 是否仍有效（保存期间可能被取消）；
// 3) 兑换返回后再复核（exchangeToken 期间用户可能取消或开始新流程）。
// 三者缺一都会让已取消的登录把旧凭据写回本地。
// 命中去重窗口时返回 duplicate 而不是 null：调用方据此知道「已经登录过了」。
  private async runPendingSessionCompletion(
    // pending 是本次完成的身份凭据：所有复核都靠对象引用相等，而不是 state 字符串。
    pending: PendingState,
    // complete 只做兑换，不写盘；写盘由 persistOAuthSession 统一收口。
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    // preserveAttribution 可选：归因写入与凭据写入同队列入队，避免顺序颠倒。
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
// 兑换整体放进会话队列：兑换本身是网络请求，但它后面紧跟凭据写入，
// 分成两段入队会让别的写入插在「兑换完成」与「落盘」之间。
// [权衡] 队列被长请求占住可以接受：登录期间所有凭据写入必须串行。
// 归因保存在这里而不是外面：它属于同一次「会话变更」，必须与凭据写入同序。
    const completion = this.runSessionMutation(async () => {
      // polling 与 deep link 可能同时完成，也可能在等待期间开始新登录。
      // 只有仍指向同一 pending 对象的路径能落盘，防止迟到结果覆盖更新的登录选择。
      if (this.pendingState !== pending) {
        // 进入去重判定：pendingState 已空，可能是本 flow 刚被轮询抢先完成。
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // 回调入队时已通过有效性检查，不能因队列等待超过去重窗口而丢失归因。
          await preserveAttribution?.();
          // 命中窗口时补写归因：回调入队时已通过检查，不能因等待超窗而丢归因。
          return { kind: "duplicate" as const, provider: pending.provider };
        }
        // 既不是本 flow 也不是去重命中：返回 null 让调用方忽略这次回调。
        return null;
      }
      // 先保存归因：它属于同一次会话变更，必须在写凭据之前完成。
      await preserveAttribution?.();
      // 归因保存期间可能被取消，因此写盘前必须再复核一次。
      if (this.pendingState !== pending) return null;
      // 兑换在此处发生：可能耗时数秒，期间的取消只能靠返回值后的复核发现。
      const { tokenSet, profile } = await complete();
      // exchangeToken 期间用户可能取消或切换到新 flow；旧请求返回后必须再次校验，
      // 否则已取消的登录仍会把旧凭据写回本地。
      if (this.pendingState !== pending) {
      // 兑换返回后复核：已取消的登录不能把旧凭据写回本地（INV-03）。
        return null;
      }
      // 落盘走唯一写入点，并把「仍指向本 pending」作为取消判据传进去。
      await this.persistOAuthSession(
        pending.provider,
        tokenSet,
        profile,
        () => this.pendingState === pending,
      );
      // 只有仍然指向本 pending 才清理：新 flow 已接管时不能清掉它的状态。
      if (this.pendingState === pending) {
      // clearPendingState 会清定时器与 completionPromise，避免泄漏（INV-03）。
        this.clearPendingState();
      }
// 记录去重窗口（INV-07）：generation 用于排除「新一轮登录」的同 state 回调，
// expiresAt 用于让窗口自然失效，避免长期内存驻留。
// 只保留最近一次：更早的 flow 不可能再收到有意义的回调。
      this.recentlyCompletedPollingState = {
        // generation 用 flow 发起版本号：新一轮登录的同 state 回调不能被误判成重复。
        generation: this.oauthFlowStartGeneration,
        // expiresAt 让窗口自然失效，避免长期驻留内存。
        expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
        // provider 限定身份域，同 state 不同 provider 不算重复。
        provider: pending.provider,
        // state 与 generation 一起构成去重的唯一键。
        state: pending.state,
      };
      // 返回 session 而不是 duplicate：调用方据此刷新用户信息。
      return {
        // kind 是判别字段，调用方必须按它分流，不能做字符串比较。
        kind: "session" as const,
        // provider 回传本次登录的身份域，UI 据此选择展示名。
        provider: pending.provider,
        // userInfo 只含展示字段，token 与 rawProfile 不外泄。
        userInfo: toUserInfo(profile),
      };
    });
    // 共享首个兑换 Promise 会让失败传播给另一条已拿到凭据的路径。
    // 复用会话串行队列，每个候选独立执行；失败只在已排队候选均失败后向 UI 报告。
// [并发] 记录本次完成 Promise，供另一条候选路径在失败时回退查询。
// 不能把同一个 Promise 共享给两条路径：一条失败会把错误传播给另一条已拿到凭据的路径。
// 因此这里只保存 Promise 引用，实际完成仍由各路径独立执行。
// finally 中按身份清空，避免旧完成覆盖新一次的记录。
    pending.completionPromise = completion;
    try {
      // 正常路径直接等自己的 completion，异常统一在 catch 里处理。
      return await completion;
    } catch (error) {
      // 取当前记录的 Promise：并发路径可能已经把它换成新的。
      const fallback = pending.completionPromise;
      // 只有存在且不是自己时才回退等待，避免自等死锁。
      if (fallback && fallback !== completion) {
        try {
        // 等另一条路径的 Promise 完成：它可能已经成功写入了凭据。
          await fallback;
        } catch {
          // 两条路径均失败时保留各自的错误，不能让备用路径覆盖首条失败原因。
          throw error;
        }
        // 备用路径成功后必须按 COMPLETED_POLLING_STATE_GRACE_MS 去重窗口判断：命中说明本次登录已完成。
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // 命中窗口按 duplicate 返回，而不是把首条路径的失败抛给调用方。
          return { kind: "duplicate", provider: pending.provider };
        }
        // pending 已被替换成新 flow：本次结果作废，返回 null。
        if (this.pendingState !== pending) return null;
      }
      // 两条路径都失败时抛首条错误，保留原始 cause 便于定位。
      throw error;
    } finally {
      // 只清自己的记录：新 flow 可能已经覆盖 completionPromise。
      if (pending.completionPromise === completion) pending.completionPromise = undefined;
    }
  }

// 与 restoreCachedSessionState 相对：「需要远端确认」的恢复路径，会校验 token 有效性。
// 401/403 直接 logout（本地凭据已不可用），其它错误向上抛给调用方决定重试策略。
// [权衡] 两条恢复路径并存是刻意的：restoreCachedSessionState 让首屏快（只用缓存），restoreSession 才走远端。
// 校验成功会回写 profile 与 active provider，保证远端确认的结果进入本地事实。
// 这里不做 generation 校验：它是用户显式触发的强一致操作，不存在后台竞态语义。
  async restoreSession(): Promise<UserInfo | null> {
    // 远端确认路径也先看 active provider：没有身份域就无从校验。
    const activeProvider = await this.repo.getActiveProvider();
    // 空值直接返回 null，不抛错：未登录是正常状态。
    if (!activeProvider) {
      // 只记分支名，不记 token 与 state。
      log("restoreSession skipped: no active provider");
      // 与缓存恢复不同，这里返回 UserInfo | null，没有状态枚举。
      return null;
    }

    // 记录开始：后续 401/403 分支据此判断是本地无凭据还是服务端拒绝。
    log("restoreSession started:", activeProvider);

    // 与缓存恢复同一套可用性判断：查不到或已禁用都不能继续校验。
    const adapter = this.adapters.get(activeProvider);
    // 禁用适配器既没有 fetchUserInfo 也没有 normalizeError，拿它校验只会抛类型错误。
    if (!adapter || !adapter.meta.enabled) {
      // 记下被清掉的 provider，便于排查「改配置后自动登出」。
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      // 只清 active provider、不删 token：禁用可能是本版本临时行为，删了不可恢复。
      await this.repo.setActiveProvider(null);
      // 返回 null：需要远端确认的路径失败就按未登录处理，不抛错。
      return null;
    }

    // 先读命名空间内的 token；legacy 读取只作兜底，避免旧值覆盖新值。
    let tokenSet = await this.repo.loadActiveTokenSet();
// 旧版 BigModel 可能只保留 legacy token key。命中后回填命名空间，
// 避免每次启动都重复走 legacy 分支。
// 先读命名空间、没有才读 legacy：反序会让更旧的 legacy 值覆盖新值。
// 回填是普通写入，此处尚未进入后台任务，不需要 generation 复核。
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      // 记录走了兜底分支：这条日志是排查「每次启动都读 legacy」的入口。
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      // 用 credentialService.load 直读：legacy 键不在 repo 的命名空间映射里。
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));

      // 多 provider 改造后，旧版 BigModel 仍可能只保留 legacy token key。
      // 这里在 provider 兼容读取成功后回填命名空间 key，避免每次启动都重复走 legacy 分支。
      if (tokenSet) {
        // 命中才回填，未命中保持空，避免写出一份没有 token 的命名空间记录。
        log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
        // 回填 active token 视图，让后续读取不再走 legacy。
        await this.repo.saveActiveTokenSet(tokenSet);
        // 同时写命名空间 token：repo 的身份判断读的是这一份。
        await this.repo.saveTokenSet(activeProvider, tokenSet);
      }
    }

    // 没有 token 或适配器不支持拉取用户信息时无法完成远端确认，按本地凭据不可用处理。
    if (!tokenSet || !adapter.fetchUserInfo) {
      // 日志要区分两种缺失：token 为空，还是适配器没有 fetchUserInfo 能力。
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      // 直接走 logout：本地凭据不足以证明身份，留着只会让 UI 显示伪登录态。
      await this.logout();
      // 返回 null 而不是抛错：缺少能力属于配置问题。
      return null;
    }

    try {
      // 记录即将用远端 userinfo 校验：后续日志的分支起点。
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      // runWithAdapterError 统一包装适配器异常，让 catch 里的 normalizeError 拿到一致形状。
      const profile = await this.runWithAdapterError(adapter, () =>
        // 显式传 tokenSet：不用 repo 内部缓存，避免校验期间凭据被改写。
        adapter.fetchUserInfo!(tokenSet, {
        // providerId 决定请求头与 endpoint，必须与 active provider 一致。
          providerId: activeProvider,
        // state 传空：远端校验不需要防重放，OAuth 状态机只属于登录流程。
          state: "",
        // redirectUri 必须与授权时一致，否则部分 provider 会拒绝 userinfo 请求。
          redirectUri: adapter.redirectUri,
        // 注入时钟：测试要能控制过期判断，不能依赖真实时间。
          now: this.now,
        }),
      );

      // 校验通过才回写 profile：这一步让远端结果进入本地事实源。
      await this.repo.saveActiveUserProfile(withProviderProfileSchema(activeProvider, profile));
      // 重设 active provider：远端确认成功后身份域才算正式生效。
      await this.repo.setActiveProvider(activeProvider);
      // 记录 profile id 确认校验对象，不记 token。
      log("restoreSession validated:", activeProvider, profile.id);
      // 只返回展示字段，token 留在凭据层。
      return toUserInfo(profile);
    } catch (error) {
      // 归一化错误：适配器可能抛 AxiosError、Response 或字符串，这里必须统一成带 message 的形状，否则上层无法判断 401。
      const normalized = adapter.normalizeError(error);

      // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
      // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
// 远端明确未授权时立即清理本地登录态：只凭本地凭据判断会把过期 token 误判成已登录。
// 判定依赖 adapter 归一后的错误文案（见 isUnauthorizedError），不直接看 HTTP 状态。
// 只有启动恢复走这条短路：它的语义是「确认身份」，未授权即确认失败。
// 其它错误必须抛给调用方，否则一次网络抖动就会把用户登出。
      if (this.isUnauthorizedError(normalized)) {
        // 401/403 说明服务端明确拒绝，本地凭据已不可用，按退出流程清理。
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        // logout 会取消 flow 并自增版本号，避免在途任务把旧凭据写回。
        await this.logout();
        // 返回 null 而不是抛错：未授权是确定结论，不是异常。
        return null;
      }

      // 其它错误只记日志：网络抖动不能升级成登出，交由调用方决定重试。
      log("restoreSession validation error:", activeProvider, normalized.message);

      // 抛归一化后的错误而不是原始 error：调用方按 message 判断，原始对象形状不可控。
      throw normalized;
    }
  }

  // 对外入口只做转发：真正的流程在 startOAuthInternal，便于 handleCallback 复用同一条路径。
  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    // 不在这里校验 provider：合法性由 adapters.get 与适配器自身判定。
    return this.startOAuthInternal(provider);
  }

// ZAI/BigModel 的 Host 轮询流程：init 拿 authorize_url 与 flow_id，之后由 pollPendingOAuth 取结果。
// pollToken 是本地随机值，同时作为 init 与 poll 的 Bearer：只能用于关联本次 flow，
// 它不是用户凭据，也不能落盘。
// [并发] 每次发起都自增 oauthFlowStartGeneration：先发后返回的旧 init 不能覆盖新 flow（INV-03）。
// 协议校验失败一律抛错，不构造半成品 pendingState。
// 非 ZAI/BigModel 的 provider 直接回落到经典流程，不占用轮询通道。
  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    // 轮询通道只服务 ZAI 与 BigModel，其它 provider 走经典本地 state 流程。
    if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
// 轮询流程只服务 ZAI 与 BigModel，其它 provider 必须回落到经典本地 state 流程，不占用轮询通道。
      return this.startOAuthInternal(provider);
    }

    // getEnabledAdapter 内部已校验存在与启用，失败直接抛，不返回半成品。
    const adapter = this.getEnabledAdapter(provider);
    // 轮询必须走 Providers 注入的 apiClient：本类不自建连接，避免绕过统一鉴权与超时配置。
    if (!this.apiClient) {
      // 抛错而不是降级到经典流程：缺 apiClient 是装配错误，静默降级会让用户落到不可用的登录方式。
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
    // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
    const startGeneration = ++this.oauthFlowStartGeneration;
    // 记录本次发起的 provider，供 logout(provider) 判断是否取消正在进行的那一次。
    this.oauthFlowStartProvider = provider;
    // 清掉上一个 pending：新发起意味着旧 flow 作废，它的定时器必须一起清（INV-03）。
    this.clearPendingState();
// pollToken 只用于关联本次 flow 的 init 与 poll 请求，是本地随机值，绝不写入凭据存储。
    const pollToken = randomBytes(32).toString("hex");
    // init 地址由环境拼装：桌面与 CLI 指向不同网关，不能写死。
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    // init 请求以 pollToken 作为 Bearer：服务端据此把 flow 绑定到本次本地流程。
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      // 用 POST：init 会创建服务端 flow 与状态，必须是非幂等请求。
      method: "POST",
      // 只带两类头：Authorization 证明 flow 归属，Content-Type 声明 JSON。
      headers: {
        // pollToken 只在此处与 poll 请求出现，不能写日志、不能落盘。
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      // body 只传 provider：其余参数由服务端按 provider 规则决定。
      body: JSON.stringify({ provider }),
    });
    // init 返回后复核：期间用户可能又发起了一次登录，旧响应必须让位（INV-03）。
    if (this.oauthFlowStartGeneration !== startGeneration) {
      // 必须抛错而不是静默丢弃，否则调用方不知道本次登录已被新的请求取代。
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    // 抢到 flow 才清发起标记：之后 logout(provider) 不再把本次发起当作进行中。
    this.oauthFlowStartProvider = null;
    // data 可能是 null 或数组：下面逐字段用 readTrimmedString 与 Number.isFinite 收窄。
    const data = envelope.data;
    // 六个字段缺一不可：少任何一个都会让后续轮询或回调校验失去依据。
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      // 优先透出服务端 msg 便于定位；没有 msg 才用固定文案，不把原始响应写进错误。
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    // 断言非空：上面已校验 flow_id 非空，这里的 ! 由同一分支保证。
    const flowId = readTrimmedString(data.flow_id)!;
    // 同上，authorize_url 已在联合校验里确认非空。
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    // 服务端给的是秒级时间戳，转毫秒后才能与 this.now() 比较。
    const expiresAt = (data.expires_at as number) * 1_000;
    // 间隔同样按秒下发，必须转毫秒；后续退避只改 nextPollAt，不改这个基准值。
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    // 先声明再在 try 内赋值：catch 分支要区分 URL 解析失败与后续校验失败。
    let authorizeUrl: URL;
    try {
      // 用 URL 解析而不是字符串拼接：后续要读 state 并改写 redirect 参数。
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      // 解析失败与字段缺失共用一条错误文案：对调用方而言都是响应不可信。
      throw new Error("OAuth flow 初始化响应无效");
    }
    // BigModel 改写 redirect，Z.ai 用 redirect_uri，两个分支不能合并。
    if (provider === BIGMODEL_PROVIDER_ID) {
      // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
      // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 zcode://oauth/callback。
// BigModel 的 CLI callback 失败页会截断桌面 deep link 体验，因此把 redirect 改写成官网中转页，
// 再由官网透传到 zcode://oauth/callback；flow 本身仍由 Host 轮询。
// Z.ai 用不同的查询参数名（redirect_uri），两个分支不能合并。
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (provider === ZAI_PROVIDER_ID) {
      // Z.AI 后端 init 仍可能返回 provider-specific callback，导致回跳行为与 BigModel 不一致。
      // Desktop 统一改写为官网中转页，再由官网透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(this.env));
    }
// state 从服务端返回的 URL 中回读，而不是本地生成：回调校验值必须以服务端 flow 为准。
// 随后的联合校验覆盖：https 协议、state 非空、expires_at/poll_interval 有限、
// 剩余寿命必须为正、轮询间隔落在 [1s, 剩余寿命) 内。
// 任一不满足都说明服务端返回不可信，直接抛错而不是降级成一个短命 flow。
    const state = authorizeUrl.searchParams.get("state")?.trim();
    // 剩余寿命按服务端 expires_at 减当前时间计算，负数会在下面被拒绝。
    const remainingLifetimeMs = expiresAt - this.now();
    // 七项必须同时成立：协议、state、两个时间字段、寿命为正、间隔下限与上限。
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      // 任一项不满足都抛错，不降级成短命 flow：服务端返回不可信时继续只会留下坏状态。
      throw new Error("OAuth flow 初始化响应无效");
    }

// 取两者较小值：服务端寿命更短时以服务端为准，避免本地 flow 活得比服务端更久。
// [资源] 定时器只做「收口」，真正的过期判定在 pollPendingOAuth 里用 polling.expiresAt 复核。
// 定时器回调还要校验 flowId，防止旧定时器清掉新 flow。
    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    // 定时器只做兜底收口；真正的过期判定在 pollPendingOAuth 里按 expiresAt 复核。
    const timeout = setTimeout(() => {
      // 回调执行时 pendingState 可能已换成新 flow，必须先取当前值。
      const pending = this.pendingState;
      // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
      if (pending?.state === state && pending.polling?.flowId === flowId) {
        // 双条件匹配才清：state 防同 provider 的旧 flow，flowId 防同 state 的旧定时器。
        this.clearPendingState();
      }
    }, timeoutMs);
    // pendingState 一次性构造完成，避免中途赋值让并发轮询读到半成品。
    this.pendingState = {
      // state 来自服务端 URL，是回调校验值，本地不能生成。
      state,
      // 用适配器的 providerId 而不是入参：适配器可能规范化过 id。
      provider: adapter.providerId,
      timeout,
      // phase 初始为等归因或授权码：两种回调路径共用同一个 pending。
      phase: "awaiting-attribution-or-code",
      // polling 非空即标记这是轮询型 flow，超时与去重都按它判断。
      polling: {
        // expiresAt 用服务端时间：本地定时器只做兜底。
        expiresAt,
        flowId,
        // nextPollAt 设为当前时间，允许调用方立即发起第一次轮询。
        nextPollAt: this.now(),
        pollIntervalMs,
        pollToken,
        // pollUrl 在这里拼好并固化：轮询期间环境变化不应改变目标地址。
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    // 只记时长、间隔与 provider，日志不能出现 pollToken。
    serviceLog.info("OAuth polling flow started", {
      // expiresInMs 是收口定时器的时长，便于对照服务端寿命排查提前过期。
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    // 返回完整授权地址与 state：调用方只拿这两项，不暴露 pollToken 与 flowId。
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

// Host 轮询入口，调用方按 UI 节奏反复调用。语义：
// - 没有 polling flow 返回 null（不是错误）；
// - 已过期必须抛错并清理 pendingState；
// - 未到 nextPollAt 返回 null（背压，避免调用方打爆远端）；
// - 终态 4xx（408/429 除外）必须清理并抛错，不可继续轮询；
// - 其它错误（网络/5xx）保留 flow 等下一轮重试。
// status=pending 时同样返回 null，不构造任何结果对象。
  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    // 先取局部 apiClient：下面所有分支都用它，避免中途被注入点改写。
    const apiClient = this.apiClient;
    // 缺 apiClient 时轮询能力不可用，按「无进行中 flow」处理。
    if (!apiClient) {
      // 返回 null 而不是抛错：装配缺失不该让 UI 的轮询定时器反复报错。
      return null;
    }
    // 取一次引用：后续所有复核都用 === 比较这个对象，而不是比较 state 字符串。
    const pending = this.pendingState;
    // polling 为空表示当前不是轮询型 flow，按无 flow 处理。
    const polling = pending?.polling;
// 没有活动轮询 flow 时返回 null 而不是抛错，调用方可以按固定节奏反复调用。
    if (!pending || !polling) {
      // 没有 pending 或不是轮询型 flow：返回 null，调用方可以继续按节奏调用。
      return null;
    }
// 过期判定用服务端下发的绝对时间，不依赖本地定时器是否已触发；两者不一致时这里以 expiresAt 为准。
    if (this.now() >= polling.expiresAt) {
      // 先清 pending 再抛错：过期 flow 的定时器与 completionPromise 必须一起收口（INV-03）。
      this.clearPendingState();
      // 抛错而不是返回 null：过期是终态，调用方要停止轮询并提示重新登录。
      throw new Error("OAuth flow 已过期");
    }
// 未到下一次轮询时刻直接返回 null，这是背压而不是错误，调用方应稍后再来。
    if (this.now() < polling.nextPollAt) {
      // 背压：未到 nextPollAt 返回 null，避免调用方高频轮询打爆远端。
      return null;
    }
// 先推进下一次可轮询时刻再发请求：即使本次请求很慢或失败，
// 也不会在返回后立即被再次轮询而打爆远端。
// 间隔来自服务端下发的 pollIntervalMs，不在本地调整。
    polling.nextPollAt = this.now() + polling.pollIntervalMs;

// 请求前已推进 nextPollAt，因此本次无论成功失败，下一次都必须等到新的间隔之后。
    let envelope: OAuthFlowEnvelope;
    try {
      // 轮询请求只带 Bearer pollToken：服务端据此确认调用方拥有该 flow。
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        // 头里不再出现 flowId：它已在 URL 路径中，重复携带只会扩大日志泄露面。
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      // 请求返回时 flow 可能已被替换：不是同一个 pending 就不能按旧 flow 处理错误。
      if (this.pendingState !== pending) return null;
      // 只把 4xx（除 408/429）当终态，5xx 与网络错误必须留给下一轮重试。
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
// 408/429 是「可重试」的 4xx，必须排除在终态之外；
// 其余 4xx 说明 flow 已不可用（state 失效/flow 不存在），继续轮询只是空转。
// 终态分支仍走 runPendingSessionCompletion，保证清理语义与成功路径一致。
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
        // 终态错误也必须走同一完成入口：清理 pending、取消 flow、通知监听者只有这一条路径。
          return await this.runPendingSessionCompletion(pending, async () => {
          // 把原始 ApiError 抛给完成入口，由它统一归一化并清理。
            throw error;
          });
        } catch (terminalError) {
          // 完成入口已抛错，这里必须补一次清理：pending 仍是本 flow 才清，避免误清新 flow。
          if (this.pendingState === pending) this.clearPendingState();
          // 原样上抛终态错误，调用方据此停止 pollPendingOAuth 轮询。
          throw terminalError;
        }
      }
      // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
      // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
// 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
// 高频状态只记 debug，避免生产日志随轮询频率膨胀。
// 重试上限由 flow 的 expiresAt 决定，不额外计数。
      serviceLog.debug("OAuth polling request will retry", {
        // 只记 message，不记响应体：轮询响应可能带 token。
        error: error instanceof Error ? error.message : String(error),
        // 带上 provider 便于区分同一时刻的多身份域日志。
        provider: pending.provider,
      });
      // 保留 flow 等下一轮：单次失败不终止登录。
      return null;
    }
    // 成功返回后同样复核：期间用户可能已发起新登录或登出。
    if (this.pendingState !== pending) {
      // 结果作废：旧 flow 的成功响应不能写进新会话（INV-02）。
      return null;
    }
    // code=0 且 status=pending 表示服务端还没拿到授权码，按「无结果」返回。
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      // 返回 null 不推进 phase：下一次轮询继续用同一个 flow。
      return null;
    }
    try {
    // 状态不是 pending，交给唯一完成入口做兑换与落盘。
      const result = await this.runPendingSessionCompletion(pending, async () => {
// 轮询结果在这里转成 tokenSet 与 profile，任何必需字段缺失都抛错，由外层统一清理 pending。
        const pollData = envelope.data;
      // 先校验信封：code 非 0 或 data 不是对象都说明响应不可信。
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
        // 优先用服务端 msg 定位，缺失时才用固定文案。
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
// status 只有 ready 才能落盘：pending 已在上面提前返回，failed 与未知值都必须当作不可继续。
        const status = readTrimmedString(pollData.status);
      // failed 是服务端明确失败：继续轮询不会有结果。
        if (status === "failed") {
        // 抛错由外层统一清理 pending 并通知监听者。
          throw new Error("OAuth flow 授权失败");
        }
      // 除 ready 外的取值都按无效处理，避免未知状态被当成成功。
        if (status !== "ready") {
        // 与 failed 共用清理路径，但对调用方报「响应无效」。
          throw new Error("OAuth flow 查询响应无效");
        }

// 从这里开始只读取本次 flow 的载荷，另一侧 provider 的字段即使存在也不采用。
        const ready = pollData;
      // user 可能为 null 或数组：只有对象才读字段，否则按缺失处理。
        const user = isUnknownRecord(ready.user) ? ready.user : null;
      // zai 载荷：只有本 flow 的 provider 是 ZAI 时才采用。
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
      // bigmodel 载荷：同上，跨 provider 的字段一律不读。
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
// 按 provider 取各自的 access_token；BigModel 兼容 snake_case 与 camelCase 两种字段名。
// 另一侧的字段即使存在也不使用：混用会把某个 provider 的令牌写到另一个身份域。
// 三个必需值（zcode JWT、provider token、user_id）缺一个必须判响应无效，不能只补默认值。
        const providerAccessToken =
          pending.provider === ZAI_PROVIDER_ID
      // ZAI 只读 zai.access_token，不回退到另一个身份域。
            ? readTrimmedString(zai?.access_token)
      // BigModel 兼容两种命名，先 snake_case 再 camelCase，顺序不能反。
            : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
      // 业务 JWT 在顶层 token 字段，是 ZAI 登录态的核心。
        const zcodeJwtToken = readTrimmedString(ready.token);
      // user_id 是 profile 主键，缺失就无法隔离账号。
        const userId = readTrimmedString(user?.user_id);
      // 三个必需值缺一即判无效：少 JWT 无法鉴权，少 token 无法调用 provider。
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
        // 抛错由外层清理 pending，不留下半套身份。
          throw new Error("OAuth flow 查询响应无效");
        }
      // 显示名回退顺序 name、email、user_id，保证永远非空。
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
      // avatar 可选：缺失时不写该字段，而不是写空串。
        const avatarUrl = readTrimmedString(user?.avatar);
      // profile 形状必须与缓存 schema 一致，否则下次恢复校验失败。
        const profile: OAuthUserProfile = {
        // id 决定凭据键与账号隔离，不能换成 username。
          id: userId,
        // username 与 displayName 同值：这里没有更好的展示名来源。
          username,
        // displayName 单独列出，便于将来接更友好的名字而不改 id。
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
        // rawProfile 保留原始 user 载荷，供 provider 特有字段读取。
          rawProfile: user,
        };
      // 按 pending.provider 取适配器：不能用 active provider，它可能已被切换。
        const adapter = this.getAdapter(pending.provider);
      // refreshToken 只有 BigModel 下发，ZAI 分支为 undefined。
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
        // 兼容 refresh_token 与 refreshToken 两种写法。
            ? readTrimmedString(bigmodel?.refresh_token) ||
        // 两个字段都缺失时保持 undefined，由落盘层决定不写该键。
              readTrimmedString(bigmodel?.refreshToken)
            // ZAI 分支不写 refreshToken：它不下发，写成空串会被下游当成可刷新。
            : undefined;
// 适配器可在落盘前再加工 token（例如换取更长期凭据），因此必须 await 后再写入。
// 没有该能力的适配器直接用轮询结果；两条路径产出的形状必须一致。
// refreshToken 只有 BigModel 提供，缺失时不写该字段而不是写 undefined。
      // 适配器可换取更长期凭据：有该能力时必须 await，不能直接落轮询结果。
        const tokenSet = adapter.normalizePolledTokenSet
        // 传入三个值，refreshToken 只在存在时展开，避免写入 undefined。
          ? await adapter.normalizePolledTokenSet({
              // provider 的 access_token 来自当前身份域的载荷。
              accessToken: providerAccessToken,
          // 业务 JWT 一并交给适配器，保证换出的 tokenSet 仍含它。
              zcodeJwtToken,
          // 条件展开：写成 undefined 会被下游当成显式清除。
              ...(refreshToken ? { refreshToken } : {}),
            })
        // 没有该能力的适配器直接构造，形状必须与上面一致。
          : {
              // 无适配器加工时直接透传 tokenSet 字段，与上面分支一一对应。
              accessToken: providerAccessToken,
          // 同上，业务 JWT 必须保留。
              zcodeJwtToken,
          // 条件展开 avatarUrl，理由同适配器分支：空值会让 UI 渲染占位头像。
              ...(refreshToken ? { refreshToken } : {}),
            };
        // 返回能同时喂给 persistOAuthSession 的 tokenSet 与 profile。
        return { tokenSet, profile };
      });
      // 只有真正落盘成为 session 才记 info：duplicate 与 attribution 走各自的日志。
      if (result?.kind === "session") {
        // 只在完成时记一条 serviceLog，轮询期间不重复刷屏。
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      // 原样返回完成结果：可能是 session 也可能是 duplicate。
      return result;
    } catch (error) {
      // 抛出前收口：pending 仍是本 flow 才清，避免误清新 flow。
      if (this.pendingState === pending) this.clearPendingState();
      // 原样上抛，调用方必须区分过期、终态 4xx 与响应无效。
      throw error;
    }
  }

// 非轮询流程：本地生成 state 并只依赖浏览器回调。
// 取消旧 flow 放进 sessionMutation 而不是直接改字段：这样「取消旧 flow」与「旧 flow 落盘」
// 不会交错，避免后回调抢占前回调并触发 state 错配。
// [权衡] 这里多一次 runSessionMutation 往返，换取与凭据写入同一串行域。
  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    // 先取启用中的适配器：不存在或已禁用直接抛错，不构造 state。
    const adapter = this.getEnabledAdapter(provider);

    // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
    // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
    await this.runSessionMutation(async () => {
// 在凭据队列内取消旧 flow，与旧 flow 落盘同域，避免取消动作插进旧回调的写入中间。
// 先推进发起版本号再清槽位，让在途 init 响应返回后立刻发现自己已经过期。
      this.oauthFlowStartGeneration += 1;
      // 清发起标记：旧 flow 已被取消，logout(provider) 不应再把它当作进行中。
      this.oauthFlowStartProvider = null;
      // 清槽位在队列内：与旧 flow 的落盘串行，避免取消插进写入中间。
      this.clearPendingState();
    });

// state 本地随机生成：非轮询流程没有服务端 flow 可回读，只能由 Host 自己掌握校验值。
    const state = randomBytes(32).toString("hex");
    // 定时器只做兜底：真正的超时判定靠各入口对 pending 的复核。
    const timeout = setTimeout(() => {
// 超时兜底只清仍是自己的槽位；期间若已开始新一轮登录，旧定时器不能把新 flow 清掉。
      if (this.pendingState?.state === state) {
        // 直接置 null 而不是 clearPendingState：这里已在定时器回调内，避免重入取消。
        this.pendingState = null;
      }
    }, OAUTH_TIMEOUT_MS);

    // pendingState 一次性构造，避免并发回调读到半成品。
    this.pendingState = {
      // 本地生成的 state 是唯一的回调校验值，非轮询流程没有服务端 flow。
      state,
      // 用适配器的 providerId，它可能被规范化过。
      provider: adapter.providerId,
      timeout,
      // 初始 phase 允许「先归因」或「直接带码」两种回调。
      phase: "awaiting-attribution-or-code",
    };

// 授权地址由适配器生成，state 与 redirectUri 必须原样带入，服务端才能把回调对回本次 flow。
    const authorizeUrl = adapter.buildAuthorizeUrl({
    // 授权地址由适配器拼装：不同 provider 的参数名与 scope 不同。
      providerId: adapter.providerId,
      state,
      // state 原样带入，服务端要把它回传到回调 URL。
      redirectUri: adapter.redirectUri,
      // redirectUri 必须与回调注册值完全一致，否则 provider 会拒绝。
      now: this.now,
    });

    // 返回给调用方的是授权地址与 state，不含任何 token。
    return {
      // provider 用适配器值，与 pendingState 中记录的一致。
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

// 浏览器回调入口，三种形态：
// 1) 无 pendingState 但命中去重窗口时必须返回 duplicate（只补记归因，不重复登录，INV-07）；
// 2) 纯归因回调（无授权码）→ 只保存归因并推进 phase，不清 state；
// 3) 带授权码时必须走完整兑换与落盘。
// state 校验失败一律抛错，不能静默丢弃：丢弃会让 UI 永远等不到结果。
// 回调也会触发轮询 flow 的过期检查，避免用已失效的授权码去兑换。
  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
// 回调有三条分支：去重命中、仅归因、完整兑换；三条都会先校验 state 与 flow 版本。
    const pending = this.pendingState;
    // 没有 pending 时只有一种合法情形：本次回调属于刚刚轮询完成的登录。
    if (!pending) {
      // 取回调里的 state 作为去重键；缺失则无法命中，直接落到下面的抛错。
      const callbackState = new URL(url).searchParams.get("state")?.trim();
// 去重判定必须同时满足 state、generation、未过期三项（INV-07）。
// 只比 state 会把「新一轮登录恰好同 state」的回调误判成 duplicate；
// 不比 generation 则无法区分不同轮次。
// 命中后补记归因也必须进队列并再次复核，否则会覆盖更新的状态。
      const completed = this.recentlyCompletedPollingState;
      // 四项必须同时成立才算重复：state、generation、未过期、没有新 flow。
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        // 解析归因：轮询成功时浏览器仍可能带着 utm 等参数回来，不能丢。
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        // 归因写入也必须进 runSessionMutation 队列：与凭据写入同域，避免覆盖更新后的状态。
        await this.runSessionMutation(async () => {
// 入队后再次复核：等待期间可能开始新登录，completed 引用与 generation 都必须仍指向同一轮。
          // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            // 复核通过才写：期间出现新 flow 时，这次迟到回调的归因已不适用。
            await this.repo.saveLoginAttribution(attribution);
          }
        });
        // 返回 duplicate 而不是 null：UI 据此知道登录已完成，只是回调来晚了。
        return { kind: "duplicate", provider: completed.provider };
      }
      // 既无 pending 又未命中去重：state 已失效（超时、登出或伪造）。
      throw new Error("OAuth state 不匹配或已过期");
    }

// 有活动 flow 时 state 必须严格相等，缺失或不符一律抛错，不能让 UI 无限等待结果。
    const parsedUrl = new URL(url);
    // 有活动 flow 时 state 必须严格相等，缺失与不符同样处理。
    const state = parsedUrl.searchParams.get("state");
    // 用 pending.state 比较，避免解析出的参数与内存值出现大小写或编码差异。
    if (!state || state !== pending.state) {
      // 抛错而不是静默丢弃：丢弃会让 UI 永远等不到结果。
      throw new Error("OAuth state 不匹配或已过期");
    }
// 轮询 flow 的回调也要查服务端过期时间，避免拿已失效的授权码去兑换。
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      // 先收口再抛错：过期 flow 的定时器必须清掉（INV-03）。
      this.clearPendingState();
      // 过期是终态，调用方必须停止等待并提示重新登录。
      throw new Error("OAuth flow 已过期");
    }

// 归因只在回调里解析一次，后续保存与去重都必须复用同一个结果，避免同一 URL 解析出两种归因。
    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
// 纯归因回调是最终授权码之前的中转步骤：不能清掉仍需继续登录的 state。
// 但若不显式推进 phase，同一 state 可以重复写入归因并隐式复用 pending 生命周期。
// 因此这里只推进 phase、保存归因，然后返回 attribution 结果。
// 保存失败时把 phase 回退（仅当 pendingState 仍是自己），保证重试仍被允许。
// 已推进过 phase 的同一回调按「已处理」抛错，避免重复写归因。
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      // 同一 state 的纯归因回调只能处理一次，重复到达说明客户端重放。
      if (pending.phase === "awaiting-code-after-attribution") {
        // 抛错而不是返回 attribution：重复写归因会覆盖首次记录。
        throw new Error("OAuth 归因回调已处理");
      }

      // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
      // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
      pending.phase = "awaiting-code-after-attribution";
      try {
      // 先推进 phase 再写盘：写失败时下面会回退，保持状态一致。
        await this.repo.saveLoginAttribution(attribution);
      } catch (error) {
      // 只有 pending 仍是自己才回退 phase：期间换了新 flow 就不能动它。
        if (this.pendingState === pending) {
        // 回退到初始 phase，允许同一 state 重试保存。
          pending.phase = "awaiting-attribution-or-code";
        }
        // 原样上抛：保存失败要暴露给调用方，不能吞成 attribution 成功。
        throw error;
      }
      // 返回 attribution 而不是 session：登录还没拿到授权码。
      return {
        // kind 让调用方区分「中转回调」与「已完成」。
        kind: "attribution",
        // provider 回传身份域，UI 据此更新展示。
        provider: pending.provider,
        attribution,
      };
    }

    // 适配器按 pending 记录的 provider 取，而不是回调参数：回调是外部输入，provider 必须来自发起时的槽位。
    const adapter = this.getAdapter(pending.provider);
    // fetchUserInfo 缺失或失败时的兜底身份；id 用固定常量 "unknown"，不会与真实 provider 的用户 id 碰撞。
    const fallbackProfile: OAuthUserProfile = {
      // 固定 id：下游靠它区分「只有 token」与「有真实 profile」，不能改成空串——凭据键要求非空。
      id: "unknown",
      // username 只用于展示兜底，不参与凭据键；与 id 分开保留，否则 UI 两处都会显示 unknown。
      username: "user",
      // displayName 是 UI 主展示字段，留空会让已登录状态看起来像未登录，所以给常量而不是空串。
      displayName: "User",
    };

    // 完成动作交给 runPendingSessionCompletion：它在队列内复核 pending 仍是当前 flow（INV-03）。
    return this.runPendingSessionCompletion(
      pending,
      async () => {
// 授权码兑换回调：只有在 runPendingSessionCompletion 复核 pending 仍有效后才会真正执行。
// parseCallbackParams 只解析不校验 state，state 比对已在 handleCallback 入口完成。
        const callback = adapter.parseCallbackParams(url);
        // context 是适配器交换所需的全部上下文，字段只能来自已校验的 pending 与适配器配置，不能接受回调注入。
        const context = {
          // 用适配器自报的 providerId：适配器内部按它选择端点与签名，与 pending.provider 理论上一致。
          providerId: adapter.providerId,
          // 传入回调携带的 state：适配器可能把它写进请求体做二次校验，本函数的 state 比对已在入口完成。
          state: callback.state,
          // 必须与发起授权时的 redirect_uri 完全一致，否则 provider 会以 redirect_uri_mismatch 拒绝交换。
          redirectUri: adapter.redirectUri,
          // 注入时钟：exchangeToken 内部要判断过期，测试需要能推进时间，不能直接调 Date.now。
          now: this.now,
        };
// exchangeToken 经适配器归一错误，网络失败与 4xx 都以统一形状抛出，交由上层决定是否重试。
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          // exchangeToken 才真正把授权码换成 token；失败经 runWithAdapterError 归一，调用方只看到统一错误形状。
          adapter.exchangeToken(callback, context),
        );
        // 先赋兜底身份再尝试覆盖：拿不到用户信息不应让整次登录失败，token 此时已经换到了。
        let profile = fallbackProfile;
        // fetchUserInfo 是可选能力，浏览器型 provider 可能没有实现，因此按可选调用而不是强制要求。
        if (adapter.fetchUserInfo) {
          try {
            // 成功才覆盖 profile；失败落到下面的 catch 继续用兜底身份，不能因为缺 profile 回滚已换到的 token。
            profile = await this.runWithAdapterError(adapter, () =>
              // 非空断言与外层 if 成对：进入此分支时 fetchUserInfo 已确认存在，去掉断言 TS 会按可选签名报错。
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // 获取用户信息失败不阻塞登录
          }
        }
        // 返回交换结果给 runPendingSessionCompletion：写盘与清理互斥 provider 都由它统一完成（INV-04）。
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

// token 刷新：单次交换由调用方持有（本方法不缓存、不合并并发调用）。
// 本方法只保证三件事：
// 1) 只能刷新当前 active provider（否则会把别的身份域写脏）；
// 2) 必须有 refresh_token，否则要求重新登录而不是发无效请求；
// 3) 写回在会话队列内做 generation + active provider + access_token 三重校验，
//    否则刷新结果会覆盖期间发生的新登录（INV-01、INV-02）。
// 交换失败由 adapter 归一后向上抛，不在这里重试。
// 成功也不 fire 事件：身份未变，token 轮换不需要 UI 刷新。
  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    // 捕获开始时的会话版本：交换在队列外进行，写回时用它与当前值比对，判断期间是否发生了登录/登出（INV-02）。
    const generation = this.oauthSessionGeneration;
    // 显式传入的 provider 优先，未指定时回落到持久化的 active provider；返回值可能为 null。
    const targetProvider = await this.resolveProvider(provider);
    // null 表示从未登录或已登出：没有可刷新的身份域，必须在这里失败，不能构造空请求。
    if (!targetProvider) {
      // 文案面向用户：提示先登录，不暴露内部 provider 枚举与端点。
      throw new Error("当前没有可用的登录 provider");
    }

    // 用 enabled 版本取适配器：刷新是用户主动行为，未启用的 provider 必须此刻失败，不能等到发网络请求。
    const adapter = this.getEnabledAdapter(targetProvider);
    // refreshToken 是可选能力；未实现时不能调用，错误要指向「重新登录」而不是内部缺失。
    if (!adapter.refreshToken) {
      // 消息里带 displayName：用户能看出是哪个 provider 不支持刷新，而不是笼统的失败。
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    // 复核持久化的 active provider：resolveProvider 的显式传参分支还没与磁盘核对过。
    const activeProvider = await this.repo.getActiveProvider();
    // 只允许刷新当前登录的 provider；刷新别的身份域会把它的 token 写进当前会话，造成跨域污染。
    if (targetProvider !== activeProvider) {
      // 这是用户可纠正的状态（中途换过账号），必须要求重新登录，不能静默忽略本次刷新。
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    // 读已保存的 token：refresh_token 必须来自本地凭据，不能由调用方传入。
    const tokenSet = await this.repo.loadActiveTokenSet();
    // 缺 refresh_token 说明是旧格式或一次性登录，发请求只会得到 400，因此提前要求重新登录。
    if (!tokenSet?.refreshToken) {
      // 与「provider 不匹配」区分：这条是凭据内容缺失，不是身份域选错。
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    // [并发] 交换在队列之外执行：网络耗时较长，占住队列会阻塞登录/登出。
    // 代价是交换期间状态可能变化，因此写回时必须重新校验。
    const refreshed = await this.runWithAdapterError(adapter, () =>
      // 非空断言与外层检查成对；实际交换在会话队列之外执行，避免网络耗时阻塞登录与登出。
      adapter.refreshToken!(tokenSet, {
        // 传已校验的 targetProvider（与 activeProvider 相等），适配器按它选择端点。
        providerId: targetProvider,
        // 刷新不属于任何 flow，state 传空串；适配器不得把它当作回调校验值。
        state: "",
        // 部分 provider 刷新时仍校验 redirect_uri，必须与发起授权时保持一致。
        redirectUri: adapter.redirectUri,
        // 用于判断响应里的 expires_at 是否已过期；用注入时钟保证测试能推进时间。
        now: this.now,
      }),
    );

    // 写回必须走会话队列：绕过队列会插进 401 核对/清理窗口，或在 logout 之后复活凭据（INV-01）。
    await this.runSessionMutation(async () => {
      // 写回前必须做三重校验：版本未变、仍是同一 active provider、本地 access_token 仍是发起交换时那个。
      // 任一不成立就丢弃结果（return），不抛错——刷新被更新的登录取代是正常情况。
      // [权衡] 不比对 refresh_token：部分 provider 交换后会让旧值失效，比对反而会误判。
      // 比较 access_token 用原始值而不是 trim 后值：凭据按字节比较才安全。
      // 刷新写回若绕过会话队列，会插入 401 的核对/清理窗口，或在退出后复活凭据。
      if (
        this.oauthSessionGeneration !== generation ||
        (await this.repo.getActiveProvider()) !== targetProvider ||
        (await this.credentialService.load(`oauth:${targetProvider}:access_token`)) !==
          tokenSet.accessToken
      )
        // 丢弃结果不写盘：本地 access_token 保持更晚那次登录写入的值。
        return;
      // 校验通过才能落盘：版本、active provider、本地 access_token 必须都与发起交换时一致。
      await this.repo.saveActiveTokenSet(refreshed);
    });
  }

// 只供 Host 内部使用：由带凭据的请求方在收到 401 后提交，用于判断「是否该退出当前账号」。
// 放进接口契约会让远端也能触发登出，超出必要权限。
// 与 logout(provider) 的区别：这里要复核「失败凭据是否仍是当前凭据」，避免并发登录被误登出。
  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
// 401 提交入口：只有失败凭据仍是当前凭据时才登出，避免并发登录被一条迟到的 401 误杀。
// 凭据比对在会话队列内执行，与登录写入互斥，读到的才是同一时刻的认证事实。
// 不把它加入 IOAuthService：否则远端也能借 401 触发本地登出，权限被放大。
    return this.logoutActiveSession(() =>
      // 凭据复核由队列内执行：只有失败凭据仍是当前凭据时才登出，避免迟到的 401 误杀并发登录。
      isCurrentOAuthCredentialRequest({
        // 原始请求 URL 与 headers 一并传入：凭据比对要按真实请求解析出 Bearer 值，不能只看当前存储。
        input,
        headers,
        // 注入凭据服务而不是自己读文件，保证与登录写入共用同一把文件锁。
        credentialService: this.credentialService,
        // 注入环境快照：判断凭据来源（桌面/CLI）依赖环境变量，运行期不重读 process.env。
        env: this.env,
      }),
    );
  }

// 登出的唯一实现（手动退出与 401 触发共用）。步骤：
// 1) 队列内复核 isCurrent（401 场景要先确认凭据仍是导致失败的那份）；
// 2) 必须先取账号身份，再清凭据；
// 3) 自增 generation 并 fire signed-out；
// 4) 队列外取消 flow、清理派生 provider。
// 返回 false 表示 isCurrent 不成立，什么都没做。
  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    // 复核与清理放进同一个队列任务：两步之间若让出队列，可能插进新的登录写入。
    const result = await this.runSessionMutation(async () => {
      // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
      if (isCurrent && !(await isCurrent())) return null;
      // 清理前先确认当前身份域；null 表示已经登出，此时既不需要取消 flow 也不需要派生清理。
      const activeProvider = await this.repo.getActiveProvider();
      // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
      // null 是合法身份（provider 存在但 profile 缺失），不能用 falsy 判断跳过清理。
      const accountIdentity = activeProvider
        // 身份必须在 clearActiveSession 之前读：清理后再读 profile 只能拿到 null，派生 provider 无法按账号清理。
        ? ((await this.repo.loadUserProfile(activeProvider))?.id ?? null)
        // 没有 active provider 时身份固定为 null（未知），与「有 provider 但无 profile」共用同一语义。
        : null;
      // 先推进版本号再清凭据：在途的后台迁移与刷新写回会立即失效，不能等清理完成才失效（INV-02）。
      this.oauthSessionGeneration += 1;
      // 清凭据是登出的认证事实；派生 provider 清理在这之后做，失败也不能回滚这一步（INV-06）。
      await this.repo.clearActiveSession();
      // 登出已生效：后续 provider/设置清理即使失败，也必须先撤销已认证的远控连接。
      this.sessionChanges.fire("signed-out");
      // 把清理前的快照带出队列：队列外只能用它做派生清理，重新读已经是空会话。
      return { activeProvider, accountIdentity };
    });
    // null 表示 isCurrent 复核不成立、什么都没做；返回 false 让 401 调用方知道凭据未被清理。
    if (!result) return false;
    // 只有存在 active provider 才需要取消 flow 与通知派生清理；空会话登出不能触发这些副作用。
    if (result.activeProvider) {
      // 取消该 provider 的活动 flow：登出后继续轮询会把凭据写回已清空的会话。
      await this.cancelPending(result.activeProvider);
      try {
        // 派生清理失败按场景处理：401 路径必须上抛，手动退出只记日志。
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        // 401 路径必须上抛：调用方依赖这个错误维持原有超时/过期提示，不能吞成登出成功。
        if (!isCurrent) throw error;
        // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    // 认证事实已清理且派生清理未抛错（或已按场景吞掉），返回 true 表示登出确实发生。
    return true;
  }

// 带 provider 的登出只对 active provider 生效：ZAI/BigModel 的 Unlink 已收敛为 App logout，
// 旧 unlink 路径不能误删非当前 provider 的 token。
// [权衡] 非 active 时不报错也不做事：幂等语义对调用方更友好。
// 全程不走 logoutActiveSession：那条路径会复核 401 凭据，手动退出不需要。
  async logout(provider?: OAuthProviderId): Promise<void> {
    // 不指定 provider 即 App 级登出：走带 401 复核能力的统一入口，入参缺省时不传 isCurrent。
    if (!provider) {
      // 手动退出不传 isCurrent：不需要复核凭据来源，只按当前 active provider 登出。
      await this.logoutActiveSession();
      // 直接返回，不进入下面的分支：下面的语义是「只登出指定 provider」，要求 provider 非空。
      return;
    }

    // 指定 provider 的登出也在队列内做「读身份 + 清凭据」，否则并发登录会读到半清理状态。
    const loggedOutIdentity = await this.runSessionMutation(async () => {
// 读持久化的 active provider：与入参 provider 比对，决定本次登出是否生效。
      const activeProvider = await this.repo.getActiveProvider();
      // 非当前 provider 直接跳过：旧 unlink 调用不能误删别的身份域 token，这是幂等语义。
      if (provider !== activeProvider) {
        // undefined 表示没有执行登出，与「登出了但身份未知」的 null 区分，外层必须据此决定是否通知派生清理。
        return undefined;
      }
      // 必须在 clearActiveSession 之前取身份：清理后 profile 已删，派生 provider 无法按账号精确清理。
      const accountIdentity = (await this.repo.loadUserProfile(provider))?.id ?? null;
      // 自增 oauthSessionGeneration 使在途迁移与刷新写回失效；只推进一次，多次登出不必重复推远。
      this.oauthSessionGeneration += 1;
      // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
      // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
      await this.repo.clearActiveSession();
      // fire 在队列内同步执行：订阅方看到的是「认证事实已撤销」，不是派生清理已完成（INV-06）。
      this.sessionChanges.fire("signed-out");
      // 身份带出队列供派生清理；null 合法（provider 存在但无 profile），不能用 falsy 判断跳过。
      return accountIdentity;
    });
    // 只有真的登出了才通知派生清理；undefined 表示 provider 不匹配，此时通知会误清别的身份域。
    if (loggedOutIdentity !== undefined) {
      // 单 provider 派生清理：失败会向上抛，手动退出路径需要让调用方知道清理未完成。
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    // 无论是否真的登出都要取消该 provider 的 flow：用户点了退出，等待中的轮询不能继续。
    await this.cancelPending(provider);
  }

  // 全量登出的范围取自 adapters 的注册键：未注册的 provider 不会进入清理列表。
  async logoutAll(): Promise<void> {
// 全量登出一次性清掉所有 provider 身份，而不是逐个调用 logout，避免中途失败留下部分登录态。
// 身份快照必须在 clearAll 之前取：清理之后再读 profile 只能拿到 null，派生 provider 就无法精确清理。
// 整个批量清理只自增一次会话版本号，后台任务据此统一失效。
    const providers = [...this.adapters.keys()];
    // 读身份与 clearAll 必须在同一队列任务内原子完成，否则并发登录会被中途清掉。
    const accountIdentities = await this.runSessionMutation(async () => {
// 先取快照再清理：identities 的插入顺序与 adapters 一致，通知时按同一顺序可复现。
      const identities = new Map<OAuthProviderId, string | null>();
      // 逐 provider 读身份：clearAll 之后 profile 全部消失，必须提前快照才能按账号清理派生 provider。
      for (const provider of providers) {
        // 值为 null 表示该 provider 没有缓存 profile；Map 保留键，调用方据此区分「没有身份」与「未处理」。
        identities.set(provider, (await this.repo.loadUserProfile(provider))?.id ?? null);
      }
      // 整个批量清理只自增一次 oauthSessionGeneration：后台任务只需一次失效信号，多次自增没有额外语义。
      this.oauthSessionGeneration += 1;
      // 只清已知 provider 的命名空间；clearAll 由 repo 保证幂等，不触碰共享 JWT 以外的键。
      await this.repo.clearAll(providers);
      // 一次事件覆盖全部 provider：UI 只需要知道「已登出」，不需要逐 provider 的中间态。
      this.sessionChanges.fire("signed-out");
      // 身份快照带出队列供并发通知使用；此时凭据已清，重新读只会得到 null。
      return identities;
    });
    // 不传 provider：全量登出要取消所有 provider 的活动 flow。
    await this.cancelPending();
    // 并发通知各 provider；使用清理前的身份快照，保证派生清理能按账号精确执行。
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

// 取消活动 flow 时必须同时清 pendingState（含定时器）并推进发起版本号，
// 让在途 init/回调结果自动失效。
// 无 pendingState 时仍要自增版本号并清 provider 标记，否则旧 init 返回后会被当成有效。
// provider 不匹配时直接返回：避免登出 A 时误取消 B 正在进行的登录。
  async cancelPending(provider?: OAuthProviderId): Promise<void> {
// 无 pendingState 时只剩发起版本号要处理，槽位与定时器都不存在。
    if (!this.pendingState) {
      // 发起侧 provider 与本次请求不匹配时跳过：登出 A 不能取消 B 正在准备的登录。
      if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
        // 直接返回且不推进版本号：这次调用与 B 的发起无关，推进会误伤 B 的 flow。
        return;
      // 没有活动 flow 也要推进发起版本号：旧 init 响应返回时虽然还没建槽，仍必须被识别为过期。
      this.oauthFlowStartGeneration += 1;
      // 清发起 provider 标记：否则下一次 init 会看到残留 provider，误判为「已有 flow」。
      this.oauthFlowStartProvider = null;
      // 空槽分支到此结束：没有 pendingState 就没有定时器需要清。
      return;
    }
    // 有活动 flow 但 provider 不匹配时不动它：取消 B 的 flow 不该是 A 登出的副作用。
    if (provider && this.pendingState.provider !== provider) return;
    // 推进版本号先于清槽：清槽与新发起交错时，旧 flow 的结果会因版本不符被丢弃。
    this.oauthFlowStartGeneration += 1;
    // 清发起标记与推进版本号成对出现，保证状态机只有一个「当前发起」。
    this.oauthFlowStartProvider = null;
    // 清槽（含 clearTimeout）由独立方法做：多条退出路径共用，必须保持幂等。
    this.clearPendingState();
  }

// [资源] 清定时器 + 清槽位。先判断再清，避免 clearTimeout(undefined)。
// 只清 pendingState，不动 oauthFlowStartGeneration：
// 版本号由 cancelPending 与新一轮发起推进，混在一起会让「清理」意外使新 flow 失效。
// 幂等：重复调用无副作用，这是多个退出路径都调用它的前提。
  private clearPendingState(): void {
// 无槽位直接返回：此时没有 timeout 可清，重复调用是安全的。
    if (!this.pendingState) {
      // 已经清过（或从未有）flow：直接返回，避免对 null 调 clearTimeout。
      return;
    }

    // 定时器必须显式清除：只置空槽位会让 5 分钟回调继续存活，并在回调里读到 null。
    clearTimeout(this.pendingState.timeout);
    // 置空放在清定时器之后：反序会让 clearTimeout 读到 null 而抛错。
    this.pendingState = null;
  }

// 单个 provider 的派生清理是 best-effort：失败只记日志，不阻断主登出流程。
// 派生凭据不是认证事实源，删不掉也不应让用户无法退出。
// 传 null 表示身份未知，此时按平台清理而不是跳过。
  private async notifyProviderLogout(
    // 第一个参数是身份域：派生清理按 provider 区分命名空间，不能只按账号。
    provider: OAuthProviderId,
    // null 表示身份未知，派生方按平台粒度清理；undefined 表示调用方没有提供快照。
    accountIdentity?: string | null,
  ): Promise<void> {
// 派生清理是尽力而为：没有注入回调就直接跳过，失败由调用方按场景决定吞掉还是上抛。
    if (!this.onProviderLogout) {
      // 没有注入 onProviderLogout 就跳过：Host 之外的宿主没有派生 provider 概念。
      return;
    }

    // 原样透传身份（含 null）而不是兜底成空串：派生方需要区分「身份未知」与「空身份」。
    await this.onProviderLogout(provider, accountIdentity);
  }

// 并发通知各 provider：彼此独立，串行只会放大总耗时，单个失败由调用方决定是否吞掉。
// 通知只做派生清理，不改认证事实源；因此失败不能回滚已经完成的登出（INV-06）。
// 传入的身份快照来自清理前，调用方必须保证它在 fire 之前捕获。
  private async notifyProvidersLogout(
    // 只读数组：本函数不修改集合，调用方传入的 provider 列表即最终清理范围。
    providers: readonly OAuthProviderId[],
    // 默认空 Map 供不带快照的调用点使用；缺失的 provider 会以 undefined 传给单 provider 实现。
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
// 并发触发各 provider 的派生清理：它们互不依赖，串行只会把登出总耗时线性放大。
// 空的身份 Map 用于 logoutAll 之外的场景，缺失的 provider 会以 undefined 传给单 provider 实现。
    await Promise.all(
      providers.map((provider) =>
        // 逐 provider 取快照值；缺失时是 undefined，与显式 null 的「身份未知」语义不同。
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

// 适配器按 providerId 查表；未知 provider 直接抛错，不返回 undefined 让调用点各自判空。
// enabled 过滤只发生在 getEnabledAdapter：内部路径（如恢复已认证 provider）需要允许未启用的适配器。
  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
// 未知 provider 直接抛错而不是返回 undefined，否则每个调用点都要重复判空，漏判会在后面变成空指针。
// 这里不做 enabled 过滤：恢复已登录会话需要拿到配置里暂时停用的适配器。
    const adapter = this.adapters.get(provider);
    // 未注册的 provider 直接抛错：调用点不必重复判空，漏判会在后面变成难以定位的空指针。
    if (!adapter) {
      // 错误里带 provider 值：配置写错时能直接定位是哪个 id，而不是笼统的 not found。
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    // 返回已注册适配器；这里不做 enabled 过滤，恢复已登录会话需要允许暂时停用的适配器。
    return adapter;
  }

  // 与 getAdapter 的差别只有 enabled 检查：用户主动发起的登录/刷新必须拒绝停用的 provider。
  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
// 只在用户主动发起登录或刷新时使用：未启用的 provider 必须立刻报错，而不是走到网络请求才失败。
// 复用 getAdapter 的未知 provider 报错，保持两种失败的错误形状一致。
    const adapter = this.getAdapter(provider);
    // enabled 取自适配器元数据而不是启动时的配置拷贝，保证运行时开关立即生效。
    if (!adapter.meta.enabled) {
      // 在发网络请求之前失败：停用的 provider 走到交换阶段才报错，用户会看到误导性的网络错误。
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    // 复用 getAdapter 的未知 provider 检查，两种失败的错误形状保持一致。
    return adapter;
  }

  // 解析目标身份域：显式传参优先，未指定时回落到持久化的 active provider，可能返回 null。
  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
// 显式 provider 优先，未指定时才回落到 active provider，调用方用 null 表示当前没有登录。
// 回落读取 repo 的持久化事实而不是内存字段，保证判定与磁盘一致。
    if (provider) {
      // 显式传入的 provider 直接返回，不再与 active provider 比对；一致性由调用方负责校验。
      return provider;
    }

    // 回落读取 repo 的磁盘事实而不是内存字段：进程重启后内存为空，磁盘才是登录状态的来源。
    return this.repo.getActiveProvider();
  }

// 把适配器抛出的任意错误归一成统一形状：上层只依赖归一后的 message 判断 401/403。
// 归一在边界处做一次，调用点不再各自 try/catch。
  private async runWithAdapterError<T>(
    // 适配器参数用于归一错误：不同 provider 的错误形状不同，必须由它自己的适配器翻译。
    adapter: OAuthProviderAdapter,
    // 用 thunk 而不是已创建的 Promise：错误归一必须包住调用本身，否则抓不到同步抛错。
    run: () => Promise<T>,
  ): Promise<T> {
    try {
// 适配器错误在边界处归一一次：上层只依赖归一后的 message 判断 401 与 403，不再解析原始错误类型。
// 归一函数自身失败时错误照常冒泡，这里不追加兜底，否则会掩盖 provider 实现的缺陷。
      return await run();
    } catch (error) {
      // 归一后重新抛出，不保留原始错误：上层只依赖统一 message 判断 401 与 403。
      throw adapter.normalizeError(error);
    }
  }

  // 只用于启动恢复时确认身份是否被远端拒绝；网络错误与 5xx 不能当成登出理由。
  private isUnauthorizedError(error: Error): boolean {
// 判定远端是否明确拒绝身份：先匹配独立的 401 与 403 数字，避免把订单号里的 401 误判成未授权。
// unauthorized 与 forbidden 转小写后做包含匹配，兼容各 provider 不统一的错误文案。
// 只用于启动恢复确认身份的短路，网络错误与 5xx 不会在这里被当成登出理由。
    const lowerMessage = error.message.toLowerCase();
    // 先匹配独立的 401/403 数字（\\b 边界），避免把订单号或时间戳里的数字误判成未授权。
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  // 工厂只注入 ICredentialService：适配器、时钟、环境都由默认装配提供，减少入口重复配置。
  credentialService: ICredentialService,
  // 类型排除 adapters：调用方只能整体替换装配，不能只传部分适配器导致能力与 getProviders 不一致。
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
// 工厂默认装配真实适配器，调用方只注入凭据服务与可选依赖，避免每个入口重复拼 provider 列表。
// 依赖类型里排除 adapters，防止调用方只传一部分适配器，导致 getProviders 与实际能力不一致。
  return new OAuthService(credentialService, {
    ...dependencies,
    // 用环境快照构造运行时配置：桌面与 CLI 的 redirect_uri 与 API 地址来自不同变量。
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      // 把同一个 apiClient 传给适配器，保证鉴权与数据请求共用连接与超时配置。
      apiClient: dependencies.apiClient,
    }),
  });
}
