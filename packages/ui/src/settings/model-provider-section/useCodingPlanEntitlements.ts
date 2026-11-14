// 本文件是设置页套餐权益的唯一派生层：把 provider 配置、连接选择与账号 Access 收敛成四个 provider 的额度状态和一个刷新入口。
// 所有查询开关都由指纹决定，调用方只需提供配置与选择，不应自行判断某个套餐该不该查。
// INV-01 权益查询的 provider 身份由 selection.kind 决定团队或个人套餐；守住位置：useProviderFamilyEntitlements 的 codingPlanProviderId 派生；改错故障：团队用户看到个人套餐额度，或额度卡片指向错误的订阅。
// INV-02 只有解析出 Account Access 才能发起 coding 查询，空指纹等于禁用；守住位置：registryFingerprint 与 codingEnabled 的派生；改错故障：无权限账号发出必然失败的请求，或在无身份时展示 0 额度。
// INV-03 cache identity 必须同时包含 Registry revision 与执行期账号上下文；守住位置：codingFingerprint 的拼接处；改错故障：切换团队或项目后复用上一项目的额度缓存，出现串号。
// INV-04 start 计划是否可查由 buildStartPlanEntitlementOptions 的 enabled 决定，不用 provider id 猜测；守住位置：startProviderFingerprint 与 startEnabled；改错故障：未开通 start 计划的账号反复请求，界面停在加载态。
// INV-05 团队套餐的展示查询不能退化成执行期 current 解析；守住位置：resolveEntitlementAccountAccess 的 team 分支；改错故障：团队权益被另一套餐的账号身份覆盖，额度显示错乱。
// INV-06 自动刷新决策必须是纯函数，同一输入只能得到一个结论；守住位置：resolveCodingPlanProviderFingerprintAutoRefresh；改错故障：刷不刷新取决于渲染次数，出现间歇性重复请求。
// INV-07 provider 配置尚未加载时不做自动刷新；守住位置：决策函数的 loading 分支；改错故障：页面首次打开就带着空配置请求，得到一次无效快照。
// INV-08 被抑制期间记下的指纹要再抵挡一次，随后清空记忆放行；守住位置：skippedProviderFingerprint 的比较与清空；改错故障：保存 provider 后额度不更新，用户必须手动刷新。
// INV-09 抑制开关命中时要记住当前指纹，避免开关关闭后立刻补一次刷新；守住位置：suppressAutoRefresh 分支；改错故障：关闭抑制的瞬间触发一轮本不该有的套餐与余额请求。
// INV-10 自动刷新必须 force 且 silent，reason 固定为 auth；守住位置：第二个 useEffect 内的 refresh 调用；改错故障：走缓存拿回旧快照，或静默刷新弹出全局加载遮罩。
// INV-11 跳过记忆存放在 ref，不参与渲染；守住位置：skippedProviderFingerprintAutoRefreshRef；改错故障：写 ref 触发额外渲染，或卸载后仍尝试写状态。
// INV-12 每个 family 的权益对象必须引用稳定，依赖数组逐字段列出；守住位置：useProviderFamilyEntitlements 的 useMemo 依赖；改错故障：等价权益事实每次都变，Provider 设置页陷入 access refresh 循环。
// INV-13 两个 Family 必须按固定顺序无条件调用，不能按键遍历；守住位置：useCodingPlanEntitlements 顶部的 zai 与 bigmodel 调用；改错故障：Hook 顺序随数据变化，触发 React 运行时错误。
// INV-14 刷新要并行发出，任一路失败不应让其它请求被取消；守住位置：refresh 内的 refreshJobs 与 Promise.all 汇总；改错故障：串行等待导致首屏额度出现明显延迟。
// INV-15 未启用的 start 计划在投影里统一降级为 null 与 false；守住位置：entitlements 映射中的 start 字段；改错故障：上游残留快照被当成有效额度展示。
// INV-16 enabledStartPlanProviderIds 只包含真正可查的 provider；守住位置：返回对象的该字段；改错故障：上层对不可查 provider 发请求或渲染空卡片。
// INV-17 选中套餐变化时只静默刷新 access，不改变 loading 投影；守住位置：useCodingPlanAccessRefresh 的 effect；改错故障：切换套餐时整块额度区域闪一次骨架屏。
// INV-18 聚合指纹用分隔符拼接并过滤空值；守住位置：providerFingerprint 的 useMemo；改错故障：不同家族组合拼出同一字符串，指纹碰撞导致漏刷新。
// INV-19 命中加载态或空指纹时立即返回，不得越过分支继续写记忆；守住位置：决策函数的首个分支；改错故障：空配置把跳过记忆写成空串，后续真实指纹被误跳。
// INV-20 返回的状态映射键必须来自 family spec，不硬编码 provider id；守住位置：返回 useMemo 的键构造；改错故障：spec 调整后映射键失效，额度卡永远读不到状态。
//
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProviderSettingsView } from "@zcode/services";
import {
  getModelProviderFamilySpec,
  type ModelProviderFamilySpec,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
// 四条导入各自承担不同职责：start 计划选项构造、React 原语、服务层视图类型、Account Access 解析。
// 类型导入与运行时依赖混排在同一段，新增依赖时按外部包、内部模块两段追加。
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";

// 把是否该自动刷新抽成纯函数，是为了让跳过逻辑能被单测直接覆盖，不必渲染 Hook。
// 函数只读入参并返回新状态，调用方负责把返回的 skippedProviderFingerprint 写回 ref。
export function resolveCodingPlanProviderFingerprintAutoRefresh({
  loading,
  providerFingerprint,
  skippedProviderFingerprint,
  suppressAutoRefresh,
}: {
  loading: boolean;
  providerFingerprint: string;
  skippedProviderFingerprint: string;
  suppressAutoRefresh: boolean;
}): {
  shouldRefresh: boolean;
  skippedProviderFingerprint: string;
} {
  // 加载中或还没有任何指纹时直接给否，避免拿空配置去请求后端。
  // 该分支不写跳过记忆，等真实指纹出现后才会进入后续判定。
  if (loading || !providerFingerprint) {
    return { shouldRefresh: false, skippedProviderFingerprint };
  }
  // 抑制开关命中时把当前指纹记为已跳过，否则开关一关就会补发一次刷新。
  // `resolveCodingPlanProviderFingerprintAutoRefresh` 记指纹而非布尔值，指纹变化后仍能触发。
  if (suppressAutoRefresh) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: providerFingerprint,
    };
  }
  // 抑制期记下的 `lastFingerprint` 再挡一次：随后清空记忆，同指纹下次放行。
  // 清空是关键：只清不跳会让抑制记录失效，只跳不清则让该指纹永远无法刷新。
  if (skippedProviderFingerprint === providerFingerprint) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: "",
    };
  }
  // 走到这里说明指纹是新的且未被抑制，需要刷新，同时清空跳过记忆。
  return { shouldRefresh: true, skippedProviderFingerprint: "" };
}

// 每个 Provider 家族各自持有一份 coding 与 start 权益，四个 provider 的查询互相独立。
// 家族内部只负责派生指纹与调用查询 Hook，不缓存也不合并快照。
function useProviderFamilyEntitlements(params: {
  familySpec: ModelProviderFamilySpec;
  selection: ProviderFamilyConnectionSelection | undefined;
  providerSettingsView: ProviderSettingsView | null;
}) {
  // 团队插件与个人插件指向不同的 provider id，因此先按 selection.kind 选择套餐身份。
  // 选择结果同时用于查询参数、缓存键和对外映射键，三处必须一致。
  const codingPlanProviderId =
    params.selection?.kind === "team-coding-plan"
      ? params.familySpec.teamCodingPlanProviderId
      : params.familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = params.familySpec.startPlanProviderId;
  // Account Access 决定当前账号能否查询这个套餐，解析不出时后续指纹一律为空。
  // 这里只做静态 Registry 解析，执行期上下文在下一步再叠加。
  const accountAccess = resolveAccountProviderInspectionAccess(
    params.providerSettingsView,
    codingPlanProviderId,
  );
  const startOptions = buildStartPlanEntitlementOptions(
    params.providerSettingsView,
    startPlanProviderId,
  );
  // 指纹包含 Registry revision，配置每变一次就换一个键，等价于强制重新查询。
  // 没有 Access 时直接给空串，让 enabled 自然变成否，不依赖额外判断。
  const registryFingerprint = accountAccess
    ? JSON.stringify([params.providerSettingsView?.revision, accountAccess])
    : "";
  const startProviderFingerprint = startOptions.enabled ? (startOptions.cacheKey ?? "") : "";
  // 团队套餐要把 product、org、project 一起带进查询身份，否则跨团队会复用别的缓存。
  // 非团队分支只补全 planKind，保持展示查询针对套餐自身。
  const entitlementAccess = resolveEntitlementAccountAccess(
    accountAccess?.access,
    params.selection,
  );
  // Team 查询身份还包含 product/org/project。只使用 Registry 静态 Access
  // 会让切换团队后复用上一项目的权益缓存，因此 cache identity 必须包含执行期账号上下文。
  const codingFingerprint = registryFingerprint
    ? JSON.stringify([registryFingerprint, entitlementAccess])
    : "";
  const codingEnabled = Boolean(codingFingerprint);
  const startEnabled = Boolean(startProviderFingerprint);
  // coding 查询关闭挂载即刷，由外层决定何时拉取，避免一次渲染打两轮请求。
  // requirePreferredProvider 与 allowEnvApiKey 一起约束：只认套餐账号，不偷偷回落到环境变量里的 API Key。
  // cacheKey 由 provider id 加指纹构造，指纹一变缓存自然失效。
  // includeSubscription 打开订阅维度，额度与订阅状态一次取回。
  const coding = useUsageEntitlement({
    enabled: codingEnabled,
    refreshOnMount: false,
    includeSubscription: true,
    preferredProviderId: codingPlanProviderId,
    accountAccess: entitlementAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: codingPlanProviderId,
      providerFingerprint: codingFingerprint,
    }),
  });
  const start = useUsageEntitlement(startOptions);

  return useMemo(
    () => ({
      coding,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    }),
    // Family 编排重构后这里每次渲染都返回新对象，导致上层等价权益事实
    // 因此依赖数组按字段展开，覆盖 loading、error、snapshot 与 refresh 四类出口。
    // 少列一个字段会漏掉状态更新，整体依赖对象则会退回到每次渲染都换引用的老问题。
    // 失去引用稳定性，并把套餐状态更新放大成 Provider 设置页的 access refresh 循环。
    [
      coding.error,
      coding.loading,
      coding.refresh,
      coding.snapshot,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start.error,
      start.loading,
      start.refresh,
      start.snapshot,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    ],
  );
}

// 这个函数只处理查询身份：把 Registry 静态 Access 与当前选择拼成可用的账号上下文。
// 返回值既可能是 provider 级 Access，也可能是账号级 Access，调用方按字段读取即可。
function resolveEntitlementAccountAccess(
  access: ZCodeProviderAccountAccess | undefined,
  selection: ProviderFamilyConnectionSelection | undefined,
): ZCodeProviderAccountAccess | ZCodeAccountAccess | undefined {
  if (access?.mode !== "team-coding-plan" || selection?.kind !== "team-coding-plan") {
    // 展示查询针对这个套餐自身，不让执行期的 current 解析器改成当前另一套餐。
    return access && (access.mode === "start-plan" || access.mode === "individual-coding-plan")
      ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
      : access;
  }
  return {
    type: "zhipu-account",
    family: access.accountType,
    planKind: "team-coding-plan",
    productId: selection.productId,
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

// 选中套餐变化时刷新一次 Account Access，这是用户主动切换套餐的唯一入口。
// effect 内不保存任何派生状态，只把选择身份当作触发器。
export function useCodingPlanAccessRefresh({
  refresh,
  selectedPlanKey,
}: {
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
  selectedPlanKey: string | null;
}): void {
  // effect 只依赖稳定的选择身份，套餐为 null 时直接返回，不发请求。
  // 刷新以 silent 方式发出，用户只看到额度数字变化，不会看到整页 loading。
  useEffect(() => {
    if (!selectedPlanKey) {
      return;
    }
    // 原 effect 依赖整个 selectedNavItem，额度和 loading 的投影变化也会
    // 被误判为用户重新打开套餐。这里只响应稳定的套餐选择身份。
    void refresh({ silent: true, reason: "access" });
  }, [refresh, selectedPlanKey]);
}

// 这是设置页对外唯一入口：读入配置与选择，返回四个 provider 的权益状态和一个刷新函数。
// 选择默认空对象，调用方可以只传关心的家族，未传的家族按未启用处理。
// suppress 开关只在特定流程中打开，例如保存与连接方式同步期间。
export function useCodingPlanEntitlements({
  providerSettingsView,
  connectionSelections = {},
  suppressProviderFingerprintAutoRefresh = false,
}: {
  providerSettingsView: ProviderSettingsView | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  /** 当前具备 Account Access、能够独立查询权益的 Start Plan Provider。 */
  enabledStartPlanProviderIds: string[];
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
} {
  // 跳过记忆放在 ref 里，写入不触发渲染，也不会在卸载后留下待处理的状态更新。
  // 初值空串表示从未跳过任何指纹，首次真实指纹会正常触发刷新。
  const skippedProviderFingerprintAutoRefreshRef = useRef("");
  const loading = providerSettingsView === null;
  // React Hook 必须保持固定调用顺序，因此显式调用两个 Family，而不是动态遍历 Spec。
  const zaiFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("zai"),
    selection: connectionSelections.zai,
    providerSettingsView,
  });
  const bigmodelFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("bigmodel"),
    selection: connectionSelections.bigmodel,
    providerSettingsView,
  });

  // 刷新入口汇总两个家族共四个查询：全部并行发出，一次 `Promise.all` 收口。
  // 依赖里只放每个查询的 refresh 与 enabled，家族对象本身不参与，避免引用变化导致回调重建。
  // 回调返回汇总后的 Promise，调用方可以等待，也可以按需忽略。
  const refresh = useCallback(
    (options: UsageEntitlementRefreshOptions = {}) => {
      // Start/Coding 使用独立 provider id 与 cache key；两边都可用时并行刷新。
      const refreshJobs: Array<Promise<void>> = [];
      if (zaiFamily.codingEnabled) {
        refreshJobs.push(zaiFamily.coding.refresh(options));
      }
      if (zaiFamily.startEnabled) {
        refreshJobs.push(zaiFamily.start.refresh(options));
      }
      if (bigmodelFamily.codingEnabled) {
        refreshJobs.push(bigmodelFamily.coding.refresh(options));
      }
      if (bigmodelFamily.startEnabled) {
        refreshJobs.push(bigmodelFamily.start.refresh(options));
      }
      // 空数组会立即完成，未启用任何套餐时刷新是一次无害的空操作。
      // 任一路失败会让汇总提前 reject，其余请求仍在进行，因此这里不做额外取消。
      return Promise.all(refreshJobs).then(() => undefined);
    },
    [
      bigmodelFamily.coding.refresh,
      bigmodelFamily.codingEnabled,
      bigmodelFamily.start.refresh,
      bigmodelFamily.startEnabled,
      zaiFamily.coding.refresh,
      zaiFamily.codingEnabled,
      zaiFamily.start.refresh,
      zaiFamily.startEnabled,
    ],
  );

  // 聚合指纹把四个 provider 的有效身份拼成一条字符串，作为自动刷新的唯一依据。
  // 未启用的 start 计划不贡献内容，避免开关状态本身制造出指纹差异。
  const providerFingerprint = useMemo(
    () =>
      [
        zaiFamily.codingFingerprint,
        zaiFamily.startEnabled ? zaiFamily.startProviderFingerprint : "",
        bigmodelFamily.codingFingerprint,
        bigmodelFamily.startEnabled ? bigmodelFamily.startProviderFingerprint : "",
      ]
        .filter(Boolean)
        .join("|"),
    [
      bigmodelFamily.codingFingerprint,
      bigmodelFamily.startEnabled,
      bigmodelFamily.startProviderFingerprint,
      zaiFamily.codingFingerprint,
      zaiFamily.startEnabled,
      zaiFamily.startProviderFingerprint,
    ],
  );

  // 自动刷新的判定顺序是：先算决策，再落记忆，最后才决定是否发请求。
  // 先写 ref 再判断是否刷新，保证被跳过的那一次不会在下一轮重复出现。
  // 依赖只保留指纹、loading、刷新函数与抑制开关，决策函数是纯的，不需要进依赖。
  useEffect(() => {
    const decision = resolveCodingPlanProviderFingerprintAutoRefresh({
      loading,
      providerFingerprint,
      skippedProviderFingerprint: skippedProviderFingerprintAutoRefreshRef.current,
      suppressAutoRefresh: suppressProviderFingerprintAutoRefresh,
    });
    skippedProviderFingerprintAutoRefreshRef.current = decision.skippedProviderFingerprint;
    if (!decision.shouldRefresh) {
      return;
    }

    // provider 配置异步加载或保存后，首次 entitlement 快照可能还是旧的。
    // 连接方式同步会单独刷新 Account Access，不能把同一次变化再扩散成套餐/余额刷新。
    refresh({ force: true, silent: true, reason: "auth" });
  }, [providerFingerprint, loading, refresh, suppressProviderFingerprintAutoRefresh]);

  // 把家族内部状态投影成 provider id 到权益状态的映射，上层不再感知家族与套餐层级。
  // 快照、loading、error 三个字段原样透出，start 未启用时统一降级为 null 与 false。
  return useMemo(
    () => ({
      entitlements: {
        [zaiFamily.codingPlanProviderId]: {
          snapshot: zaiFamily.coding.snapshot,
          loading: zaiFamily.coding.loading,
          error: zaiFamily.coding.error,
        },
        [zaiFamily.startPlanProviderId]: {
          snapshot: zaiFamily.startEnabled ? zaiFamily.start.snapshot : null,
          loading: zaiFamily.startEnabled ? zaiFamily.start.loading : false,
          error: zaiFamily.startEnabled ? zaiFamily.start.error : null,
        },
        [bigmodelFamily.codingPlanProviderId]: {
          snapshot: bigmodelFamily.coding.snapshot,
          loading: bigmodelFamily.coding.loading,
          error: bigmodelFamily.coding.error,
        },
        [bigmodelFamily.startPlanProviderId]: {
          snapshot: bigmodelFamily.startEnabled ? bigmodelFamily.start.snapshot : null,
          loading: bigmodelFamily.startEnabled ? bigmodelFamily.start.loading : false,
          error: bigmodelFamily.startEnabled ? bigmodelFamily.start.error : null,
        },
      },
      enabledStartPlanProviderIds: [
        ...(zaiFamily.startEnabled ? [zaiFamily.startPlanProviderId] : []),
        ...(bigmodelFamily.startEnabled ? [bigmodelFamily.startPlanProviderId] : []),
      ],
      refresh,
    }),
    // 两个家族对象内部已经稳定，依赖它们等价于依赖各自字段，不会引起额外重复计算。
    [bigmodelFamily, refresh, zaiFamily],
  );
}
