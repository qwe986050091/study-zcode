/* eslint-disable max-lines -- Model Provider 导航需要集中计算分组、选中项与 Coding Plan 权益态，后续拆分时再收敛。 */
// 职责边界（useModelProviderNavigation.ts）：Model Provider 设置页左侧导航的纯派生层。
// 做：把原始 provider 列表 + 权益快照 + 连接方式设置，折叠成 preset / codingPlan / custom 三类导航节点。
// 不做：不发请求、不写 store、不持久化选择；选中态由调用方通过 selectedNodeKey 持有。
// 依赖：constants 里的静态 specs、providerFamilyConnectionVisibility、modelProviderOrdering、codingPlanProvider。
// 边界：本 hook 是纯计算 + 一个「修正非法选中」的 effect，其余全是 useMemo。
// 失败语义：设置读取中返回 null（详情页显示 loading），读取失败回退首个可用项而不是 null。
// 身份：节点 key 由 utils 的三个 create*NodeKey 统一生成，不要在别处拼字符串。
// 一致性：编码套餐的权益、连接方式、侧栏节点是同一份快照的三个投影，改动任一处都要同步其余两处。
// 取舍：为了「侧栏只显示当前 family」，部分节点只出现在右侧可选项而不进侧栏，两套集合刻意分开。
//
// INV-01 断言：选中态只由外部 selectedNodeKey 持有，本 hook 只在失效时回调 setSelectedNodeKey —— 守住它的位置：fallback effect —— 改错故障：出现第二份选中态，点击后侧栏闪烁或高亮错位。
// INV-02 断言：navigationGroups 的依赖必须包含 intl —— 守住它的位置：该 memo 的 deps —— 改错故障：切换语言后分组标题与菜单项仍是旧 locale。
// INV-03 断言：编码套餐按 providerFamilyDomain 过滤，null 表示不过滤 —— 守住它的位置：shouldShowCodingPlanForProviderFamilyDomain —— 改错故障：登录另一 family 后仍展示不相关套餐，用户点进去是空页。
// INV-04 断言：团队连接匹配必须同时校验 organizationId 与 projectId —— 守住它的位置：connectionSelectionMatchesNavigationItem —— 改错故障：同项目的商品更新被误判为连接丢失，初始化出现空选项。
// INV-05 断言：kind 为 start-plan 的选择永远不匹配任何具体导航项 —— 守住它的位置：匹配函数首个分支 —— 改错故障：Start Plan 被当成可恢复连接，侧栏落点错到套餐节点。
// INV-06 断言：连接方式计算里 pending 覆盖已保存（展开顺序 fixed） —— 守住它的位置：connectionSelections 展开 —— 改错故障：乐观选择被旧值覆盖，点击套餐没有反应。
// INV-07 断言：teamPlanSelections 只从合并结果里挑 kind 为 team-coding-plan 的项 —— 守住它的位置：Object.fromEntries 前的 filter —— 改错故障：个人套餐被当成团队订阅参与可见性判断。
// INV-08 断言：navigationItems = 侧栏节点 + 未出现在侧栏的连接项，去重靠 key —— 守住它的位置：visibleKeys —— 改错故障：同一节点出现两次，选中态与高亮指向不同实例。
// INV-09 断言：selectable 只过滤 codingPlanLoading，不过滤其它类型 —— 守住它的位置：两个 selectable memo —— 改错故障：loading 占位被当作可选，选中后详情页永久空白。
// INV-10 断言：familyConnectionSettingsLoading 为真时 resolve 必须返回 null —— 守住它的位置：selectedNavItem 的解析 —— 改错故障：首次 hydrate 前先闪成 Start Plan 再按保存值纠偏。
// INV-11 断言：设置读取失败时不按 family 首选回退，但也不返回 null —— 守住它的位置：resolvedItem 分支 —— 改错故障：读取失败被当成永久 loading，页面卡住。
// INV-12 断言：非法连接的回退只影响本次落点，不写回偏好、不改会话选择 —— 守住它的位置：pickInitialConnectionNavigationItem 调用 —— 改错故障：一次失败的读取永久改掉用户已保存的连接方式。
// INV-13 断言：默认落点优先级固定为 已购个人套餐 → teamPlan → 个人套餐 → 任一 plan → preset —— 守住它的位置：pickInitialConnectionNavigationItem —— 改错故障：把有权益的用户丢进 Start Plan，看起来像没买。
// INV-14 断言：family preset（zai/bigmodel start plan）节点消失时回落 initialSideNodeKey —— 守住它的位置：isFamilyPresetNodeKey 分支 —— 改错故障：把「连接方式」节点塞回侧栏，破坏侧栏语义。
// INV-15 断言：只有当前选中不在侧栏集合时才改写选中 —— 守住它的位置：hasSelectedNode 早退 —— 改错故障：每次渲染抢焦点，用户无法切到右侧独有的节点。
// INV-16 断言：navigationItemByKey 与 sideNavigationItemByKey 是两套集合，不能合并 —— 守住它的位置：两个 memo —— 改错故障：右侧可选但侧栏不存在的节点无法显示选中态。
// INV-17 断言：preset 的状态灯必须按具体套餐 providerId 回查 provider —— 守住它的位置：resolvePresetFamilyStatusProvider 的 find —— 改错故障：用继承的 provider 点灯，团队套餐显示个人身份状态。
// INV-18 断言：只有 pick 到 plan/teamPlan 连接项时 preset 才点灯，Start Plan 不算 —— 守住它的位置：isPlanConnectionNavigationItem —— 改错故障：Start Plan 或自定义项错误点亮整组 preset。
// INV-19 断言：start plan 或无 family spec 的连接项直接返回 item.key —— 守住它的位置：resolveSideNavigationNodeKeyForConnectionItem 的两处 return —— 改错故障：回落出侧栏不存在的 key，选中变 null。
// INV-20 断言：custom 节点不参与 family 匹配 —— 守住它的位置：connectionSelectionMatchesNavigationItem 首行 —— 改错故障：自定义 provider 被当成团队连接，连接状态显示错乱。
//
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type {
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  type OAuthProviderId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  type CodingPlanEntitlementState,
  type ModelProviderNavGroup,
  type PresetProviderSpec,
} from "@/settings/model-provider-section/constants.js";
import { pickCodingPlanEntitlementProvider } from "@/lib/codingPlanProvider.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  buildVisibleFamilyConnectionItems,
  resolveCodingPlanEntitlementState,
} from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";

interface PresetProviderWithConfig extends PresetProviderSpec {
  provider: ProviderSettingsFormProvider | null;
}

interface UseModelProviderNavigationOptions {
  presetProviders: PresetProviderWithConfig[];
  modelProviders: ProviderSettingsFormProvider[];
  /**
   * 当前账号明确有权益的 Provider。缺省等价于尚无账号权益；生产设置页始终显式传入。
   */
  entitledAccountProviderIds?: ReadonlySet<string>;
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  providerFamilyDomain?: ProviderFamilyDomain | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  subscribedTeamProducts?: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback?: boolean;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  presetProviders,
  modelProviders,
  entitledAccountProviderIds = new Set(),
  modelProvidersLoading = false,
  displayOrder,
  codingPlanEntitlements = {},
  providerFamilyDomain = null,
  connectionSelections = {},
  pendingConnectionSelections = {},
  familyConnectionSettingsLoading = false,
  familyConnectionSettingsFailed = false,
  subscribedTeamProducts = [],
  showPurchasedTeamPlanFallback = false,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  // [契约] custom 只取 group 为 standard-personal 的 provider；团队/企业 provider 不能出现在「自定义」组。
  // 排序必须复用模型菜单的 sortModelProvidersForDisplay，保证设置页与聊天框顺序一致。
  // 这里不能再按 enabled/executable 过滤：设置页需要展示未配置完成的 provider 以便用户补配置。
  // displayOrder 变化会重算整个列表，因此调用方要传稳定引用，避免每次渲染都换数组。
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // 这里复用模型菜单的展示排序，确保设置页和聊天框供应商顺序一致。
    // [契约] 排序函数只做展示排序，不改变 provider 身份；返回新数组，不要原地 sort 入参。
    // displayOrder 为 undefined 时函数内部要有确定的兜底顺序，调用方不需要自己补默认值。
    // 不要把排序挪出 useMemo：这会影响后续 memo 的引用稳定性，进而让整条导航链重算。
    // 排序结果同时决定「自定义」分组顺序与右侧可选项顺序，两处共用这一份。
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  // [契约] 这里生成的是「全部编码套餐节点」，包括 Start Plan；Start Plan 的落位由后续分组决定。
  // 过滤依据是 OAuth provider 归属的 family，而不是账号是否已登录。
  // 节点 key 必须由 createCodingPlanProviderNodeKey 生成，手写字符串会让选中态与侧栏失配。
  const codingPlanItems = useMemo(
    () =>
      CODING_PLAN_PROVIDER_SPECS.filter((spec) =>
        shouldShowCodingPlanForProviderFamilyDomain(spec.oauthProviderId, providerFamilyDomain),
      ).map((spec) => {
        // [契约] 找不到对应 provider 时是 null，不是占位对象：下游靠 null 区分「未配置」与「已配置」。
        // 这里按 spec.id 精确匹配，不要用 includes 或前缀匹配，family 之间 id 很相似。
        // provider 同时用于权益选择与账户状态，二者必须来自同一条记录。
        const provider = modelProviders.find((item) => item.providerId === spec.id) ?? null;
        const accountEntitled = entitledAccountProviderIds.has(spec.id);
        const entitlementProvider = pickCodingPlanEntitlementProvider(provider);
        const entitlement = codingPlanEntitlements[spec.id];
        // [契约] 权益态需要同时喂账号权益、账号可用性、权益快照与 loading 标志，缺一项都会误判。
        // modelProvidersLoading 传进去是为了让「加载中」不显示成「未购买」。
        // 返回值里的 statusLabelId 是 i18n key，不要在本地拼中文文案。
        const state = resolveCodingPlanEntitlementState({
          providerId: spec.id,
          accountEntitled,
          accountAvailability: provider?.accountState?.availability,
          accountUnavailableReason: provider?.accountState?.unavailableReason,
          entitlement,
          modelProvidersLoading,
        });

        return {
          // [契约] key 只由 presetId 决定，与权益态无关；权益变化不能换 key，否则选中态会丢。
          // 同一个套餐在侧栏与右侧可选项中必须用同一个 key，见 INV-08。
          // 不要在这里加 workspace 或账号维度：导航是单会话视图。
          key: createCodingPlanProviderNodeKey(spec.id),
          type: "codingPlan" as const,
          presetId: spec.id,
          oauthProviderId: spec.oauthProviderId,
          label: isStartPlanModelProviderId(spec.id)
            ? "Start Plan"
            : `${spec.providerName} - ${intl.formatMessage({
                id: "settings.modelProvider.connectionMode.codingPlan",
              })}`,
          providerName: spec.providerName,
          // [契约] 展示用的 provider 走 pickCodingPlanEntitlementProvider，而不是上面的原始 find 结果。
          // 这个字段用于点灯与详情页跳转，必须与 statusActive 的判断来源一致。
          // 原始 provider 与 entitlementProvider 的区别是「哪份快照有权益」，不要合并。
          provider: entitlementProvider,
          accountEntitled,
          status: state.status,
          statusLabelId: state.statusLabelId,
          // [契约] Start Plan 在未登录时才追加 accountLoginRequired 与专属文案，其余套餐不受影响。
          // 这段条件展开必须在 status 计算之后，否则会被 state.statusLabelId 覆盖。
          // 新增覆盖字段时注意展开顺序：后面的同名 key 生效，这里刻意放在最后。
          ...(isStartPlanModelProviderId(spec.id) &&
          entitlement?.snapshot?.unavailableReason === "not_authenticated"
            ? {
                accountLoginRequired: true,
                statusLabelId: "settings.modelProvider.startPlan.status.loginExpired",
              }
            : {}),
          planLevel: state.planLevel,
          currentProductId: state.currentProductId,
          subscriptionBillingCycle: state.subscriptionBillingCycle,
          subscriptionRenewTime: state.subscriptionRenewTime,
          subscriptionExpireTime: state.subscriptionExpireTime,
          subscriptionDetails: state.subscriptionDetails,
          quotaLimits: state.quotaLimits,
          mcpQuotaLimit: state.mcpQuotaLimit ?? null,
          purchaseUrl: spec.purchaseUrl,
          // [契约] 点灯只认 executable === true，不认「有权益」或「已登录」。
          // 用 === true 而不是真值判断：executable 可能是 undefined，undefined 不能算可用。
          // 这个字段与 resolvePresetFamilyStatusProvider 返回值的 executable 判断必须同口径。
          statusActive: entitlementProvider?.executable === true,
        };
      }),
    [
      entitledAccountProviderIds,
      codingPlanEntitlements,
      intl,
      modelProviders,
      modelProvidersLoading,
      providerFamilyDomain,
    ],
  );
  // [契约] 这是「右侧连接方式列表」的来源，会做可见性过滤与团队套餐展开，与侧栏节点不同。
  // 传入的 selections 必须是 merged（已保存 + pending），见 INV-06。
  // 这里过滤掉 Start Plan：它只作为连接方式的目标承载在 preset 节点上，不单独成项。
  const connectionModeCodingPlanItems = useMemo(
    () =>
      buildVisibleFamilyConnectionItems({
        items: codingPlanItems.filter((item) => !isStartPlanModelProviderId(item.presetId)),
        codingPlanEntitlements,
        subscribedTeamProducts,
        showPurchasedTeamPlanFallback,
        // [契约] 展开顺序决定优先级：pending 在后，因此乐观值覆盖已保存值。
        // 不要为了「更安全」反过来写：挂起值消失时 UI 会闪回旧选项，用户会认为点击失败。
        // 合并只发生在这里与合并选择处，不要把 merged 结果写回 store 或偏好。
        connectionSelections: {
          ...connectionSelections,
          ...pendingConnectionSelections,
        },
        teamPlanSelections: Object.fromEntries(
          Object.entries({ ...connectionSelections, ...pendingConnectionSelections }).filter(
            ([, selection]) => selection?.kind === "team-coding-plan",
          ),
        ),
      }),
    [
      codingPlanEntitlements,
      showPurchasedTeamPlanFallback,
      codingPlanItems,
      connectionSelections,
      pendingConnectionSelections,
      subscribedTeamProducts,
    ],
  );

  // [契约] 侧栏固定两个组：preset 与 custom；编码套餐按是否 Start Plan 分散到 preset 组。
  // 这个 memo 里会格式化文案，所以 intl 必须在依赖里，见 INV-02。
  // 返回的 groups 是渲染结构，不要在其中放函数或 provider 实例以外的可变对象。
  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    const groups: ModelProviderNavGroup[] = [
      {
        id: "preset",
        title: intl.formatMessage({ id: "settings.modelProvider.presetTitle" }),
        items: [
          ...presetProviders.map(({ id, displayName, provider }) => {
            // [契约] preset 的状态灯不是直接用它的 provider，而是按当前连接方式回查具体套餐，见 INV-17/18。
            // 必须把 connectionModeCodingPlanItems 与 selections 一起传入，否则无法判断用户选的是哪个连接。
            // 返回 null 表示「当前没有可选连接」，此时不点灯，不要回退到未解析的 provider。
            const statusProvider = resolvePresetFamilyStatusProvider({
              presetId: id,
              provider,
              connectionModeItems: connectionModeCodingPlanItems,
              connectionSelections,
              modelProviders,
            });
            return {
              key: createPresetProviderNodeKey(id),
              type: "preset" as const,
              presetId: id,
              label: displayName,
              // [契约] preset 的 logo 取「个人套餐 provider」的配置，这是唯一能看到该 family 品牌图的地方。
              // 要按 familySpec.individualCodingPlanProviderId 精确查找，找不到就是 undefined（UI 自行兜底）。
              // 这段查找在 map 内部逐项执行，数据量小；不要提前建 Map 反而增加一处需要同步的索引。
              logo: modelProviders.find(
                (candidate) =>
                  candidate.providerId ===
                  resolveModelProviderFamilySpecByProviderId(id)?.individualCodingPlanProviderId,
              )?.config.logo,
              provider,
              displayName,
              statusProvider,
              statusActive: statusProvider?.executable === true,
            };
          }),
          // [契约] 只有 Start Plan 进入侧栏 preset 组；其余编码套餐走连接方式列表，见 INV-14。
          // 过滤条件与 isFamilyPresetNodeKey 的判断必须一致，否则回退会指向不存在的节点。
          // 不要在这里再排一次序：presetProviders 的顺序就是产品定义顺序。
          ...codingPlanItems.filter((item) => isStartPlanModelProviderId(item.presetId)),
        ],
      },
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        // [契约] 自定义节点用 provider.providerId 作为 key，与预设节点的命名空间不同。
        // label 走 getProviderFormLabel，保证与表单页标题一致。
        // 自定义 provider 不参与 family 逻辑，因此这里不带 statusProvider 字段。
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ];

    // [契约] 直接返回新数组，调用方不得原地修改；后续 memo 依赖它的引用。
    // 组顺序（preset 在前、custom 在后）是产品顺序，不要按数量排序。
    // `groups` 保留空数组项：分组标题本身是导航结构的一部分。
    return groups;
  }, [
    customProviders,
    codingPlanItems,
    connectionModeCodingPlanItems,
    // 左侧导航分组标题在这个 memo 内格式化。
    // 语言切换时 provider/权益引用可能不变，必须依赖 intl 才能刷新旧 locale 的文案。
    intl,
    connectionSelections,
    pendingConnectionSelections,
    presetProviders,
    modelProviders,
  ]);

  // [契约] 这是「所有可跳转节点」的并集：侧栏节点 + 只在右侧出现的连接项。
  // 去重必须按 key，用对象引用去重会在重算后失效。
  // 并集顺序决定选中项的默认展示，侧栏节点优先。
  const navigationItems = useMemo(() => {
    const visibleItems = navigationGroups.flatMap((group) => group.items);
    // [契约] 用 Set 做 O(1) 去重，不要用 some 嵌套；节点数量虽小但每次重算都会跑。
    // key 必须来自 create*NodeKey，重复 key 意味着上游节点构造有 bug，不要在这里改名规避。
    // 这个集合只服务并集去重，不要复用于选中判断（那是另一套 side 集合）。
    const visibleKeys = new Set(visibleItems.map((item) => item.key));
    return [
      ...visibleItems,
      ...connectionModeCodingPlanItems.filter((item) => !visibleKeys.has(item.key)),
    ];
  }, [connectionModeCodingPlanItems, navigationGroups]);

  // [契约] 只剔除 loading 占位，其余类型（含 codingPlan/teamPlan/custom）都可选。
  // 这个集合是「右侧详情页能打开哪些节点」的依据，与侧栏集合不同，见 INV-16。
  // 过滤条件一旦放宽或收紧，会直接改变选中项是否被判为失效。
  const selectableNavigationItems = useMemo(
    () => navigationItems.filter((item) => item.type !== "codingPlanLoading"),
    [navigationItems],
  );
  const selectableSideNavigationItems = useMemo(
    () =>
      navigationGroups
        .flatMap((group) => group.items)
        .filter((item) => item.type !== "codingPlanLoading"),
    [navigationGroups],
  );

  // [契约] Map 的 value 类型已排除 loading，因此取值后不需要再判类型。
  // 每次 selectableNavigationItems 变化都会重建 Map，不要在调用点缓存它。
  // 这里的 Map 用于选中解析与 fallback，不用于渲染列表。
  const navigationItemByKey = useMemo(
    () => new Map(selectableNavigationItems.map((item) => [item.key, item])),
    [selectableNavigationItems],
  );
  const sideNavigationItemByKey = useMemo(
    () => new Map(selectableSideNavigationItems.map((item) => [item.key, item])),
    [selectableSideNavigationItems],
  );

  // [契约] 解析结果是详情页的唯一输入源；为 null 时详情页显示 loading，而不是空状态。
  // 解析必须走 resolveSelectedProviderFamilyConnectionItem，它负责把 preset 选中项折算成具体连接。
  // 不要在这里用 navigationItemByKey 直接取，那会绕过 family 连接方式的还原逻辑。
  const selectedNavItem = selectedNodeKey
    ? resolveSelectedProviderFamilyConnectionItem({
        selectedNodeKey,
        navigationItemByKey,
        selectableNavigationItems,
        connectionSelections,
        pendingConnectionSelections,
        familyConnectionSettingsLoading,
        familyConnectionSettingsFailed,
        modelProvidersLoading,
      })
    : null;

  // [契约] requestedItem 只用于推导 family，与 selectedNavItem 的来源不同：后者可能已被折算成别的节点。
  // 这里用的是「可选项 Map」，因此只存在于侧栏的节点不会参与 family 推导。
  // 找不到时是 undefined 而不是 null，下游的 `?.` 依赖这个区别。
  const requestedItem = selectedNodeKey ? navigationItemByKey.get(selectedNodeKey) : undefined;
  const requestedFamily =
    requestedItem?.type === "preset"
      ? resolveModelProviderFamilySpecByProviderId(requestedItem.presetId)
      : null;
  // [契约] 这里只读已保存选择，不读 pending：可用性判定必须基于事实，而不是乐观值。
  // family 无 spec 时为 undefined，此时 navigationUnavailable 不会因它成立。
  // 不要把它替换成 mergedSelections，否则乐观选择会让「不可用」提示闪一下。
  const requestedSelection = requestedFamily ? connectionSelections[requestedFamily.id] : undefined;
  // [契约] 三个前置条件缺一不可：不在加载中、不是设置失败、且确实找不到可用连接。
  // start-plan 的 selection 被排除在「失效」之外，因为它本来就没有对应具体节点。
  // `navigationUnavailable` 只驱动提示展示，不阻止侧栏渲染；不可拿来做早退。
  const navigationUnavailable =
    !modelProvidersLoading &&
    !familyConnectionSettingsLoading &&
    (familyConnectionSettingsFailed ||
      Boolean(
        requestedFamily &&
        requestedSelection &&
        requestedSelection.kind !== "start-plan" &&
        !selectableNavigationItems.some((item) =>
          connectionSelectionMatchesNavigationItem(requestedFamily.id, requestedSelection, item),
        ),
      ));

  // [契约] fallback 在每次渲染都计算，不受 selectedNodeKey 是否有效影响，保证 effect 可以直接用。
  // 传入的是 selectableNavigationItems（右侧集合），不是侧栏集合，见 INV-13。
  // 返回 null 表示一个可用节点都没有，此时 effect 不应调用 setSelectedNodeKey。
  const fallbackNodeKey = resolveFallbackModelProviderNodeKey({
    selectedNodeKey,
    selectableNavigationItems,
  });
  useEffect(() => {
    // [并发] 判断「当前选中是否还存在」必须用侧栏集合，因为侧栏才是用户看到的列表。
    // null 视为不存在，因此首次挂载会走进 fallback 分支完成初始化。
    // 不要改成 navigationItemByKey：右侧独有的节点会让这里永远为真，用户切过去后侧栏没有高亮。
    const hasSelectedNode = selectedNodeKey ? sideNavigationItemByKey.has(selectedNodeKey) : false;
    if (hasSelectedNode) {
      return;
    }

    // [并发] 这个比较避免用相同值反复调用 setState，造成父组件无谓重渲染。
    // fallbackNodeKey 为 null 时若当前选中也非空，会写回 null——这是刻意的「没有可用节点」表达。
    // 不要在 effect 里再判一遍 hasSelectedNode，上面的早退已覆盖。
    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [
    fallbackNodeKey,
    selectedNavItem,
    selectedNodeKey,
    setSelectedNodeKey,
    sideNavigationItemByKey,
  ]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
  };
}

// [契约] null 表示「未知 family」或「尚未登录」，此时不过滤，展示全部套餐引导用户登录。
// 比较的是 OAuth provider 归属的 family，不是套餐自己的 family，两者概念不同。
// 新增 family 时只需让 resolveProviderFamilyDomainFromOAuthProvider 认识它，不必改这里。
function shouldShowCodingPlanForProviderFamilyDomain(
  oauthProviderId: OAuthProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null,
): boolean {
  if (!providerFamilyDomain) {
    return true;
  }
  return resolveProviderFamilyDomainFromOAuthProvider(oauthProviderId) === providerFamilyDomain;
}

function resolvePresetFamilyStatusProvider({
  presetId,
  provider,
  connectionModeItems,
  connectionSelections,
  modelProviders,
}: {
  presetId: PresetProviderSpec["id"];
  provider: ProviderSettingsFormProvider | null;
  connectionModeItems: ModelProviderNavGroup["items"];
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  modelProviders: ProviderSettingsFormProvider[];
}): ProviderSettingsFormProvider | null {
  // [契约] 没有 family spec 的 preset 是独立 provider，直接把自己作为状态源返回。
  // family spec 存在时，状态必须来自「用户实际选择的连接方式」，见 INV-17。
  // 不要在这里捕获异常：查找失败是数据问题，应该显式回流成 null。
  const familySpec = resolveModelProviderFamilySpecByProviderId(presetId);
  if (!familySpec) {
    return provider;
  }
  // [契约] 先剔除 loading 再匹配，避免把占位项当成用户选择。
  // 匹配依赖 connectionSelections 的真实值，不传 pending。
  // 返回 null 或非 plan 项都表示「当前没有有效套餐连接」，此时不点灯。
  const connectionItem = pickFamilyModeNavigationItem(
    connectionModeItems.filter((item) => item.type !== "codingPlanLoading"),
    familySpec.id,
    connectionSelections,
  );
  if (!connectionItem || !isPlanConnectionNavigationItem(connectionItem)) {
    return null;
  }
  // 菜单 Team 项可能从个人项派生，携带的 provider 不是团队执行身份。
  // 必须按具体套餐 ID 回到 Settings View，不能用菜单权益或继承的 provider 点灯。
  return (
    modelProviders.find((candidate) => candidate.providerId === connectionItem.presetId) ?? null
  );
}

export function resolveFallbackModelProviderNodeKey({
  selectedNodeKey,
  selectableNavigationItems,
}: {
  selectedNodeKey: string | null;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
}): string | null {
  // [契约] 初始化优先级由 pickInitialConnectionNavigationItem 统一决定，见 INV-13。
  // 这里的结果只用于「选中项消失」时的回落，不影响用户当前的合法选择。
  // 不要在这里加 family 过滤：初始化的语义是全局第一个可用项。
  const initialConnectionItem = pickInitialConnectionNavigationItem(selectableNavigationItems);
  const initialSideNodeKey = initialConnectionItem
    ? resolveSideNavigationNodeKeyForConnectionItem(initialConnectionItem)
    : null;
  if (isFamilyPresetNodeKey(selectedNodeKey) && initialSideNodeKey) {
    // App OAuth 登录成功后会按 active provider 隐藏另一组预置入口。
    // 当前选中项消失时使用初始化优先级回落到对应 family，而不是把连接方式塞回侧栏。
    return initialSideNodeKey;
  }

  // 初始化只在没有有效选中项时发生；如果当前用户选择仍有效，上层 effect 不会调用 fallback 抢焦点。
  return (
    initialSideNodeKey ??
    resolveSideNavigationNodeKeyForConnectionItem(selectableNavigationItems[0] ?? null)
  );
}

function resolveSelectedProviderFamilyConnectionItem({
  selectedNodeKey,
  navigationItemByKey,
  selectableNavigationItems,
  connectionSelections,
  pendingConnectionSelections,
  familyConnectionSettingsLoading,
  familyConnectionSettingsFailed,
  modelProvidersLoading,
}: {
  selectedNodeKey: string;
  navigationItemByKey: Map<
    string,
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  modelProvidersLoading?: boolean;
}): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  // [契约] 先查 Map 再判类型：查不到就返回 null，让详情页进入 loading。
  // 这里用的是可选项集合，因此侧栏不存在的节点也能解析出详情。
  // 非 preset 类型直接原样返回，不参与 family 折算。
  const selectedItem = navigationItemByKey.get(selectedNodeKey) ?? null;
  if (!selectedItem) {
    return null;
  }
  if (selectedItem.type !== "preset") {
    return selectedItem;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedItem.presetId);
  if (!familySpec) {
    return selectedItem;
  }
  if (familyConnectionSettingsLoading) {
    // 从外部入口打开 Model Settings 时，settings 首次 hydrate 前不能按默认 oauth
    // 连接方式推导 Start Plan，否则右侧连接方式会先闪成 Start 再按已保存设置纠偏。
    return null;
  }
  // [契约] pending 在后覆盖已保存值，与连接方式的可见性计算保持同一优先级。
  // 合并只用于查找，不写回任何 store 或偏好。
  // 不要把合并结果缓存到 ref：每次渲染重新合并的成本远低于失效风险。
  const mergedSelections = { ...connectionSelections, ...pendingConnectionSelections };
  const resolvedItem =
    !familyConnectionSettingsFailed &&
    pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, mergedSelections);
  if (resolvedItem) {
    return resolvedItem;
  }
  if (modelProvidersLoading) return null;
  // 非法/过期连接只影响当前设置页的落点，不能让 null 被详情页当作永久 loading。
  // 不写回 Family 偏好，不改会话 Selection；用户可在这个同 Family 页面重新选择。
  return pickInitialConnectionNavigationItem(
    selectableNavigationItems.filter(
      (item) =>
        "presetId" in item &&
        resolveModelProviderFamilySpecByProviderId(item.presetId)?.id === familySpec.id,
    ),
  );
}

function resolveSideNavigationNodeKeyForConnectionItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null,
): string | null {
  if (!item) {
    return null;
  }
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) return item.key;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
  if (!familySpec) {
    return item.key;
  }
  return createPresetProviderNodeKey(familySpec.startPlanProviderId);
}

function pickInitialConnectionNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  // [契约] planItems 只含个人编码套餐与团队套餐，Start Plan 被刻意排除。
  // 这个类型守卫同时服务初始化优先级与 family 折算，改它会连带影响两处。
  // 过滤顺序即原始顺序，后续 find 的结果因此是确定的。
  const planItems = selectableNavigationItems.filter(isPlanConnectionNavigationItem);
  const personalCodingPlanItem = planItems.find(
    (item) =>
      item.type === "codingPlan" &&
      !isStartPlanModelProviderId(item.presetId) &&
      item.status === "purchased",
  );
  if (personalCodingPlanItem) {
    return personalCodingPlanItem;
  }
  // [契约] 团队套餐优先于「未购买的个人套餐」，但低于「已购买的个人套餐」。
  // 多个团队套餐时取第一个，顺序由上游列表决定，不要在这里排序。
  // 这里只判类型，不校验组织/项目，具体匹配在连接选择匹配函数里。
  const teamPlanItem = planItems.find((item) => item.type === "teamPlan");
  if (teamPlanItem) {
    return teamPlanItem;
  }
  const personalCodingPlanFallback = planItems.find(
    (item) => item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId),
  );
  if (personalCodingPlanFallback) {
    return personalCodingPlanFallback;
  }
  if (planItems[0]) {
    return planItems[0];
  }
  return selectableNavigationItems.find((item) => item.type === "preset") ?? null;
}

function pickFamilyModeNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
  familyId: "zai" | "bigmodel",
  connectionSelections: ProviderFamilyConnectionSelectionSettings,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const selection = connectionSelections[familyId];
  if (!selection) return null;
  return (
    selectableNavigationItems.find((item) =>
      connectionSelectionMatchesNavigationItem(familyId, selection, item),
    ) ?? null
  );
}

export function resolveSelectedFamilyModeNodeKey({
  selectedNavItem,
  selectableNavigationItems,
  connectionSelections = {},
  pendingConnectionSelections = {},
}: {
  selectedNavItem: Exclude<
    ModelProviderNavGroup["items"][number],
    { type: "codingPlanLoading" }
  > | null;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): string | null {
  if (
    selectedNavItem?.type !== "preset" &&
    selectedNavItem?.type !== "codingPlan" &&
    selectedNavItem?.type !== "teamPlan"
  ) {
    return null;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
  if (!familySpec) {
    return null;
  }
  // [契约] 这里传的是 merged（已保存 + pending），因为这是用户可见的当前选择。
  // 返回 key 与当前选中不同才提示「可切换」，相同时返回 null 避免无意义跳转。
  // 不要把返回值直接用于设置选中：是否跳转由调用方决定。
  const savedItem = pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, {
    ...connectionSelections,
    ...pendingConnectionSelections,
  });
  return savedItem && savedItem.key !== selectedNavItem.key ? savedItem.key : null;
}

export function connectionSelectionMatchesNavigationItem(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): boolean {
  if (item.type === "custom") return false;
  // [契约] 用空串兜底而不是直接传 undefined：查找函数要求 string，空串保证返回 undefined 而不是抛错。
  // custom 项已在函数首行返回 false，因此这里的 item 一定带 presetId 或属于其它类型。
  // family 不一致立即返回 false，后续分支不再重复判断。
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId ?? "");
  if (familySpec?.id !== family) return false;
  // [契约] start-plan 表示「用 family 的起始套餐」，不对应任何独立导航节点，因此永远不匹配。
  // 不要为了「更宽松」让它匹配 Start Plan 节点：那会让侧栏落点从 preset 跳到套餐。
  // 这个分支必须早于 individual-coding-plan 分支，否则 start-plan 会被后续条件误命中。
  if (selection.kind === "start-plan") {
    return false;
  }
  // [契约] 个人套餐连接按 individualCodingPlanProviderId 精确匹配，family 不同则上面已返回 false。
  // 必须同时判 item.type，光比 presetId 会让团队套餐的 id 意外命中。
  // 返回值是布尔，不做「最接近项」的模糊匹配。
  if (selection.kind === "individual-coding-plan") {
    return (
      item.type === "codingPlan" && item.presetId === familySpec.individualCodingPlanProviderId
    );
  }
  return (
    item.type === "teamPlan" &&
    item.presetId === familySpec.teamCodingPlanProviderId &&
    // 团队连接按平台、组织和项目定位；订阅商品会在权益快照和 pricing 校正间变化。
    // 不能把同项目的商品更新误判为连接丢失，否则初始化会出现空选项和错误提示。
    item.organizationId === selection.organizationId &&
    item.projectId === selection.projectId
  );
}

function isPlanConnectionNavigationItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): item is Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" | "teamPlan" }> {
  return (
    (item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId)) ||
    item.type === "teamPlan"
  );
}

// [契约] 这个判断只认「编码套餐/团队套餐」与两个 family 的 start-plan preset 节点。
// 用 startsWith 前缀判断而不是查表，是因为 key 前缀本身就是 utils 定义的稳定契约。
// 新增 family 时必须同步补齐 startPlanProviderId 分支，否则回落不会生效。
function isFamilyPresetNodeKey(nodeKey: string | null): boolean {
  return (
    nodeKey?.startsWith("coding-plan:") === true ||
    nodeKey?.startsWith("team:") === true ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan}` ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`
  );
}
