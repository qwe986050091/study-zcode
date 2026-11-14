// INV-01 判别联合：守住位置 ConnectionResult；改错故障：不可用分支被读到可用字段。
// INV-02 本轮重置：守住位置 resetPrevious；改错故障：身份变化后仍沿用旧权益快照。
// INV-03 母体继承：守住位置 entitlementSourceProviderId；改错故障：派生入口自带第二份权益判断。
// INV-04 索引一次：守住位置 connectionByProviderId；改错故障：同一连接被两处解释成不同状态。
// INV-05 单次求值：守住位置 states 缓存；改错故障：派生链重复计算母体状态。
// INV-06 读取母体终态：守住位置 inheritedState；改错故障：直接读原始可用性，同轮状态分裂。
// INV-07 未知保留事实：守住位置 unknown 分支；改错故障：网络抖动把已展示权益清空。
// INV-08 当前态不复活：守住位置 current 赋值；改错故障：旧连接凭 last-known-good 复活。
// INV-09 冻结输出：守住位置 状态与结果对象；改错故障：调用方原地改写共享配置。
// INV-10 入参校验：守住位置 indexConnections；改错故障：重复或越界连接在深处才爆。
// INV-11 自继承拒绝：守住位置 来源等于自身；改错故障：递归解析无限展开。
// INV-12 母体必须配置：守住位置 来源存在性检查；改错故障：继承到空配置，权益被静默清零。
// INV-13 循环检测：守住位置 resolving 集合；改错故障：A 与 B 互继承时栈溢出。
// INV-14 非账号跳过：守住位置 access 类型判断；改错故障：API Key Provider 被账号逻辑覆盖。
// INV-15 空模型权威：守住位置 开始套餐分支；改错故障：失效白名单被旧配置带回。
// INV-16 无连接即未知：守住位置 缺省连接构造；改错故障：未上报 Provider 被判成无权益。
// INV-17 模型去空：守住位置 normalizeModelIds；改错故障：空白模型标识进入配置。
// INV-18 冻结模型表：守住位置 模型数组；改错故障：下游排序时修改共享数组。
//
// 模块职责：把账号连接结果解析成 Registry 使用的 Provider 配置与状态。
// 状态所有权：上一轮配置与状态由外部持有；本模块只读并产出冻结结果。
// 阅读顺序：结果类型 → 输入 → 解析器 → 状态求值 → 配置求值 → 索引与校验。
import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderId,
} from "./config/index.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

// AccountProviderConnectionResult 是判别联合：不可用分支带 reason，可用分支才带 connectionKey 与 effectiveAt。
// resetPrevious 只在本次 resolve 内生效，落盘前被剔除，不会进入配置文件。
// entitlementSourceProviderId 指向母体 Provider，派生入口发布时读母体的最终权益而不是自己的。
//
export type AccountProviderConnectionResult = {
  /** 账号/组织身份变化后禁止沿用旧快照；仅用于本轮解析，不进入配置。 */
  readonly resetPrevious?: boolean;
  /** 派生执行入口不拥有独立权益，发布时继承该母体 Provider 的最终权益。 */
  readonly entitlementSourceProviderId?: ProviderId;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** 仅在 status === "unavailable" 时携带；unknown 表示本轮无法判定原因。 */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

// 上一轮配置是 last-known-good 的来源，缺它无法做未知态回退。
// 连接结果顺序不参与语义，按标识索引后使用。
//
export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

// 解析器先取连接，再据此派生配置与状态。
// 返回的配置与状态都冻结，调用方不可原地改写。
//
export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    // 连接先建索引，重复与非法指向在索引阶段就抛错。
    // 状态与配置共用同一索引，避免两份解释。
    // 状态表按 Provider 标识累积，派生链复用同一结果。
    //
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
    const states: Record<string, AccountProviderState> = {};
    const connectionByProviderId = indexConnections(input.configuredProviders, connections);
    // 同一 Provider 的状态只计算一次，派生入口可安全复用。
    // 重置时丢弃旧状态，避免身份变化后沿用旧快照。
    // 派生入口必须读母体最终状态，不能自己再判一次权益。
    // 未知态保留上次展示事实，当前态始终以本轮为准。
    // 可用性优先继承母体，其余分支按连接状态落值。
    //
    const resolveState = (connection: AccountProviderConnectionResult): AccountProviderState => {
      const existing = states[connection.providerId];
      if (existing) return existing;
      const previous = connection.resetPrevious
        ? undefined
        : input.previousStates?.[connection.providerId];
      const access = providers.get(connection.providerId)?.access;
      const sourceId = connection.entitlementSourceProviderId;
      const sourceConnection = sourceId ? connectionByProviderId.get(sourceId) : undefined;
      // Bug 根因：派生入口曾直接消费母体原始 availability，把 unknown 硬判为无权益；
      // 母体却在这里沿用 last-known-good，导致同轮 Registry 状态分裂。派生状态必须读取母体
      // 应用身份隔离与 last-known-good 后的最终发布事实，不能再维护第二份权益判断。
      const inheritedState = sourceConnection ? resolveState(sourceConnection) : undefined;
      // unknown 仅保留上次展示事实；current 始终来自本轮选择，不能复活旧连接。
      const unavailableReason = inheritedState
        ? inheritedState.unavailableReason
        : connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
      const availability = inheritedState
        ? inheritedState.entitled
          ? "available"
          : "unavailable"
        : connection.status === "unknown" && previous
          ? previous.availability
          : connection.status;
      const state = Object.freeze({
        ...(connection.status === "unknown" && !inheritedState ? previous : {}),
        availability,
        entitled: access?.type === "zhipu-account" && access.entitled === true,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ...(connection.current === undefined ? {} : { current: connection.current }),
        connectionKey: connection.connectionKey,
        ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
      });
      states[connection.providerId] = state;
      return state;
    };
    for (const connection of connections) resolveState(connection);
    return Object.freeze({ providers, states: Object.freeze(states) });
  };
}

/** 把账号连接结果转换为 Registry 使用的第三层 Account Provider Config。 */
// 只处理受账号约束的 Provider，其余原样跳过。
// resolveAccountProviderConfigs 用访问栈记录已展开的 ProviderId，重复进入即抛循环引用错误。
//
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolvedByProviderId = new Map<ProviderId, ProviderConfig>();
  const resolving = new Set<ProviderId>();
  // 命中缓存直接返回，链式继承不会重复构造。
  // 非账号 Provider 返回未定义，不进入结果表。
  // 开始套餐分支保留显式空模型，不能回退旧白名单。
  //
  const resolveProvider = (providerId: ProviderId): ProviderConfig | undefined => {
    const existing = resolvedByProviderId.get(providerId);
    if (existing) return existing;
    const configured = input.configuredProviders.get(providerId);
    if (!configured || configured.access?.type !== "zhipu-account") return undefined;
    if (resolving.has(providerId)) {
      throw new Error(`Account Provider 权益继承存在循环: ${providerId}`);
    }
    resolving.add(providerId);
    const connection = connectionByProviderId.get(providerId) ?? {
      providerId,
      status: "unknown" as const,
    };
    let resolved: ProviderConfig;
    if (connection.entitlementSourceProviderId) {
      const source = resolveProvider(connection.entitlementSourceProviderId);
      // 派生入口只继承母体本轮最终 Overlay。母体 unknown 已在上面的普通分支应用
      // last-known-good；母体身份变化时 resetPrevious 会先清掉旧权益，因此这里不会复活旧 Team。
      resolved = createEntitlementOverlay(
        source?.access?.type === "zhipu-account" && source.access.entitled === true,
      );
    } else if (connection.status === "available" || connection.status === "pending") {
      if (configured.access.mode === "start-plan") {
        resolved = new ProviderConfig({
          // 明确空模型是本轮权威结果，不能保留已经失效的旧白名单。
          access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
          builtinModelIds: normalizeModelIds(connection.models),
        });
      } else {
        resolved = createEntitlementOverlay(connection.status === "available");
      }
    } else if (connection.status === "unavailable") {
      resolved = createEntitlementOverlay(false);
    } else {
      resolved =
        (connection.resetPrevious ? undefined : input.previousProviders.get(providerId)) ??
        createEntitlementOverlay(false);
    }
    resolving.delete(providerId);
    resolvedByProviderId.set(providerId, resolved);
    return resolved;
  };

  const resolved: Array<readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId, configured] of input.configuredProviders.entries()) {
    if (configured.access?.type !== "zhipu-account") continue;
    const provider = resolveProvider(providerId);
    if (provider) resolved.push([providerId, provider]);
  }
  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(entitled: boolean): ProviderConfig {
  return new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`重复 Account Provider 连接结果: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(`Account 连接指向未配置 Provider: ${connection.providerId}`);
    }
    if (!isAccountConstrainedProvider(configured)) {
      throw new Error(`Account 连接指向非 Account Provider: ${connection.providerId}`);
    }
    const sourceId = connection.entitlementSourceProviderId;
    if (sourceId === connection.providerId) {
      throw new Error(`Account Provider 不能继承自身权益: ${connection.providerId}`);
    }
    if (sourceId && !configuredProviders.get(sourceId)) {
      throw new Error(`Account Provider 权益母体未配置: ${connection.providerId} -> ${sourceId}`);
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function isAccountConstrainedProvider(config: ProviderConfig): boolean {
  return config.access?.type === "zhipu-account";
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
