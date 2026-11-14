/* eslint-disable max-lines -- Off-Peak 凭证解析、支持矩阵与 Request Auth 共用同一组契约，拆散会让双凭证/Team 身份边界更难追踪。 */
/* Host 派发时按当前票据构造逐请求鉴权材料；Provider/Model 静态事实由 Built-in Config 提供。 */
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveOffPeakProviderId,
  buildRuntimeZCodeApiUrl,
  type OffPeakCodingPlanKind,
  type OffPeakCodingPlanSupport,
  type OffPeakCodingPlanUnsupportedReason,
  type ZCodeAccountAccess,
} from "@zcode/shared";
import { isOffPeakMockEnabled, startOffPeakMockGateway } from "./offPeakMockGateway.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { AccountRequestCredentialUnavailableError } from "../model-provider/accountProviderRequestAuthService.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";

/** 仅用于确定性配置错误；host 据类型输出 permanent，禁止依赖错误文本分流。 */
export class OffPeakPermanentDispatchError extends Error {
// 固定为 permanent，host 不根据错误文本判断可重试性。
  readonly failureKind = "permanent" as const;

  constructor(message: string) {
    super(message);
    this.name = "OffPeakPermanentDispatchError";
  }
}

/** 双凭证解析失败的类型化错误（UI 可据此提示登录/配置 coding plan）。 */
// missing 区分缺 JWT 还是缺计划 key，UI 据此给出不同引导。
export class OffPeakCredentialsUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly missing: "jwt" | "codingPlanApiKey") {
    super(
      missing === "jwt"
        ? "off-peak requires zcode login (jwt missing)"
        : "off-peak requires a coding plan provider api key",
    );
    this.name = "OffPeakCredentialsUnavailableError";
  }
}

/** 当前 provider family / selected connection 不属于 Off-Peak 支持矩阵。 */
// reason 原样透传给 support 快照，避免二次映射。
export class OffPeakCodingPlanUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly reason: OffPeakCodingPlanUnsupportedReason) {
    super(`off-peak selected coding plan unavailable: ${reason}`);
    this.name = "OffPeakCodingPlanUnavailableError";
  }
}

/** 用户常驻模型或 idle plan 模型缺失时停止空耗 ticket 的类型化错误。 */
// 两种 scope 对应「idle 计划模型」与「用户常驻模型」两条来源。
export class OffPeakModelUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly scope: "idlePlan" | "workspaceUser") {
    super(
      scope === "idlePlan"
        ? "off-peak dispatch has no usable model (Built-in Provider models empty)"
        : "off-peak dispatch has no usable user workspace model",
    );
    this.name = "OffPeakModelUnavailableError";
  }
}

// 双凭证的两个来源 key：App 登录 JWT 与当前 OAuth provider family。
// 名称沿用 credential service 的历史 key，不可改名。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

// 快照只存活于 host/service 内存，renderer 永远拿不到 jwt 与计划 key。
export interface OffPeakCredentialSnapshot {
  jwt: string;
  codingPlanApiKey: string;
  accountScope?: string;
  kind: OffPeakCodingPlanKind;
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  /** BigModel Team 组织/项目身份；仅两者同时存在时才允许进入请求头。 */
  organizationId?: string;
  projectId?: string;
  /** 仅供进程内 mock 代理真实选中 Coding Plan 上游；不会过 RPC 或持久化。 */
  providerBaseURL?: string;
}

// 依赖全部注入，测试可替换账号解析与凭证读取。
// env 可注入，避免测试污染进程环境。
interface OffPeakCredentialResolverDeps {
  credentialService: { load(key: string): Promise<string | null | undefined> };
  accountRequestAuthService: IAccountRequestAuthService;
  resolveAccountProvider(): Promise<{
    readonly providerId: string;
    readonly access: ZCodeAccountAccess;
    readonly baseURL?: string;
  } | null>;
  env?: NodeJS.ProcessEnv;
}

// 选中计划只保留身份维度，凭证字段在解析后单独补齐。
type SelectedOffPeakCodingPlan = Pick<
  OffPeakCredentialSnapshot,
  "kind" | "providerFamily" | "providerId" | "organizationId" | "projectId"
>;

// 计划类型直接决定 kind 与是否需要 org/project 头，是唯一分派点。
function resolveSelectedOffPeakCodingPlan(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): SelectedOffPeakCodingPlan {
  if (!provider) {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  const { access, providerId } = provider;
// start-plan 不含 coding plan 额度，直接判定不支持。
  if (access.planKind === "start-plan") {
    throw new OffPeakCodingPlanUnavailableError("start_plan_not_supported");
  }
// 个人版按 family 映射到 zai / bigmodel 两种个人计划。
  if (access.planKind === "individual-coding-plan") {
    return {
      kind: access.family === "zai" ? "zai-personal" : "bigmodel-personal",
      providerFamily: access.family,
      providerId,
    };
  }
// 其余计划一律按连接不可用处理。
  if (access.planKind !== "team-coding-plan") {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  return {
// Team 计划必须携带组织与项目，否则身份头无法构造。
    kind: access.family === "zai" ? "zai-team" : "bigmodel-team",
    providerFamily: access.family,
    providerId,
    organizationId: access.organizationId,
    projectId: access.projectId,
  };
}

// 指纹用整份 provider 解析结果，任一字段变化都视为选择已切换。
// 只包含确定性结构字段，不含时间戳等易变值。
function createOffPeakSelectionFingerprint(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): string {
  return JSON.stringify(provider ?? null);
}

/**
 * 解析当前 selected connection 的 Off-Peak 双凭证。
 *
 * 派发凭据必须与 UI 选中的 Coding Plan 保持一致，避免 ZAI/Team 任务误用个人 BigModel key。
 * 以 settings 的 family + selectedKey 为唯一选择来源，再通过执行入口注入的鉴权来源
 * 解析动态凭据。
 * Team key 继续复用 Account Request Auth 的 org/project resolver，失败时绝不回退个人 key。
 */
// 主入口：先判定 mock，再走两次「解析-校验」循环。
// 返回的快照直接用于构造请求头，不做二次加工。
export async function resolveOffPeakCredentials(
  deps: OffPeakCredentialResolverDeps,
  options: { allowMockCredentials?: boolean } = {},
): Promise<OffPeakCredentialSnapshot> {
  const env = deps.env ?? process.env;
// env 缺省取进程环境；mock 分支必须先于真实凭证解析。
  if (options.allowMockCredentials !== false && env["ZCODE_OFFPEAK_MOCK"] === "1") {
// 该开关用于验证「无可用计划」的 UI 分支。
    if (env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] === "1") {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    // mock 网关不校验凭证；使用确定性 metadata 让 UI 和 ticket/runtime 仍共享同一 support 形状。
    return {
      jwt: "offpeak-mock-jwt",
      codingPlanApiKey: "offpeak-mock-key",
      kind: "bigmodel-personal",
      providerFamily: "bigmodel",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }

  // settings 可能在账号 Provider 解析期间切换。前后指纹不一致时重读一次，禁止拼接两代凭证。
// 最多重读一次：第二次仍变化就放弃，避免无限重试。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const provider = await deps.resolveAccountProvider();
// [失败路径] resolveSelectedOffPeakCodingPlan 抛错即终止：非法选择不落日志、不读 ACTIVE_OAUTH_PROVIDER_KEY。
    const selection = resolveSelectedOffPeakCodingPlan(provider);
    const activeProvider =
      (await deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY))?.trim() ?? "";
// JWT 与 family 必须同源，否则会拼出跨身份凭证。
    if (activeProvider !== selection.providerFamily) {
      // zcode JWT 是当前 App 登录身份的全局镜像；只校验 selectedKey 会把
      // ZAI JWT 与 BigModel key（或反向）拼到同一请求，服务端只能在取号时才拒绝。
      throw new OffPeakCodingPlanUnavailableError("provider_identity_mismatch");
    }
// 空字符串与 null 统一归为缺失。
    const jwt = (await deps.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!jwt) {
      throw new OffPeakCredentialsUnavailableError("jwt");
    }
    const [latestProvider, latestActiveProvider] = await Promise.all([
      deps.resolveAccountProvider(),
      deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    ]);
    if (
// 前后两次解析不一致说明用户中途切换了连接。
      createOffPeakSelectionFingerprint(provider) !==
        createOffPeakSelectionFingerprint(latestProvider) ||
      activeProvider !== latestActiveProvider?.trim()
    ) {
      continue;
    }

    if (
      !provider ||
// 复核 family 与 planKind，防止解析后状态被并发改写。
      provider.access.family !== selection.providerFamily ||
      (selection.kind.endsWith("-team")
        ? provider.access.planKind !== "team-coding-plan"
        : provider.access.planKind !== "individual-coding-plan")
    ) {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
// 计划 key 走 Account Request Auth 动态解析，Team 场景还要带 org/project。
    let codingPlanApiKey = "";
    let accountScope: string | undefined;
    try {
// 只有凭证不可用会转成类型化错误，其余异常原样抛出。
      const auth = await deps.accountRequestAuthService.resolveCurrent({
        providerId: selection.providerId,
        modelId: resolveOffPeakProviderId(selection.providerFamily),
        accountAccess: provider.access,
        reason: "off-peak",
      });
      codingPlanApiKey = auth.apiKey?.trim() ?? "";
      accountScope = auth.accountScope;
    } catch (error) {
// 账号鉴权服务缺凭证时收敛为计划 key 缺失。
      if (error instanceof AccountRequestCredentialUnavailableError) {
        throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
      }
      throw error;
    }
// 解析成功但 key 为空同样视为不可用。
    if (!codingPlanApiKey) {
      throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
    }
    return {
      ...selection,
      jwt,
      codingPlanApiKey,
      ...(accountScope ? { accountScope } : {}),
      ...(provider.baseURL ? { providerBaseURL: provider.baseURL } : {}),
    };
  }

// 两轮都发生切换才走到这里，交给上层提示用户重试。
  throw new OffPeakCodingPlanUnavailableError("selection_changed");
}

/**
 * BigModel Team 的组织/项目必须和鉴权凭证来自同一次 selected connection 解析。
 *
 * Off-Peak 过去只传 JWT 与 Coding Plan key，服务端没有 BigModel access key，
 * 无法反查 Team Plan 的 organization/project。旧版 connection key 可能只有 projectId，
 * 此时禁止发送半套身份头，避免服务端按错误组织归属校验。
 */
// 非 Team 计划不发送任何 BigModel 身份头。
export function buildOffPeakPlanIdentityHeaders(
  credentials: OffPeakCredentialSnapshot,
): Record<string, string> {
// 只有 Team 计划需要 BigModel 组织/项目头。
  if (credentials.kind !== "bigmodel-team") {
    return {};
  }
// 组织与项目必须成对，缺一即视为身份不完整。
  const organizationId = credentials.organizationId?.trim() ?? "";
  const projectId = credentials.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return {};
  }
  return {
// 两个头必须同源，服务端按组织+项目校验归属。
    "bigmodel-organization": organizationId,
    "bigmodel-project": projectId,
  };
}

/**
 * 构造一次闲时执行的动态鉴权材料。Endpoint、模型能力和 reasoning 等静态事实由
 * Built-in Provider / Model Config 提供，禁止再随单次派发下发。
 */
// 三个头缺一不可：JWT 证明登录身份，计划 key 证明额度，ticket 证明本次派发。
export function buildOffPeakRequestAuth(params: {
  credentials: OffPeakCredentialSnapshot;
  ticketId: string;
}): { apiKey: string; headers: Record<string, string>; accountScope?: string } {
  return {
    // Anthropic 兼容客户端会发送 x-api-key；服务端仍以 Authorization 与计划 Key 裁决。
    apiKey: params.credentials.jwt,
    ...(params.credentials.accountScope ? { accountScope: params.credentials.accountScope } : {}),
    headers: {
// Authorization 与 x-api-key 同值，兼容两类客户端。
      Authorization: `Bearer ${params.credentials.jwt}`,
      "X-Coding-Plan-Api-Key": params.credentials.codingPlanApiKey,
// ticket 只对本次派发有效，由服务端核销。
      "X-Off-Peak-Ticket-ID": params.ticketId,
      ...buildOffPeakPlanIdentityHeaders(params.credentials),
    },
  };
}

/** renderer 可见的脱敏支持快照；凭证原文始终留在 host/service 内存。 */
// UI 只拿到 supported 与原因码，错误文本不跨层传。
export async function resolveOffPeakCodingPlanSupport(
  deps: OffPeakCredentialResolverDeps,
): Promise<OffPeakCodingPlanSupport> {
  try {
// 解析成功即认为当前选择可用，不回传任何凭证字段。
    const snapshot = await resolveOffPeakCredentials(deps);
    return {
      supported: true,
      kind: snapshot.kind,
      providerFamily: snapshot.providerFamily,
      providerId: snapshot.providerId,
    };
  } catch (error) {
// 计划不可用直接映射为 reason，供 UI 精确提示。
    if (error instanceof OffPeakCodingPlanUnavailableError) {
      return { supported: false, reason: error.reason };
    }
// 缺 JWT 与缺计划 key 的引导路径不同，但都归为未连接。
    if (error instanceof OffPeakCredentialsUnavailableError) {
      return {
        supported: false,
        reason: error.missing === "jwt" ? "jwt_missing" : "connection_unavailable",
      };
    }
    throw error;
  }
}

/**
 * mock 网关的上游解析：把 admitted 的 messages 代理到用户 coding plan 的 anthropic
 * 兼容端点（真模型、走用户自己的 key，仅开发/演示）。
 */
// 仅在 mock 模式下调用，真实链路不会解析上游端点。
export async function resolveOffPeakMockUpstream(deps: {
  credentialService: OffPeakCredentialResolverDeps["credentialService"];
  accountRequestAuthService: OffPeakCredentialResolverDeps["accountRequestAuthService"];
  resolveAccountProvider: OffPeakCredentialResolverDeps["resolveAccountProvider"];
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; headers: Record<string, string> }> {
// 强制 allowMockCredentials=false，避免用占位凭证去代理真实上游。
  const credentials = await resolveOffPeakCredentials(deps, {
    // mock 自己的 placeholder 不能拿去代理上游；这里强制解析真实 selected connection。
    allowMockCredentials: false,
  });
// 没有 providerBaseURL 说明当前连接不是可代理的 coding plan。
  if (!credentials.providerBaseURL) {
    throw new Error("off-peak mock upstream requires a selected coding plan provider endpoint");
  }
  return {
    url: `${credentials.providerBaseURL.replace(/\/$/, "")}/v1/messages`,
    headers: {
      "x-api-key": credentials.codingPlanApiKey,
      authorization: `Bearer ${credentials.codingPlanApiKey}`,
    },
  };
}

/**
 * origin 解析器（memoized）：mock 模式懒启动进程内网关（固定端口，多实例经 EADDRINUSE
 * 复用同一份票据状态），真实模式指向 zcode API origin。node 服务装配与 host 派发两侧
 * 各持一个解析器也安全——谁先绑定谁持有网关，另一方外部复用。
 */
// origin 只解析一次，失败后清空缓存允许下次重试。
export function createOffPeakOriginResolver(deps: {
  logger: ServiceLogger;
  resolveUpstream: () => Promise<{ url: string; headers: Record<string, string> }>;
  env?: NodeJS.ProcessEnv;
}): { resolveOrigin: () => Promise<string>; close: () => Promise<void> } {
  const env = deps.env ?? process.env;
// closeGateway 只保存本进程真正绑定的网关，外部复用时不关闭。
  let originPromise: Promise<string> | null = null;
  let closeGateway: (() => Promise<void>) | null = null;
  return {
    resolveOrigin: () => {
      if (!originPromise) {
        originPromise = (async () => {
// 非 mock 模式直接用运行时 API origin，不启动本地网关。
          if (!isOffPeakMockEnabled(env)) {
            return new URL(buildRuntimeZCodeApiUrl(env, "/")).origin;
          }
          const gateway = await startOffPeakMockGateway({
            logger: deps.logger,
            resolveUpstream: deps.resolveUpstream,
          });
// external 表示端口已被其它实例占用，关闭责任不在本实例。
          if (!gateway.external) closeGateway = gateway.close;
          return gateway.origin;
// catch 挂在 IIFE 上，保证 reject 后缓存能被清空。
        })().catch((error) => {
// 失败必须清缓存，否则后续调用会一直拿到同一个 rejected promise。
          originPromise = null; // 失败后允许重试（如端口短暂占用）
          throw error;
        });
      }
      return originPromise;
    },
    close: async () => {
      const close = closeGateway;
      closeGateway = null;
      if (close) await close();
    },
  };
}
