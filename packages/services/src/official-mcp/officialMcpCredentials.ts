/*
 * ZCode 官方 Server MCP 的凭证解析与身份头构造。
 *
 * 本文件与 Off-Peak 的 offPeakRuntimeModel.ts **逻辑等价但完全独立**：
 * 不复用其函数、不修改其行为。理由是两者的套餐门槛、Team 支持范围与凭证通道预期会独立演进，
 * 共享 helper 会让任一侧的调整都变成需要评估双方影响的改动。
 *
 * 与 Off-Peak 的三处有意差异：
 *   1. 显式产出 Bigmodel-Target-Type（Off-Peak 侧当前没有生产者）；
 *   2. 不存在任何 mock 凭证分支（官方 MCP 无 mock 网关，测试用依赖注入替换来源）；
 *   3. 失败原因使用 official_* 分类，不复用 Off-Peak 的 reason 字符串。
 *
 * 凭证通道：Coding Plan 凭证走 `X-Bigmodel-Authorization` + MaaS 登录 JWT，
 * 不再发送 `X-Coding-Plan-Api-Key`。服务端把 API key 通道标为"仅存量客户端兼容"，且两个头同时
 * 发送是有害的——JWT 会赢得额度查询，但 API key 的归属校验仍会照跑，一把过期 key 就能让整个
 * 请求 403。Off-Peak 仍走 API key 通道，这也是上面"逻辑等价但完全独立"的又一个理由。
 */
import {
  OFFICIAL_MCP_AUTH_HEADER_NAMES,
  getModelProviderFamilySpec,
  zcodeProviderAccountAccessSchema,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

// 全局登录 JWT 的凭证键；只读这一个键，不按 provider 分叉——它是登录身份的镜像。
// 真正的 Coding Plan 凭证是下方按 family 选择的 MaaS JWT，两者不可混用。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

/**
 * MaaS 登录 JWT 的凭证键（`oauth:<provider>:access_token`，见 oauth/repo/oauthCredentialRepo.ts）。
 *
 * 必须按 provider family 精确选择、**禁止跨 family 回退**：拿 ZAI 的业务 JWT 去打 BigModel 的
 * Coding Plan 只会得到一次注定失败的请求，而且失败原因会指向"没有套餐"这种误导结论。
 * 这几行与 bigmodelUsageQuotaProvider 的 reset 通道逻辑等价但独立（见文件头说明）。
 */
function maasJwtCredentialKey(providerFamily: "zai" | "bigmodel"): string {
// provider family 到 oauth provider id 的映射由共享 spec 提供，禁止在这里硬编码 id 字符串。
  return `oauth:${getModelProviderFamilySpec(providerFamily).oauthProviderId}:access_token`;
}

/**
 * 只为日志算出 JWT 的剩余有效期（秒）。**不参与任何控制流**，解析失败返回 undefined。
 *
 * 存在理由：MaaS JWT 没有刷新链路，过期后服务端的表现是 queryCodingPlan 上游 401，
 * 客户端却收到"需要 Coding Plan"这类文案——真实原因与提示不符。有了这个数值，
 * "神秘的 403"能一眼看出是"token 早就过期了"。只记数字，绝不记 token 本身。
 */
function readJwtExpiresInSeconds(token: string): number | undefined {
  // JWT 由 header.payload.signature 三段组成，取第二段；不足三段说明 token 不是 JWT，直接放弃解析。
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    // base64url 用 -_ 代替 +/，Buffer 只认标准字母表；不转换会在 JSON.parse 前就解出乱码。
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    // 解出的必须是对象：数组或标量说明 payload 被换过，不能从里面取 exp。
    if (typeof decoded !== "object" || decoded === null) return undefined;
    // exp 是 Unix 秒；字符串形式的数字不在这里转换，宁可返回 undefined 也不猜。
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    // 只算剩余秒数而不验签也不判过期；readJwtExpiresInSeconds 的结果只进日志，不参与任何凭证选择。
    return Math.round(exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

/** 凭证解析 info 日志的有效期分桶粒度（秒）；桶内不重复记录，见 createCredentialResolvedLogKey。 */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * 凭证解析成功日志的去重键（导出仅为可单测，无其他消费方）。
 *
 * 生产日志保留 JWT 有效期分桶，帮助区分凭据过期与套餐不可用，不记录凭据原文。
 * resolver 只合并正在执行的请求，没有时间缓存；因此按小时分桶去重，避免每次
 * MCP 调用都产生 info 日志。凭据有效期跨桶、进入 expired 或切换套餐类型时重新记录。
 */
export function createCredentialResolvedLogKey(input: {
  providerFamily: "zai" | "bigmodel";
  planTargetType: string | null;
  maasJwtExpiresInSeconds: number | undefined;
}): string {
  // 先把 maasJwtExpiresInSeconds 取出来，后续三元只处理本地变量，避免重复可空判断。
  const expires = input.maasJwtExpiresInSeconds;
  // 三态分桶：不可解析、已过期、按小时；把原始秒数放进 key 会让每次刷新都产生新日志。
  const expiryBucket =
    expires === undefined
      ? "unparsable"
      : expires <= 0
        ? "expired"
        // expires 除以 3600 取整得到小时桶，同一小时内有效期变化不再触发记录。
        : `t${Math.floor(expires / CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS)}`;
  // family、套餐目标类型、有效期桶任一变化都会换 key；三者共同描述这一代凭证的状态。
  return `${input.providerFamily}|${input.planTargetType ?? "none"}|${expiryBucket}`;
}

// 上一轮 info 日志的去重键；只在模块内比较，进程重启后重新记录一次是预期行为。
// 与 resolver 的 in-flight 去重相互独立：前者控日志量，后者控请求量。
let lastCredentialResolvedLogKey: string | undefined;

// 解析依赖全部由调用方注入：账号服务负责动态套餐与 Team scope，凭证服务负责原始密钥。
// 不直接 import 具体实现，测试可以用简单桩替换，也避免 services 内部出现环依赖。
export interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  credentialService: { load(key: string): Promise<string | null | undefined> };
  modelSelectionService: {
    getView(): Promise<ModelSelectionView>;
  };
}

// 套餐作用域：PERSONAL 不带组织信息；TEAM 必须同时给出组织与项目 id，缺一不可。
// 该类型只描述凭证归属，与发往服务端的头 scope（wireScope）分开表达。
export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** 解析成功后的凭证快照。仅在 host/service 进程内存活，脱敏后才允许过 RPC。 */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * MaaS 登录 JWT（`oauth:<family>:access_token` 的原文，**不带 Bearer 前缀**）。
   * 前缀在 buildOfficialMcpAuthHeaders 里加，与 reset / usage 通道的既有约定一致。
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  /** 当前选中连接的产品/额度归属；畸形旧 Team key 无法精确归属时为 null。 */
  planScope: OfficialMcpPlanScope | null;
  /** 实际发往 Server MCP 的身份头 scope；ZAI Team 与 Off-Peak 一致为 null。 */
  wireScope: OfficialMcpWireScope;
}

// 解析结果用可判别联合表达：失败只带稳定 reason，不把原始响应或 token 透出。
export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

// 内部中间态：provider、family 与两种 scope 选中后必须一起传递，调用点不再各自推导。
type SelectedPlan = {
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
};

type SelectedProvider = {
  providerId: string;
  access: ZCodeProviderAccountAccess;
};

// 统一的失败构造器，保证 reason 字段名与联合类型完全一致。
function fail(reason: OfficialMcpAuthFailureReason): {
  ok: false;
  reason: OfficialMcpAuthFailureReason;
} {
  // reason 只取联合类型里的枚举值：错误对象不得携带上游响应或 token，避免凭证经错误路径外泄。
  return { ok: false, reason };
}

/**
 * 从 Registry 判定当前启用的 Coding Plan Provider；动态套餐和 Team scope 随后由账号服务解析。
 * 禁止从静态 Provider Config 读取或伪造当前 Team scope。
 */
function resolveSelectedProvider(
  registry: ModelSelectionView,
): { ok: true; provider: SelectedProvider } | { ok: false; reason: OfficialMcpAuthFailureReason } {
// 只在 Registry 里找 coding-plan 连接；配置非法的 provider 直接忽略，而不是让整轮解析失败。
  // 逐个 safeParse：单个 provider 的 config.access 损坏只排除它自己，不能让整轮解析失败。
  const candidates = registry.providers.flatMap((provider) => {
    // access 来自持久化配置，可能被手改成非法形状；safeParse 失败直接丢弃该 provider。
    const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    // 只保留 individual-coding-plan 与 team-coding-plan 两种模式，其余 provider 与 MCP 鉴权无关。
    return parsed.success &&
      (parsed.data.mode === "individual-coding-plan" || parsed.data.mode === "team-coding-plan")
      ? [{ providerId: provider.providerId, access: parsed.data }]
      : [];
  });
  // 必须恰好一个命中：0 个表示没连 Coding Plan，多个表示选择不唯一，两种都不能猜。
  if (candidates.length !== 1) {
    return fail("official_auth_plan_required");
  }
  // 上面的长度校验已保证非空，这里的断言成立；不额外再写一次 undefined 判断。
  return { ok: true, provider: candidates[0]! };
}

function resolveSelectedPlan(
  selectedProvider: SelectedProvider,
  access: ZCodeAccountAccess | null,
): { ok: true; plan: SelectedPlan } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  // 前置条件：selectedProvider 已通过「恰好一个」校验；本函数只校验身份一致性，不再判断候选数量。
  if (
    // access 为空表示账号服务查不到当前套餐；后续字段比较都依赖它，因此先短路。
    !access ||
    // family 必须与连接声明一致；不一致说明读到的是另一个 provider 的套餐，继续会拼出跨身份凭证。
    access.family !== selectedProvider.access.accountType ||
    // 连接声明为团队时账号必须是团队套餐，声明为个人时反之；宽松匹配会让个人 key 拿到团队额度。
    (selectedProvider.access.mode === "team-coding-plan"
      ? access.planKind !== "team-coding-plan"
      : access.planKind !== "individual-coding-plan")
  ) {
    return fail("official_auth_plan_required");
  }
  // 通过校验后才取 providerId；此前它只是候选，不能作为凭证归属。
  const { providerId } = selectedProvider;
  // family 以账号服务的实时结果为准，而不是 Registry 里可能过期的 accountType。
  const providerFamily = access.family;
  if (access.planKind === "team-coding-plan") {
    // 团队 scope 必须有 organizationId 与 projectId；缺一在 schema 与上面的 planKind 校验里已被拒绝。
    const teamScope: OfficialMcpPlanScope = {
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TEAM",
    };
    return {
      ok: true,
      plan: {
        providerFamily,
        providerId,
        planScope: teamScope,
        // 只有 BigModel 的 Server MCP 认 Team 头；ZAI 与 Off-Peak 一致发 null，避免多带一个服务端不认的 scope。
        wireScope: providerFamily === "bigmodel" ? teamScope : null,
      },
    };
  }
  return {
    ok: true,
    plan: {
      providerFamily,
      providerId,
      planScope: { targetType: "PERSONAL" },
      // 个人套餐两个 scope 都是 PERSONAL：planScope 记本地归属，wireScope 决定实际发出去的头。
      wireScope: { targetType: "PERSONAL" },
    },
  };
}

/** 非秘密的选择指纹，用于解析前后比对，防止把切换前后的两代凭证拼进同一请求。 */
function createSelectionFingerprint(registry: ModelSelectionView): string {
  // 指纹只用于判断两代快照是否相同，不参与身份校验；它含 provider 配置但不含任何 token 原文。
  return JSON.stringify({ revision: registry.revision, providers: registry.providers });
}

type OfficialMcpIdentitySnapshot = {
  activeProvider: "zai" | "bigmodel";
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
// 三个读取并发发出：它们彼此独立，串行只会放大解析期间状态变化的窗口。
  // 解构顺序与数组一致：registry、active provider、zcode JWT；三者互不依赖。
  const [registry, activeProviderValue, jwtValue] = await Promise.all([
    deps.modelSelectionService.getView(),
    deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    deps.credentialService.load(ZCODE_JWT_TOKEN_KEY),
  ]);
  // trim 后再比较：历史写入可能带换行，严格相等会把它判成非法值。
  const activeProvider = activeProviderValue?.trim();
  const jwt = jwtValue?.trim() ?? "";
  // 只接受内置 family 且 JWT 非空；其它值说明登录态不完整，返回 unavailable 而不是 plan_required。
  if ((activeProvider !== "zai" && activeProvider !== "bigmodel") || !jwt) {
    return fail("official_auth_unavailable");
  }
  return {
    ok: true,
    snapshot: {
      activeProvider,
      jwt,
      registry,
      // 指纹在这一刻固化；后续 registry 即使被改写，也不会影响本次快照的代表性。
      selectionFingerprint: createSelectionFingerprint(registry),
    },
  };
}

// 前后快照一致才算稳定；任一字段变化都视为状态在解析期间被改动，必须整轮重来。
function isSameIdentitySnapshot(
  before: OfficialMcpIdentitySnapshot,
  after: OfficialMcpIdentitySnapshot,
): boolean {
  return (
    // 三项全等才算同一代：jwt 直接比字符串而 registry 比指纹，避免换序或新增字段被漏掉。
    before.activeProvider === after.activeProvider &&
    // jwt 与指纹都无法从对象结构推断等价性，只能逐项比较；任一不同就让上层重来。
    before.jwt === after.jwt &&
    before.selectionFingerprint === after.selectionFingerprint
  );
}

// 没有可用套餐但身份完整时的降级结果：只发登录 JWT，不带任何 scope 头。
function identityOnlyOutcome(identity: OfficialMcpIdentitySnapshot): OfficialMcpCredentialOutcome {
  // 前置条件：调用方必须已确认 identity 快照前后一致；否则这里会把切换前的 JWT 当作降级结果发出去。
  // debug 级别：没有套餐是正常降级，用 info 会淹没真正需要关注的套餐解析失败。
  log.debug("official mcp identity-only credentials resolved", {
    providerFamily: identity.activeProvider,
    // reason 用固定枚举而不是拼接文案：调用方按值分类，日志与 UI 各自决定怎么展示。
    reason: "official_auth_plan_required",
  });
  return {
    ok: true,
    snapshot: {
      jwt: identity.jwt,
      // 两个 scope 都置 null：只发登录 JWT，服务端按「无套餐」处理，不会误判成团队身份。
      planScope: null,
      providerFamily: identity.activeProvider,
      wireScope: null,
    },
  };
}

/**
 * 解析当前选中连接的官方 MCP 凭证。
 *
 * 防竞态：Registry、动态 Account Access、active provider、zcode JWT 与 MaaS JWT
 * 都可能在解析期间变化。这里在前后各取一次并比对，任一不一致就整轮
 * 重来，绝不拼接两代凭证——既包括"zcode JWT 来自 ZAI 而 MaaS JWT 来自 BigModel"（跨 family 混搭），
 * 也包括"旧 JWT + 新 JWT"（同 family 的 token 轮换）。两轮仍不稳定则按不可用返回。
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialOutcome> {
  // attempt 最多两轮：第一轮遇到状态变化就重来，第二轮仍不稳定则返回不可用，避免无限重试。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readIdentitySnapshot(deps);
    if (!identity.ok) {
      // attempt === 0 时允许重试一次（可能正好赶上切换）；第二轮失败才把原因返回。
      if (attempt === 0) continue;
      return identity;
    }
    // 选中连接只从本次快照的 registry 推导，不重新读服务，保证与 identity 属于同一代。
    const selectedProvider = resolveSelectedProvider(identity.snapshot.registry);
    if (!selectedProvider.ok) {
      // 没有选中连接时再读一次：如果快照没变，说明确实没有套餐；变了则重来。
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }
    // 套餐是动态的（升级/退订随时发生），必须实时解析，不能沿用 Registry 里的静态 access。
    const accountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const selected = resolveSelectedPlan(selectedProvider.provider, accountAccess);
    // selected.ok 为 false 时不重试：原因（无套餐/身份不匹配）由稳定输入决定，再读一次也不会变。
    if (!selected.ok) return selected;

    // zcode JWT 是全局登录身份镜像；只校验 selectedKey 会把 ZAI JWT 与 BigModel key 拼到同一请求。
    if (identity.snapshot.activeProvider !== selected.plan.providerFamily) {
      return fail("official_auth_unavailable");
    }

    // 顺序约束：必须先由 selected.plan 确定 family 再读 MaaS JWT；按 active provider 读会拿到另一 family 的 token。
    // MaaS JWT 的 key 由 family 决定；跨 family 回退只会换来一次注定失败的 403。
    const maasJwtKey = maasJwtCredentialKey(selected.plan.providerFamily);
    const codingPlanAuthorization = (await deps.credentialService.load(maasJwtKey))?.trim() ?? "";
    // MaaS JWT 为空说明登录态不完整（需要重新登录），不是「没有套餐」，因此归 unavailable 而不是 plan_required。
    if (!codingPlanAuthorization) {
      // 归类为 unavailable 而不是 plan_required：这是登录态不完整（需要重新登录），
      // 不是"没有套餐"。两个 provider adapter 在登录时都会硬性要求写入该 token，
      // 因此正常路径不会命中，主要出现在历史迁移过来的旧登录态上。
      log.warn("official mcp maas jwt missing", {
        providerFamily: selected.plan.providerFamily,
        reason: "official_auth_unavailable",
      });
      return fail("official_auth_unavailable");
    }

    // 身份与 MaaS JWT 必须在同一轮并发读取：分两次读会把轮换前后的两代凭据拼进同一请求。
    const [latestIdentity, latestMaasJwt] = await Promise.all([
      readIdentitySnapshot(deps),
      deps.credentialService.load(maasJwtKey),
    ]);
    // 第二轮 selectedProvider 从最新快照重新推导，不能复用第一轮的 providerId。
    const latestSelectedProvider = latestIdentity.ok
      ? resolveSelectedProvider(latestIdentity.snapshot.registry)
      : latestIdentity;
    const latestAccountAccess = latestSelectedProvider.ok
      ? await deps.accountRequestAuthService.resolveAccessCurrent(
          latestSelectedProvider.provider.access,
        )
      : null;
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      !latestSelectedProvider.ok ||
      // 账号 access 用序列化比较：它是纯数据对象，字段顺序由同一解析函数决定，结果稳定。
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      codingPlanAuthorization !== (latestMaasJwt?.trim() ?? "")
    ) {
      continue;
    }

    // provider 条目只作"该 Coding Plan 连接确实存在"的门槛。业务 key 本身不再是凭证
    // （已切到 MaaS JWT 通道），因此不再要求它有值——否则业务 key 正在刷新的瞬态
    // 会把一次本可成功的调用判成"没有套餐"。真正的"没有套餐"由上面两道门槛拦住：
    // API Key 模式与选中 Start Plan 连接，两者都不依赖业务 key。
    // 只校验 provider 条目仍存在；业务 key 已不参与凭证，因此不检查它的值。
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    // 快照内找不到说明 registry 在两次读取间被替换，按无套餐返回，由外层重试。
    if (!provider) return fail("official_auth_plan_required");

    // info 而非 debug：生产构建 debug 不落盘，而 MaaS JWT 剩余有效期是排障关键线索
    // （见 createCredentialResolvedLogKey 的说明）。只记剩余秒数，绝不记 token 本身。
    // 去重键跨桶才记录，避免日志量与官方 MCP 请求数同数量级。
    // readJwtExpiresInSeconds 的结果只用于日志分桶与排障，绝不参与是否放行的判断。
    const maasJwtExpiresInSeconds = readJwtExpiresInSeconds(codingPlanAuthorization);
    // 去重键由 family、套餐目标与有效期桶组成，不含 token 原文。
    const logKey = createCredentialResolvedLogKey({
      providerFamily: selected.plan.providerFamily,
      planTargetType: selected.plan.planScope?.targetType ?? null,
      maasJwtExpiresInSeconds,
    });
    // logKey 相同就跳过日志；跨小时桶或套餐类型变化才记录一次，控制日志量。
    if (logKey !== lastCredentialResolvedLogKey) {
      lastCredentialResolvedLogKey = logKey;
      log.info("official mcp credentials resolved", {
        maasJwtExpiresInSeconds,
        providerFamily: selected.plan.providerFamily,
        planTargetType: selected.plan.planScope?.targetType ?? null,
        wireTargetType: selected.plan.wireScope?.targetType ?? null,
      });
    }

    return {
      ok: true,
      snapshot: {
        codingPlanAuthorization,
        jwt: identity.snapshot.jwt,
        planScope: selected.plan.planScope,
        providerFamily: selected.plan.providerFamily,
        wireScope: selected.plan.wireScope,
      },
    };
  }

  return fail("official_auth_unavailable");
}

/**
 * 由凭证快照构造本次请求的身份头。
 * Team 身份成对原子性：organization/project 任一缺失时两者都不发送。
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  // 登录 JWT 无条件发送：它是 Server MCP 识别账号的唯一身份头。
  const headers: Record<string, string> = {
    // 快照里的 jwt 不带前缀，Bearer 在这里统一拼接，与 reset/usage 通道的约定保持一致。
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  // Coding Plan 头只在快照带 MaaS JWT 时发送：空值会让服务端按 API key 通道鉴权。
  if (snapshot.codingPlanAuthorization) {
    // 服务端会 CutPrefix("Bearer ")，裸 token 也接受；这里按 MCP 接口文档发 Bearer 形式。
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  // wireScope 决定实际发出的 scope 头；为 null 时两个 scope 头都不出现。
  const scope = snapshot.wireScope;
  if (scope) {
    // 先写 targetType 再按需补团队字段：个人请求只有这一个 scope 头。
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    // TEAM 三元组成对发送：缺 organization 或 project 任一，服务端会退化成个人套餐判定。
    if (scope.targetType === "TEAM") {
      // organization 与 project 连续赋值，中间不做任何 await，保证两个头同进同出。
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** host handler 透传的请求上下文；不参与凭证选择。 */
export interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * 身份头解析入口，带 in-flight 去重。
 *
 * 只合并**并发**请求：已有解析在飞时后来者复用同一 Promise；settle 后立即丢弃，
 * 下一个请求重新完整解析。不做任何时间维度缓存，因此不存在"读到已被替换的旧凭证"的窗口。
 * 作用域为 host 全局——凭证是全局状态，按 plugin/mcpKey/workspace 分桶只会削弱去重、不增隔离。
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;

  return {
    // request 仅为契约对齐（host handler 已在此之前完成可信校验，见 zcodeAgentService）；
    // 凭据是 host 全局状态，**不**按 plugin/mcpKey/workspace 分桶——分桶只会削弱 in-flight
    // 去重而不增加隔离。参数保留是为了将来审计需要时不必再改接口。
    resolveHeaders(_request?: OfficialMcpAuthHeadersRequestContext) {
      // 有解析在飞就复用同一 Promise：并发的 MCP 调用只需要一次凭证解析。
      if (pending) return pending;
      // 用立即执行的 async 包住解析，便于在 settle 后精确比较并清空 slot。
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        // 解析结果原样转成 headers；失败只带稳定 reason，不透出内部错误。
        const outcome = await resolveOfficialMcpCredentials(deps);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        // 成功路径在此完成快照到 header 的转换，调用方拿不到 token 原文。
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      // 先登记再挂 clear：否则解析同步失败时 clear 会看到空 slot 而漏清。
      pending = inFlight;
      // 用双 handler 的 then 而非 finally：finally 会派生一个同样 reject 的 promise，
      // 调用方只 await 了 inFlight，那个派生 promise 无人处理会变成 unhandled rejection。
      // 解析抛错也必须清空 slot，否则后续请求会永久复用失败的 Promise。
      const clear = (): void => {
        // 只清自己写入的 Promise：若期间已有新请求替换 slot，清空会误删别人的 in-flight。
        if (pending === inFlight) pending = null;
      };
      // 成功与失败都清 slot：失败不清会让后续请求永久复用同一个 reject 的 Promise。
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
