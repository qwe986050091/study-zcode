import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountProviderUnavailableReason,
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import {
  type ApiClient,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  CodingPlanAvailabilityProvider,
  CodingPlanAvailabilityResult,
  CodingPlanUnavailableReason,
} from "#src/model-provider/codingPlanProviderAvailability.js";
import {
  validateBigModelAccountProviderAvailability,
  validateZaiAccountProviderAvailability,
} from "#src/model-provider/codingPlanProviderAvailability.js";

// unresolvedFamilies 是「Host 旧连接导入尚不能确定身份」的运行时标记：只影响付费访问判定，不写入配置。
export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Host 旧连接导入尚不能确定身份；仅运行时事实，不写入配置或协议。 */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderFamilyAvailabilityInput {
  readonly family: ProviderFamilyDomain;
  readonly providers: readonly CodingPlanAvailabilityProvider[];
  readonly selections: ProviderFamilyConnectionSelectionSettings;
}

export type AccountProviderFamilyAvailabilityResolver = (
  input: AccountProviderFamilyAvailabilityInput,
) => Promise<Partial<Record<string, CodingPlanAvailabilityResult>>>;

// 四个注入点：设置读取、Coding Plan Key 加载、账号身份、family 级权益解析；
// 本文件不直接访问凭据或网络，测试可整体替换。
export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadCodingPlanApiKey: (
    providerId: string,
    family: ProviderFamilyDomain,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => Promise<string | null>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveFamilyAvailability: AccountProviderFamilyAvailabilityResolver;
}

export interface CodingPlanFamilyAvailabilityResolverOptions {
  readonly apiClient: ApiClient;
  readonly credentialService?: {
    load(key: string): Promise<string | null>;
  };
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * off-peak 与 highspeed 都不是独立套餐，而是「已连接的个人/团队 Coding Plan」派生出的
 * 执行入口：请求期鉴权分别来自 ticket 与加速卡 JWT，本身没有可校验的套餐 Key。
 * 因此它们既不进入 Coding Plan availability 校验，也不按 selection.kind 直接比对模式。
 */
// off-peak/highspeed 没有自己的 Key，权益跟随当前选中的个人/Team 套餐，因此不直接比对 mode。
function isCodingPlanDerivedMode(mode: string | undefined): mode is "off-peak" | "highspeed" {
  return mode === "off-peak" || mode === "highspeed";
}

/**
 * 把现有账号域、连接模式和套餐权益统一投影为领域层 Connection Result。
 *
 * 该适配器不保存凭据。Personal Coding Plan Key 的物理来源由注入端决定；
 * Start/Team 的动态凭据继续由现有 availability 依赖按请求读取。
 */
// 返回闭包并在闭包内保存 previousScopes：resetPrevious 需要跨轮次比较作用域，
// 只能由解析器实例自己记忆。
// 每轮都从 settings 重新开始，不缓存任何账号事实。
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
// [并发] previousScopes 记录上一轮「已成功发布」的作用域；只在发布检查通过后才更新，
// 否则失败轮次会把未发布的账号误认为 last-known-good。
// 作用域包含账号身份与 Team 身份，切账号/切 Team 都会触发 resetPrevious。
  let previousScopes = new Map<string, string>();
  return async ({ configuredProviders, reasons = [] }) => {
// clone 一次固定本轮快照：后续多次比较都基于同一份值，不受并发写设置影响。
    const settings = structuredClone(await options.readSettings());
    const forceCredentialRefresh = reasons.some(isCredentialRefreshReason);
// [并发] 同一 family 的身份只查一次：scope、connectionKey、current 都复用同一个 Promise，
// 避免一轮内多次读钥匙串并出现「同一轮身份不一致」。
    const accountIdentityByFamily = new Map<ProviderFamilyDomain, Promise<string | null>>();
    const loadAccountIdentity = (family: ProviderFamilyDomain) => {
      const existing = accountIdentityByFamily.get(family);
      if (existing) return existing;
      const pending = options.loadAccountIdentity(family).then((identity) => {
        const normalized = identity?.trim() ?? "";
        return normalized || null;
      });
      accountIdentityByFamily.set(family, pending);
      return pending;
    };
// 第一轮先把所有账号 Provider 的权益查清，第二轮再投影成连接结果，避免边查边发。
    const availabilityByProviderId = new Map<string, CodingPlanAvailabilityResult>();

// 两个 family 的权益查询互不依赖，但按顺序处理：family 内部的三类 Provider 查询本身已并发。
    for (const family of ["zai", "bigmodel"] as const) {
// 只挑出「账号 Provider 且不是派生入口」的配置：派生入口没有独立权益，不能参与查询。
// planKind 取自静态配置的 mode，不是用户当前选择。
      const configured = configuredProviders
        .entries()
        .flatMap(([providerId, config]) =>
          config.access?.type === "zhipu-account" &&
          config.access.accountType === family &&
          config.access.mode &&
          !isCodingPlanDerivedMode(config.access.mode)
            ? [{ providerId, config, planKind: config.access.mode }]
            : [],
        );
      if (configured.length === 0) continue;

      // 旧团队身份补全只限制付费访问，Start 只依赖当前登录账号。
// 旧团队身份未确定时，除 Start 外的付费访问一律标 unknown 并跳过查询，
// 避免用错误的 Team 身份去问后端。
      const queryable = configured.filter(({ providerId, planKind }) => {
        if (settings.unresolvedFamilies?.includes(family) && planKind !== "start-plan") {
          availabilityByProviderId.set(providerId, { kind: "unknown" });
          return false;
        }
        return true;
      });
      if (queryable.length === 0) continue;

      const accountIdentity = await loadAccountIdentity(family);
// 未登录时不查询也不缓存 unknown：直接按 not_connected 发布，让 UI 引导登录。
      if (!accountIdentity) {
        for (const { providerId } of queryable) {
          availabilityByProviderId.set(providerId, {
            kind: "unavailable",
            reason: "coding_plan_not_connected",
          });
        }
        continue;
      }

// Team 套餐不在这里取 Key：Team 的动态凭据由 family resolver 按请求读取，
// 提前加载会拿到过期 ticket。
      const availabilityProviders = await Promise.all(
        queryable.map(async ({ providerId, planKind }) => ({
          providerId,
          family,
          planKind,
          apiKey:
            planKind !== "team-coding-plan"
              ? await options
                  .loadCodingPlanApiKey(providerId, family, accountIdentity, forceCredentialRefresh)
                  .catch(() => null)
              : null,
        })),
      );
      const resolved = await options.resolveFamilyAvailability({
        family,
        providers: availabilityProviders,
        selections: settings.selections,
      });
      for (const { providerId } of queryable) {
        availabilityByProviderId.set(providerId, resolved[providerId] ?? { kind: "unknown" });
      }
    }

// 第二轮遍历按配置顺序生成连接结果；scopes 与 connections 必须同序，便于与上一轮作用域比对。
    const connections: AccountProviderConnectionResult[] = [];
    const scopes = new Map<string, string>();
    for (const [providerId, config] of configuredProviders.entries()) {
      const access = config.access;
      if (access?.type !== "zhipu-account") continue;
// 缺少 accountType/mode 是历史或损坏配置：标 unavailable 但不给原因，由 UI 提示重新选择。
      if (!access.accountType || !access.mode) {
        connections.push({ providerId, status: "unavailable" });
        continue;
      }
      const selection = settings.selections[access.accountType];
      // last-known-good 只对同账号、同 Team 身份成立。切账号后的网络失败不能复活旧权益。
// 读 `lastKnownGood` 前必须先用当前身份比对，切账号后的网络失败不得复活旧权益。
// 派生入口跟随当前套餐，作用域必须包含完整 Team 身份，否则母体 fail-closed 而派生入口仍可用。
      const scope = JSON.stringify([
        await loadAccountIdentity(access.accountType),
        // 派生入口跟随当前套餐；它的 last-known-good 作用域也必须包含完整 Team 身份。
        // 否则切 Team 后母体会 fail-closed，派生入口却可能沿用旧 Team 权益。
        (access.mode === "team-coding-plan" || isCodingPlanDerivedMode(access.mode)) &&
        selection?.kind === "team-coding-plan"
          ? [selection.organizationId, selection.projectId, selection.productId]
          : null,
      ]);
      scopes.set(providerId, scope);
      const resetPrevious =
        previousScopes.has(providerId) && previousScopes.get(providerId) !== scope;
// 派生入口没有自己的可用性结果，只能借用「当前选中套餐」对应母体的结果。
// 找不到母体（例如刚切走）时给 unavailable 而不是 unknown：此时确实没有可执行权益。
// entitlementSourceProviderId 随结果发布，UI 用它解释权益来自哪个套餐。
      if (isCodingPlanDerivedMode(access.mode)) {
        const selectedPlanKind = selection?.kind;
        const entitlementSource =
          settings.providerFamilyDomain === access.accountType &&
          (selectedPlanKind === "individual-coding-plan" || selectedPlanKind === "team-coding-plan")
            ? configuredProviders
                .entries()
                .find(
                  ([, candidate]) =>
                    candidate.access?.type === "zhipu-account" &&
                    candidate.access.accountType === access.accountType &&
                    candidate.access.mode === selectedPlanKind,
                )
            : undefined;
        const sourceProviderId = entitlementSource?.[0];
        const availability = sourceProviderId
          ? (availabilityByProviderId.get(sourceProviderId) ?? { kind: "unknown" as const })
          : undefined;
        connections.push({
          providerId,
          status: availability?.kind ?? "unavailable",
          ...(sourceProviderId ? { entitlementSourceProviderId: sourceProviderId } : {}),
          ...(resetPrevious ? { resetPrevious: true } : {}),
        });
        continue;
      }
      const availability = availabilityByProviderId.get(providerId) ?? {
        kind: "unknown" as const,
      };
      connections.push({
        providerId,
// 直接沿用 kind 作为连接状态：available/pending/unavailable/unknown 在领域层一一对应。
// 原因只在 unavailable 时附带，available 时携带 models/effectiveAt。
        status: availability.kind,
        // 原因必须随连接结果一起发布。UI 拿不到原因时只能把"已登录但无套餐"
        // 也显示成"未连接"。
        ...(availability.kind === "unavailable"
          ? {
              unavailableReason: resolveAccountUnavailableReason(availability.reason),
            }
          : {}),
        // Start 跟随登录身份，付费套餐跟随连接选择；两者可同时 current，不改写权益或配置。
// current 表示「该 Provider 是否对应当前选择」：Start 跟随登录身份，付费套餐跟随连接选择。
// 判定不修改权益也不写配置，只是视图投影。
        current:
          settings.providerFamilyDomain === access.accountType &&
          (access.mode === "start-plan"
            ? Boolean(await loadAccountIdentity(access.accountType))
            : selection?.kind === access.mode),
        // 两个 Team 共用 Provider ID，观察器必须按同一快照中的完整身份比较，
        // 不能把手动换套餐/账号误当成原套餐失效。它只进入 Account State，不进入 Config。
// [并发] connectionKey 在同一快照内组合账号身份 + family + 选择，
// 观察器据此判断「是否只是手动换套餐/账号」，不会把切换误判成原套餐失效。
// 结果只进入 Account State，不进入 Config，避免把运行时事实持久化。
        connectionKey: createHash("sha256")
          .update(
            JSON.stringify([
              await loadAccountIdentity(access.accountType),
              access.accountType,
              access.mode === "start-plan" ? { kind: "start-plan" } : (selection ?? null),
            ]),
          )
          .digest("hex"),
        ...("models" in availability ? { models: availability.models } : {}),
        ...("effectiveAt" in availability ? { effectiveAt: availability.effectiveAt } : {}),
        ...(resetPrevious ? { resetPrevious: true } : {}),
      });
    }
    // 权益查询可能跨越切账号/套餐，旧设置与新身份会被拼成可发布结果。
    // 发布前核对本轮作用域；失败时也不能推进 previousScopes，否则下一轮会把
    // 未发布的账号误认作 last-known-good。重试继续由现有刷新事件驱动。
// [并发] 权益查询可能跨越切账号/切套餐，旧设置与新身份会被拼成可发布结果；
// 发布前逐个 family 重新读身份并与本轮捕获值比对。
// `identitiesUnchanged` 必然多发一次读取，但每轮只在末尾一次，成本可控。
    const identitiesUnchanged = await Promise.all(
      [...accountIdentityByFamily].map(
        async ([family, captured]) =>
          (await captured) === ((await options.loadAccountIdentity(family))?.trim() || null),
      ),
    );
    if (
// [失败路径] 身份或设置任一变化就抛错丢弃整轮结果，由刷新事件驱动重试。
// 此时不能推进 previousScopes，否则下一轮会把未发布的账号当成 last-known-good。
      identitiesUnchanged.some((unchanged) => !unchanged) ||
      !isDeepStrictEqual(settings, await options.readSettings())
    ) {
      throw new Error("账号查询期间连接或身份发生变化，丢弃过期结果");
    }
// 只有通过全部一致性检查后才更新作用域记忆：这是 resetPrevious 正确性的前提。
// scopes 只包含本轮实际产出的 providerId，被跳过的 provider 不会残留旧作用域。
    previousScopes = scopes;
    return Object.freeze(connections);
  };
}

// ProviderSettingsFacade 会给登录刷新原因加 settings: 前缀，因此按末段精确匹配；
// 漏匹配会在同账号重新登录后继续复用失效 Key。
function isCredentialRefreshReason(reason: string): boolean {
  // ProviderSettingsFacade 会给登录刷新原因添加 settings: 前缀；漏匹配会在
  // 同账号重新登录后继续复用失效 Key。按原因末段精确匹配，普通刷新仍复用缓存。
  return (
    reason.includes("oauth-callback") || reason.split(":").at(-1) === "oauth-login-entitlement"
  );
}

/**
 * 把 Coding Plan 可用性原因投影为账号域原因。
 * Account State 是跨 family 的通用事实，不直接沿用 Coding Plan 内部枚举；
 * UI 只依赖这里的稳定语义，不认识套餐查询实现。
 */
function resolveAccountUnavailableReason(
  reason: CodingPlanUnavailableReason,
): AccountProviderUnavailableReason {
  switch (reason) {
    case "coding_plan_not_authenticated":
      return "not-authenticated";
    case "coding_plan_not_connected":
      return "not-connected";
    case "coding_plan_auth_failed":
      return "credential-failed";
    case "coding_plan_not_entitled":
      return "not-entitled";
  }
}

/** 组装 Config、账号连接解析与第三层 Account Provider Config Source。 */
// 把连接解析器注入 AccountProviderService：Config 与 Account 合并后作为第三层 Source。
// `createAccountProviderConfigSource` 只组装依赖，不持有凭据。
// 返回类型是 AccountProviderService（ProviderSource 子类型），直接作为 Registry 的 accountSource。
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/** 用当前稳定的 Plan 查询实现生产 Family Availability Port。 */
export function createCodingPlanFamilyAvailabilityResolver(
  options: CodingPlanFamilyAvailabilityResolverOptions,
): AccountProviderFamilyAvailabilityResolver {
  return ({ family, providers, selections }) => {
    const context = {
      apiClient: options.apiClient,
      credentialService: options.credentialService,
      providerFamilyConnectionSelections: selections,
    };
    return family === "zai"
      ? validateZaiAccountProviderAvailability(providers, context)
      : validateBigModelAccountProviderAvailability(providers, context);
  };
}

/**
 * 把 Active Model 的静态 Access 约束投影到当前账号连接。
 *
 * Team scope 和账号版本不能冻结进 Model：账号切换后旧 Model 会错误失效。
 * 每次请求重新读取当前选择；只有 family 与 mode 兼容时才返回动态访问事实。
 */
// Team scope 与账号版本不能冻结进 Model：账号切换后旧 Model 会错误失效，因此每次请求重算。
// 前置条件：settings.providerFamilyDomain 必须等于 Model 声明的 accountType，否则返回 null。
// [失败路径] 返回 null 而不是抛错：调用方解释为「账号能力不可用」，回落到静态配置。
// 校验顺序固定为 family → mode/selection → 登录身份，保证错误归因稳定。
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
// Start Plan 只依赖当前登录身份，不看连接选择：领取后即生效，无需 team/project scope。
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (isCodingPlanDerivedMode(mode)) {
// 派生入口要求当前选择是个人或 Team Coding Plan：选中其它套餐时没有可借用的母体。
    if (selection.kind !== "individual-coding-plan" && selection.kind !== "team-coding-plan") {
      return null;
    }
  } else if (selection.kind !== mode) {
    return null;
  }
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
// 仅 Team 下发 organizationId/projectId/productId；个人套餐不带 scope，防止团队身份泄漏给个人请求。
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
