// 本文件职责：Workspace 侧栏底部 footer 的用量入口、升级入口与套餐徽标的取数和投影。
//   - 做什么：把 provider 授权事实、企业套餐快照、个人与团队 entitlement、当前来源选择
//     合成一份 footer 可直接渲染的状态，让菜单项与头像徽标只消费结果、不各自判断套餐。
//   - 不做什么：不发网络请求、不写全局 store、不做页面跳转；额度刷新归 useUsageEntitlement，
//     企业价格归 useEnterpriseCodingPlanProducts，选择持久化归 settings 与 session store。
//   - 依赖谁：settings 的 providerFamilyDomain 与 family connection selections、
//     zcodeSessionStore 的 selectedSupplierKey、两个 hook 的公开状态与 shared 的 provider 常量。
//   - 被谁调用：Workspace 侧栏的用量与升级菜单、用户头像旁的套餐徽标，共享同一次取数。
//   - 边界：zai 与 bigmodel 必须对称；team 套餐按 audience 路由，不按 providerId 硬判。
//
// INV（不变量：每一条都是 footer 显示与真实套餐一致的前提，改动前逐条确认）：
// INV-01 只有 provider 读取达到 ready 才允许判定“无套餐”：视图为空时来源与徽标都应视为未知 —— 守住它的位置：useWorkspaceSidebarFooterUsageSummaryState 中 providerSourcesLoading 的计算及所有引用它的 enabled 条件 —— 改错故障：冷启动首帧把已购用户显示成未购，并弹出多余的升级引导。
// INV-02 provider 事实与来源选择必须来自同一份 settings 快照：domain 与 connection selections 不能分两次读取 —— 守住它的位置：providerFamilyDomain 与 currentUsageSource 的 useMemo 输入 —— 改错故障：切换 family 后徽标与菜单额度指向不同 provider。
// INV-03 selectedSupplierKey 必须同时按 workspacePath 与 workspaceIdentity 选取：只看路径会串到其他身份的会话 —— 守住它的位置：useZCodeSessionStore 的选择器调用 —— 改错故障：远程与本地同路径时读到别人的供应商选择。
// INV-04 选择键解析出的 provider 必须经 family domain 过滤后才可用于展示：跨家族残留键要降级为空 —— 守住它的位置：scopedSelectedProviderId 的三元判断 —— 改错故障：从 BigModel 切到 Z.ai 后头像旁仍显示 Team 徽标。
// INV-05 个人套餐可用列表必须按 zai、bigmodel 的固定顺序展开：顺序是升级兜底目标的依据 —— 守住它的位置：availableCodingPlanProviders 的 flatMap 顺序 —— 改错故障：未登录时升级按钮品牌在两家之间跳动。
// INV-06 授权缺失的 provider 必须返回空数组而不是带空授权的条目：下游按存在性判断能否查询 —— 守住它的位置：flatMap 内 access 为假值时的提前返回 —— 改错故障：无授权 provider 也发起额度查询并长期停在加载态。
// INV-07 企业套餐请求的开启条件必须同时包含启用、非加载、family 允许、存在 team 授权：少一项就会对无权限账号发请求 —— 守住它的位置：bigmodelEnterpriseProducts 与 zaiEnterpriseProducts 的 enabled —— 改错故障：footer 一渲染就产生 401 请求与错误提示。
// INV-08 已订阅套餐必须显式比较 subscribed 为 true：不能用真值判断，避免未定义或字符串混入 —— 守住它的位置：subscribedTeamProducts 的两个 filter —— 改错故障：未订阅套餐被当作 team 额度来源并显示 0 用量。
// INV-09 team 来源必须由 teamSources 统一构建后交给来源解析：不能在两处各自拼装 —— 守住它的位置：teamSources 的 useMemo 与 currentUsageSource 的入参 —— 改错故障：zai 与 bigmodel 的 team 额度合并口径不一致。
// INV-10 currentUsageSource 的依赖必须包含 teamSources 与两侧个人授权：删任一项都会缓存旧来源 —— 守住它的位置：currentUsageSource 的依赖数组 —— 改错故障：重新登录或切换套餐后 footer 仍显示上一次的来源。
// INV-11 三个额度查询的 cacheKey 必须包含 provider 指纹：只按 providerId 会复用过期缓存 —— 守住它的位置：zaiEntitlement 与 bigmodelEntitlement 的 cacheKey 构造 —— 改错故障：换账号后额度展示沿用前一个账号的数字。
// INV-12 个人额度查询的开启条件必须排除对方 family：domain 为 bigmodel 时不该查 zai 个人额度 —— 守住它的位置：zaiEntitlement 与 bigmodelEntitlement 的 enabled —— 改错故障：跨家族发出无意义查询并让徽标闪成对方套餐。
// INV-13 team 额度的路由条件是 audience 为 team 而不是 providerId：zai team 与个人 providerId 相同 —— 守住它的位置：teamEntitlement 的 enabled 与 providerEntitlements 的 team 分支 —— 改错故障：Z.ai Team 用户永远查不到 team 额度，徽标缺失。
// INV-14 team 的目标 provider 回退顺序必须先取当前来源再回退 bigmodel 个人：顺序决定请求打给谁 —— 守住它的位置：teamEntitlement 的 preferredProviderId —— 改错故障：无当前来源时对错误 provider 查询并持续失败。
// INV-15 可见时的刷新效应必须依赖三个 refresh 函数引用：删除依赖会在 hook 就绪后不再刷新 —— 守住它的位置：刷新 useEffect 的依赖数组 —— 改错故障：冷启动后个人套餐徽标长期缺失，需切换页面才出现。
// INV-16 刷新必须带 silent 与 access 原因且不等待结果：静默保证不打断界面，进行中合并依赖该原因 —— 守住它的位置：刷新 useEffect 内的调用 —— 改错故障：重复弹出加载态或与后台轮询互相覆盖。
// INV-17 头像徽标的 Team 判定必须按当前 domain 只取对应一侧：两侧都看会把另一家族的历史授权带进来 —— 守住它的位置：profilePlanBadge 的 hasTeamPlanEntitlement —— 改错故障：Z.ai 账号因历史 BigModel Team 授权而显示 Team。
// INV-18 providerEntitlements 的每个条目都必须带 sourceId、providerId 与 accountAccess：缺字段会让来源解析拿不到身份 —— 守住它的位置：providerEntitlements 的三个展开分支 —— 改错故障：额度面板打开后提示未授权或无法刷新。
// INV-19 升级目标 provider 的回退链必须保留到 family 兜底：任一环删掉都会得到空值 —— 守住它的位置：upgradeTargetProviderId 的回退表达式 —— 改错故障：升级按钮点击被丢弃，用户没有任何反馈。
//
// 阅读顺序：先看 INV，再看状态 hook 的三段取数（个人额度、团队额度、来源选择），
// 最后看两个渲染组件如何只消费 state；改动前先对照 INV 找到自己触碰的那一条。
// 命名约定：usage 指菜单里的额度入口，upgrade 指升级或续费入口，badge 指头像旁徽标。
// upgradeTargetProviderId 是点击升级时上报的 provider，不等同于当前套餐的 provider。
// pendingSettingsUsageIntent 只是导航意图，真正的跳转由设置侧消费，本文件不等待结果。
// 本文件没有其它副作用出口：可见时触发一次额度 access 刷新，以及两个可选的点击回调。
import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- footer 套餐徽标、升级入口与 entitlement 探测共用同一份
   provider 选择与 family 过滤上下文，拆文件会让 zai/bigmodel 对称性难以追踪。 */
import { useEffect, useMemo } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  normalizeProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import { TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON } from "@zcode/shared/test-ids";
import { BarChart3Icon, RocketIcon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import {
  resolveCodingPlanUsageRemainingState,
  type CodingPlanUsageAvailableProvider,
} from "@/CodingPlanUsageRemainingPanel.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  isMaxCodingPlanSnapshot,
  resolveSidebarCodingPlanUpgradeFallbackProviderId,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { type SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  buildCodingPlanUsageSources,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { parseCustomProviderIdFromSupplierKey } from "@/lib/modelConfigSync.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";
import {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

export {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

// [契约] 这个标识与 shared/test-ids 导出的用量按钮常量必须保持同一字符串，E2E 靠它定位菜单项。
// 单独声明而不从测试专用包导入，是为了运行时构建不依赖测试包；两处必须同批改名才能对齐。
// 只改这里会让既有 E2E 找不到入口，属于对外可见契约，不要顺手统一命名。
const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";

// [边界] 这个包装组件只负责把入参转交状态 hook 与内容组件，不持有任何 provider 判断逻辑。
// 拆成包装与内容两层，是为了让菜单和徽标复用同一份 state，同时让渲染组件可独立测试。
// 把取数搬进渲染组件会造成每次挂载重复请求，两个消费点的状态也会不再一致。
export function WorkspaceSidebarFooterUsageSummary({
  enabled,
  onUsageClick,
  onUpgradeClick,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  // [契约] 状态 hook 的入参只有启用开关、workspaceIdentity 与 workspacePath，三者都要原样透传。
  // workspacePath 决定读哪一份会话，workspaceIdentity 决定身份隔离，不能只传其中一个。
  // 在这里裁剪参数或补默认值，会让远程工作区读到本地键，于是 footer 显示错账号的套餐。
  // 后续新增入参时，状态 hook 的返回类型与所有调用方必须在同一批改动里一起更新。
  const state = useWorkspaceSidebarFooterUsageSummaryState({
    enabled,
    workspaceIdentity,
    workspacePath,
  });
  // [权衡] 渲染层不再做二次过滤，可见性已经在状态 hook 内按是否存在活跃套餐收敛。
  // 如果在这里再判一次，两个消费点会各自拥有不同口径，后续加套餐类型时容易只改一处。
  // 因此这里只做透传，任何显示条件都应回到状态 hook 统一维护。
  return (
    <WorkspaceSidebarFooterUsageSummaryContent
      state={state}
      onUsageClick={onUsageClick}
      onUpgradeClick={onUpgradeClick}
    />
  );
}

export function useWorkspaceSidebarFooterUsageSummaryState({
  enabled,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  // [契约] settings 是 footer 唯一的配置来源，family domain 与 family 选择都从这里读取。
  // settings 允许为空表示尚未就绪，此时 domain 过滤会退化，但不能因此抛错或中断渲染。
  // 不要在组件内另建一份 settings 副本，两份快照会让 domain 与选择键来自不同版本。
  // 读取失败时保持空对象语义，让 provider 事实继续按未就绪处理，而不是当成无套餐。
  const { settings: sharedSettings } = useSettings();
  const providerFamilyDomain = normalizeProviderFamilyDomain(sharedSettings?.providerFamilyDomain);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // 首次读取失败也不能被解释成“已经加载且没有套餐”；只有 Ready 才能消费 Provider 事实。
  // [失败路径] 只有 ready 才算已加载，error 与 loading 都归为加载中，避免把失败当成没有套餐。
  // 这是本文件最重要的空值边界：过早判定未购会让已订阅用户看到升级入口。
  // 所有下游开启条件都复用这个布尔值，不能在别处用视图的其它字段重新推导。
  // 将来 hook 若增加空态，需要先在这里映射，再让下游按同一口径消费。
  // 删掉这个中间变量、把判断写进各个条件里，会导致口径漂移且难以审计。
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  const selectedSupplierKey = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).selectedSupplierKey
      : "",
  );
  // [契约] 可用 provider 列表固定按 zai 个人、bigmodel 个人顺序展开，顺序是升级兜底的依据。
  // 每个条目必须携带账号授权与展示标签，下游据此决定能否查询以及显示什么品牌。
  // 授权缺失时返回空数组而不是带空授权的条目，防止无权限 provider 进入查询链路。
  // 依赖只保留 provider 视图，是因为函数体只读这一份数据；删除它会让列表停在旧授权。
  // 标签仅在视图未给名称时才用内置兜底，避免覆盖服务端下发的本地化名称。
  const availableCodingPlanProviders = useMemo(
    () =>
      [
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      ].flatMap((providerId): CodingPlanUsageAvailableProvider[] => {
        const access = resolveEntitledAccountProviderAccess(providerSettingsView, providerId);
        if (!access) return [];
        return [
          {
            providerId,
            accountAccess: access.access,
            label:
              access.label ||
              (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                ? "Z.ai - Coding Plan"
                : "BigModel - Coding Plan"),
          },
        ];
      }),
    [providerSettingsView],
  );
  // [契约] zai 与 bigmodel 的个人 provider 必须从同一份可用列表派生，不能再各自过滤一遍。
  // 这样保证“能展示的品牌”与“能查询的额度”始终是同一集合，不会出现只显示不查询。
  // `personalPlan` 与 `quota` 都为空即无可用个人套餐，徽标与个人额度保持空。
  // 不要在这里补默认 provider，默认值属于升级兜底链，与是否已有套餐是两件事。
  const zaiProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const bigmodelTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  // [契约] 选择键必须先解析出 provider 再参与 family 比较，直接比字符串会漏掉带前缀的自定义键。
  // 解析失败返回空表示未选择，不能回退到某个内置 provider，否则会误判成已购。
  // family 推断依赖 shared 的映射函数，保持与服务端同一张表，避免两侧结论不一致。
  // 这一段只做解析与映射，不做 domain 过滤，过滤留给下一步单独处理。
  const selectedProviderIdFromSupplierKey =
    parseCustomProviderIdFromSupplierKey(selectedSupplierKey);
  const selectedProviderFamilyId = selectedProviderIdFromSupplierKey
    ? resolveModelProviderFamilyIdByProviderId(selectedProviderIdFromSupplierKey)
    : null;
  // providerFamilyDomain 是当前登录/运行 family 边界；BigModel Team selectedKey
  // 会在切换到 Z.ai 后保留，footer 若不按当前 domain 过滤会把头像旁徽标误显示成 Team。
  // [契约] domain 与 provider family 不一致时必须把选择降级为空，而不是报错或静默保留。
  // 原因是 BigModel Team 的选择键在切到 Z.ai 后仍留在会话里，不过滤就会显示错家族徽标。
  // 三个条件要同时成立才降级：有 family、有 domain、且两者不同，缺一不可。
  // 降级为空让下游按未选择走兜底链，而不是按已选但无效走另一条分支。
  // 改动前确认 team 与个人两条来源解析消费的都是这个降级后的值。
  const scopedSelectedProviderId =
    selectedProviderFamilyId &&
    providerFamilyDomain &&
    selectedProviderFamilyId !== providerFamilyDomain
      ? null
      : selectedProviderIdFromSupplierKey;
  const bigmodelFamilyAllowed = providerFamilyDomain !== "zai";
  // 原只有 bigmodelFamilyAllowed 单变量，zai family 下 enterprise products 完全不拉。
  // zai team plan 对称化需要 zai family 也独立拉一份 enterprise pricing。
  const zaiFamilyAllowed = providerFamilyDomain !== "bigmodel";
  // [资源] 企业套餐请求只在存在 team 授权时开启，避免无权限账号在 footer 一渲染就打出 401。
  // authenticated 固定为真，因为该 hook 只在已登录的侧栏环境挂载，改动会触发另一套鉴权流程。
  // family 参数必须与当前请求的品牌一致，两侧各自独立拉取，不能共用一份缓存。
  // 开启条件中任一缺失都可能导致重复请求或对错误 family 的请求，四个条件都要保留。
  const bigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    // footer badge 和升级入口都需要识别 Team Plan。
    // Team 项目上下文只在企业 pricing/customerInfo 返回，账号级头像徽标也不能被当前连接方式卡住。
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelTeamProvider),
    authenticated: true,
    family: "bigmodel",
  });
  const zaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: enabled && !providerSourcesLoading && zaiFamilyAllowed && Boolean(zaiTeamProvider),
    authenticated: true,
    family: "zai",
  });
  // [契约] 只保留 subscribed 显式为 true 的套餐，不能用真值判断，避免未定义或字符串混入。
  // 两侧企业的已订阅结果合并成一份列表再交给来源构建，保持 zai 与 bigmodel 对称。
  // 依赖只取套餐列表，因为过滤只用它；删除该依赖会让订阅变化后列表不更新。
  const subscribedTeamProducts = useMemo(
    () => [
      ...(bigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(zaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [bigmodelEnterpriseProducts.snapshot?.productList, zaiEnterpriseProducts.snapshot?.productList],
  );
  // [契约] team 来源统一在这里构建，包含两侧授权与已订阅套餐，不允许在下游重复拼装。
  // 授权缺失的一侧用空对象跳过，而不是传空授权，让构建函数只处理真实存在的团队。
  // 依赖覆盖两侧授权与订阅列表，缺一项都会让 team 额度在切换后停留在旧值。
  const teamSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(zaiTeamProvider?.access
            ? {
                zai: zaiTeamProvider.access,
              }
            : {}),
          ...(bigmodelTeamProvider?.access
            ? {
                bigmodel: bigmodelTeamProvider.access,
              }
            : {}),
        },
        subscribedTeamProducts,
      }),
    [bigmodelTeamProvider?.access, subscribedTeamProducts, zaiTeamProvider?.access],
  );
  // [事务] 当前来源是一次完整解析：来源选择、两侧个人授权、team 来源必须同批传入。
  // 返回空表示没有任何可用来源，此时不要伪造默认来源，否则套餐详情会展示错误账单。
  // 依赖里既有选择键也有两侧授权与 team 来源，任何一项删除都会缓存旧结论。
  // 解析顺序决定个人与团队的优先级，调整顺序等于改变产品行为，需要产品确认。
  const currentUsageSource = useMemo(
    () =>
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: sharedSettings?.providerFamilyConnectionSelections,
        selectedProviderId: scopedSelectedProviderId,
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                )!.access,
              }
            : {}),
        },
        teamSources,
      }),
    [
      scopedSelectedProviderId,
      bigmodelProvider?.accountAccess,
      sharedSettings?.providerFamilyConnectionSelections,
      teamSources,
      zaiProvider?.accountAccess,
    ],
  );
  const selectedProviderId = currentUsageSource?.sourceId;

  // [资源] 个人额度查询的开启条件是启用、已就绪、domain 非 bigmodel、且存在 zai 个人 provider。
  // 四个条件缺一个都会在错误场景发请求，例如 domain 为 bigmodel 时仍去查 zai，属于跨家族浪费。
  // 缓存键必须带 provider 指纹，否则换账号后会命中上一个账号的缓存数字。
  // 允许禁用 provider 与要求指定 provider 两个开关组合，表示即使被禁用也按指定目标查询。
  // 挂载刷新为假是有意的：刷新统一放在下方可见效应里，避免两次重复请求。
  const zaiEntitlement = useUsageEntitlement({
    enabled:
      enabled &&
      !providerSourcesLoading &&
      providerFamilyDomain !== "bigmodel" &&
      Boolean(zaiProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: zaiProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: bigmodelProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  // [契约] team 额度按 audience 路由而不是按 providerId 判断，因为 zai team 与个人 providerId 相同。
  // 目标 provider 取当前来源，回退到 bigmodel 个人只是为了在无来源时仍能构造请求。
  // 账号授权与缓存键都来自 team 来源条目，缺失时 audience 不为 team，查询自然关闭。
  // 历史实现对 team 分支硬判 bigmodel 个人 provider，导致 zai team 查不到额度，别退回旧写法。
  // `mountedRefresh` 同样为假，与个人额度共用 `refresh` 入口。
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId 判断，zai team source 的 providerId
    // 是 zaiCodingPlan，永远进不到 team 分支，导致 zai team 额度不查询、badge 不显示。
    // 改为按 currentUsageSource.audience === "team" 路由，providerId 动态取。
    enabled: enabled && !providerSourcesLoading && currentUsageSource?.audience === "team",
    includeSubscription: true,
    preferredProviderId:
      currentUsageSource?.providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: currentUsageSource?.teamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: currentUsageSource?.teamSource?.id,
    refreshOnMount: false,
  });
  // footer 是常驻入口，refreshOnMount: false 后冷启动没有其它
  // 入口预热 entitlement，个人计划徽标缺失。可见时触发一次 access 刷新，复用共享
  // 1 分钟 freshness window、失败退避和 in-flight 合并；hook disabled 时 refresh 是 no-op。
  // [并发] 可见时对三个额度各触发一次静默刷新，复用共享的一分钟新鲜窗口与进行中合并。
  // 依赖必须是三个刷新函数引用本身，而不是快照或加载态：后两者变化会引发刷新风暴。
  // 静默标记与 access 原因决定日志级别与是否展示加载态，改动会污染用户可见的反馈。
  // 特意不等待结果：失败由 hook 内部退避，footer 不该因一次额度请求阻塞渲染。
  // hook 处于禁用状态时刷新是空操作，因此这里不需要再判一次启用条件。
  useEffect(() => {
    for (const refresh of [
      zaiEntitlement.refresh,
      bigmodelEntitlement.refresh,
      teamEntitlement.refresh,
    ]) {
      void refresh({ silent: true, reason: "access" });
    }
  }, [zaiEntitlement.refresh, bigmodelEntitlement.refresh, teamEntitlement.refresh]);
  // [契约] 头像徽标的个人套餐按当前 domain 只取对应一侧，另一侧即使有快照也不能参与展示。
  // Team 判定同样按 domain 收敛，只有 domain 未知时才允许任一侧的 team 授权生效。
  // 企业价格结果只负责额度来源与详情，不能用来判定头像徽标，两者数据来源不同。
  // 传空快照表示该侧没有个人套餐，不要用另一侧兜底，那会让跨家族用户显示错误套餐。
  const profilePlanBadge = resolveSidebarFooterProfilePlanBadge({
    individualEntitlements: [
      ...(providerFamilyDomain !== "bigmodel"
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              snapshot: zaiEntitlement.snapshot,
              loading: zaiEntitlement.loading,
            },
          ]
        : []),
      ...(bigmodelFamilyAllowed
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              snapshot: bigmodelEntitlement.snapshot,
              loading: bigmodelEntitlement.loading,
            },
          ]
        : []),
    ],
    // 头像徽标使用账号的 Team entitlement；pricing 结果只负责额度来源和套餐详情。
    hasTeamPlanEntitlement:
      providerFamilyDomain === "zai"
        ? Boolean(zaiTeamProvider)
        : providerFamilyDomain === "bigmodel"
          ? Boolean(bigmodelTeamProvider)
          : Boolean(zaiTeamProvider || bigmodelTeamProvider),
  });
  // [契约] 每个条目都必须带来源标识、provider 标识与账号授权，下游来源解析靠它们对齐。
  // 个人分支要求 provider 标识与 audience 同时匹配，只看标识会把 team 来源误当个人来源。
  // team 分支按 audience 判定并直接取 team 来源的标识与标签，覆盖两个家族的团队套餐。
  // 顺序与来源解析的优先级一致，调整顺序会改变面板默认选中的额度来源。
  const providerEntitlements = [
    ...(currentUsageSource?.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...zaiEntitlement,
          },
        ]
      : []),
    ...(currentUsageSource?.providerId ===
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...bigmodelEntitlement,
          },
        ]
      : []),
    // 原 team 分支硬判 bigmodelCodingPlan providerId，zai team source 走不进来。
    // 改为统一按 audience === "team" 路由，覆盖 zai/bigmodel 两种 family 的 team source。
    ...(currentUsageSource?.audience === "team" && currentUsageSource.teamSource
      ? [
          {
            sourceId: currentUsageSource.teamSource.id,
            providerId: currentUsageSource.teamSource.providerId,
            accountAccess: currentUsageSource.teamSource.accountAccess,
            label: currentUsageSource.teamSource.label,
            ...teamEntitlement,
          },
        ]
      : []),
  ];
  // [契约] 用量状态统一由来源解析函数计算，输入是可用 provider、额度列表、加载态与选中来源。
  // 加载态要显式传入：它决定面板显示骨架还是显示没有套餐的结论。
  // 不做兜底捕获：`parseUsageSummary` 是纯函数，异常应在测试里暴露。
  const usageState = resolveCodingPlanUsageRemainingState({
    availableProviders: availableCodingPlanProviders,
    entitlements: providerEntitlements,
    modelProvidersLoading: providerSourcesLoading,
    selectedProviderId,
  });
  const visibleUsageState = usageState?.hasAnyActiveCodingPlan ? usageState : null;
  // [契约] 只有当前选中来源是个人的 zai 或 bigmodel 时，才把它当作升级目标。
  // team 来源不参与升级目标，团队套餐的续费入口不在这个菜单里。
  // 返回空表示交给后续回退链决定，而不是在这里补一个默认品牌。
  // 把 team 的 provider 标识放进来，会让升级按钮把团队用户引导到个人购买页。
  const selectedUpgradeProviderId: SidebarUsageCodingPlanProviderId | undefined =
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ? selectedProviderId
      : undefined;
  // [契约] 回退链顺序是选中个人 provider、当前来源、首个可用 provider、按 family 兜底，不可调换。
  // 每一环都可能为空，必须保留完整链式回退，删掉任一环都可能把空值传给点击回调。
  // family 兜底保证未登录或全部缺失时按钮仍有明确品牌，这是产品要求的可见性保障。
  const upgradeTargetProviderId =
    selectedUpgradeProviderId ??
    currentUsageSource?.providerId ??
    availableCodingPlanProviders[0]?.providerId ??
    resolveSidebarCodingPlanUpgradeFallbackProviderId(providerFamilyDomain);
  return {
    audience: currentUsageSource?.audience,
    availableCodingPlanProviders,
    providerSourcesLoading,
    providerEntitlements,
    profilePlanBadge,
    selectedProviderId,
    upgradeTargetProviderId,
    usageState: visibleUsageState,
  };
}

export type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent({
  state,
  onUsageClick,
  onUpgradeClick,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
}) {
  // [契约] 文案一律走 intl，不允许在渲染里硬编码中文或英文，语言切换后必须立即生效。
  // 升级按钮文案还受套餐快照影响，续费与升级是两条不同文案，不能合并。
  // 入口按钮自带文案优先于本地文案，它可能带回服务端下发的实验分组名称。
  const { intl } = useZCodeIntl();
  const entryGate = useCodingPlanEntryGate();
  const { providerEntitlements, upgradeTargetProviderId } = state;
  // [契约] 升级按钮的文案与漏斗事件都基于同一个快照，两者必须同源以免口径不一致。
  // 找不到对应 provider 时返回空表示未知套餐，按未知处理而不是当成未订阅。
  // 这里只按 provider 标识匹配，不按显示标签匹配，标签会随语言变化。
  const upgradeProviderSnapshot =
    providerEntitlements.find((item) => item.providerId === upgradeTargetProviderId)?.snapshot ??
    null;
  const upgradeActionLabelId = isMaxCodingPlanSnapshot(upgradeProviderSnapshot)
    ? "sidebar.usage.plan.renew"
    : "sidebar.usage.plan.upgrade";

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
      {/* 产品要求：升级入口始终显示；未解析出当前套餐时由当前 provider family 决定品牌。 */}
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON}
        disabled={entryGate.status === "loading"}
        aria-busy={entryGate.status === "loading"}
        onSelect={() => {
          if (entryGate.status !== "ready") {
            entryGate.retry?.();
            return;
          }
          onUpgradeClick?.(
            upgradeTargetProviderId,
            createCodingPlanFunnelContext({
              providerId: upgradeTargetProviderId,
              upgradeSource: "profile_menu",
              eventRegion: "app.profile",
              eventText: intl.formatMessage({ id: upgradeActionLabelId }),
              entryPlanState: resolveCodingPlanEntryPlanState({
                snapshot: upgradeProviderSnapshot,
              }),
            }),
          );
        }}
      >
        <RocketIcon className="size-4" />
        {entryGate.label ?? intl.formatMessage({ id: upgradeActionLabelId })}
      </DropdownMenuItem>
    </>
  );
}

export function WorkspaceSidebarFooterPlanBadge({
  state,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
}) {
  const { intl } = useZCodeIntl();
  const label =
    state.profilePlanBadge?.audience === "team"
      ? intl.formatMessage({ id: "sidebar.usage.plan.audienceTeam" })
      : resolveSidebarFooterPlanBadgeLabel(state.profilePlanBadge?.snapshot ?? null);
  // [契约] 没有可展示徽标时返回空，不渲染空壳，避免侧栏布局出现多余间距。
  // team 与个人两种徽标文案来源不同：团队固定文案，个人由快照推导，不能互替。
  // 空值判断必须保留，否则空字符串会渲染成一个宽度为零但仍占位的圆角标签。
  if (!label) {
    return null;
  }

  return (
    <SidebarNativeTooltip>
      <span
        className="min-w-0 max-w-20 shrink truncate rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
        title={label}
      >
        {label}
      </span>
    </SidebarNativeTooltip>
  );
}
