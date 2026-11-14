// INV-01 个人来源的 id 直接等于 providerId：守住位置 个人构造函数；改错故障：另造一套 id 会让偏好持久化对不上来源。
// INV-02 个人标签先去空白再判空：守住位置 标签归一；改错故障：只含空白的标签会让侧栏出现空白项。
// INV-03 个人标签缺失时按内置 provider 区分默认文案：守住位置 兜底分支；改错故障：统一兜底会把两个品牌显示成同一个名字。
// INV-04 团队产品没有项目清单时回退为单项目上下文：守住位置 上下文展开；改错故障：空数组会让该产品的团队套餐整条消失。
// INV-05 组织号与项目号都非空才生成来源：守住位置 早退判断；改错故障：半截身份会让额度查询打到错误的组织。
// INV-06 标签为空时不生成来源：守住位置 标签判空；改错故障：会产出只有品牌前缀的空白来源。
// INV-07 sourceId 由固定五段编码后以冒号连接：守住位置 复合键构造；改错故障：直接拼接会让含冒号的字段产生键碰撞。
// INV-08 团队 sourceId 去重，重复直接丢弃：守住位置 集合判重；改错故障：重复来源会让侧栏出现两张相同额度卡。
// INV-09 providerId 由产品家族规格给出：守住位置 家族推导；改错故障：硬编码单一品牌会让另一家族挂到错误的 provider。
// INV-10 账户接入必须是团队套餐模式才产出：守住位置 模式判断；改错故障：个人接入被当成团队会让额度口径错乱。
// INV-11 账户接入按家族从接入表取：守住位置 家族索引；改错故障：跨家族取接入会让团队套餐读到别人的凭证。
// INV-12 sourceId 各段都做 URI 编码：守住位置 键拼接；改错故障：未编码的斜杠会破坏复合键的段边界。
// INV-13 当前来源解析先由 providerId 反查家族：守住位置 解析入口；改错故障：跳过反查会让家族判断依赖调用方传参。
// INV-14 家族解析失败返回空：守住位置 首段判断；改错故障：返回残缺来源会让用量面板显示不可用的额度。
// INV-15 团队选择按产品、组织、项目三项精确匹配：守住位置 来源查找；改错故障：只比产品会在多组织下选错来源。
// INV-16 团队匹配不到时返回空而不回退个人：守住位置 团队分支末尾；改错故障：回退会把团队额度显示成个人额度。
// INV-17 个人分支要求接入模式为个人套餐：守住位置 个人判断；改错故障：模式不符仍返回会让额度查询必然失败。
// INV-18 展示标签的品牌前缀按家族规格取：守住位置 标签格式化；改错故障：硬编码前缀会让另一家族的团队来源显示错位。
//
// 模块职责：把账户接入与团队订阅产品归一为侧栏用量来源，并按当前选择解析出应展示的来源。
// 状态所有权：无状态；去重集合、项目上下文与中间来源都是单次调用的局部值。
// 阅读顺序：先看个人来源构造，再看团队来源的上下文展开与去重，最后看当前来源解析与标签格式化。
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";

// 侧栏用量来源的统一形态：id、providerId、展示标签与账户接入
// 个人来源的 id 直接等于 providerId，团队来源的 id 是编码后的复合键
// [失败路径] 两者混用会让选择持久化读到错误的来源
// accountAccess 同时容纳个人与团队两种接入形态，由联合类型收窄
// 下游只按 id 比较，不解析 id 内部结构
// 该形态只描述展示所需，不含额度数值本身
export interface CodingPlanUsageSource {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

// 个人来源只需 providerId 与账户接入，标签可选
// 标签先去空白，空串按缺失处理
// [失败路径] 直接使用未去空白的标签会让侧栏出现只有空格的项
// 缺省文案按内置 provider 区分 Z.ai 与 BigModel
// id 与 providerId 同值，保证个人来源没有第二套身份
// 个人来源不携带团队组织与项目身份
export function buildPersonalCodingPlanUsageSource({
  providerId,
  accountAccess,
  label,
}: {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string | null;
}): CodingPlanUsageSource {
  const normalizedLabel = label?.trim();
  return {
    id: providerId,
    providerId,
    accountAccess,
    label:
      normalizedLabel ||
      (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        ? "Z.ai - Coding Plan"
        : "BigModel - Coding Plan"),
  };
}

export type CurrentSidebarCodingPlanUsageSource =
  | {
      audience: "individual";
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
      teamSource?: never;
    }
  | {
      audience: "team";
      // 原硬绑 bigmodelCodingPlan，zai team plan 的 currentUsageSource
      // 无法表达 zai providerId。松开为 SidebarUsageCodingPlanProviderId，
      // zai/bigmodel team 都按各自 selectedKey 解析出的 providerId 表达。
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      teamSource: CodingPlanUsageSource;
    };

// 对外入口只做转交，团队来源的全部展开逻辑在同模块的私有函数里
// [边界] accountAccesses 以家族为键，允许只配置部分家族
// 订阅产品列表 `subscribedTeamProducts` 是唯一输入，不再另读账户状态。
// 返回顺序沿用 `subscribedTeamProducts` 的顺序，去重只丢弃重复项。
// 调用方按 `buildCodingPlanUsageSources` 的返回顺序渲染，去重不改变首次出现的位置。
export function buildCodingPlanUsageSources({
  accountAccesses,
  subscribedTeamProducts,
}: {
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): CodingPlanUsageSource[] {
  return buildTeamCodingPlanUsageSources(subscribedTeamProducts, accountAccesses);
}

// 逐个团队订阅产品展开，产品内的项目上下文再展开一层
// [边界] 产品没有项目清单时回退为只含自身组织与项目的一条上下文
// 组织号与项目号任一为空就不生成来源，避免半截身份
// 标签缺失同样跳过，不生成只有品牌前缀的空白来源
// sourceId 由团队标记、家族、产品、组织、项目五段编码后连接
// [失败路径] 不按家族取 providerId 会让 zai 团队来源挂到 bigmodel 上
function buildTeamCodingPlanUsageSources(
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[],
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>,
): CodingPlanUsageSource[] {
  const seen = new Set<string>();
  return subscribedTeamProducts.flatMap((product) => {
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
            },
          ];

    return projectContexts.flatMap((projectContext, index) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        return [];
      }
      const label = formatTeamUsageSourceLabel({
        product,
        organizationId,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectId,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!label) {
        // Team Plan usage source 只展示组织名；缺失时不能生成 "BigModel - " 空白来源。
        return [];
      }
      const projectKey = projectId || String(index);
      // 原 createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId
      // 硬编码 bigmodel，zai team product 的 sourceId 用了 bigmodel 前缀、providerId 也错。
      // 按 product.family 用 family-aware key + 对应 codingPlan providerId。
      const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
      const baseAccess = accountAccesses[productFamily];
      if (baseAccess?.mode !== "team-coding-plan") {
        return [];
      }
      const codingPlanProviderId =
        getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId;
      const sourceId = ["team", productFamily, product.productId, organizationId, projectKey]
        .map(encodeURIComponent)
        .join(":") as SidebarUsageCodingPlanSourceId;
      if (seen.has(sourceId)) {
        return [];
      }
      seen.add(sourceId);
      return [
        {
          id: sourceId,
          providerId: codingPlanProviderId,
          accountAccess: {
            type: "zhipu-account",
            family: productFamily,
            planKind: "team-coding-plan",
            productId: product.productId,
            organizationId,
            projectId,
          },
          label,
        },
      ];
    });
  });
}

// 先由选中的 providerId 反查家族，查不到直接返回空
// 团队选择按产品、组织、项目三项精确匹配已有来源
// [失败路径] 团队匹配不足时回退个人来源，会把团队额度显示成个人额度
// 只有选择明确是个人套餐且接入模式一致时才走个人分支
// 个人来源的 providerId 由家族规格给出，不在调用处硬编码
// 选择为空或家族不明时一律返回空，交由上层隐藏面板
export function resolveSidebarCurrentCodingPlanUsageSource({
  selections,
  selectedProviderId,
  accountAccesses,
  teamSources,
}: {
  selections?: ProviderFamilyConnectionSelectionSettings | null;
  selectedProviderId: string | null;
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  teamSources: CodingPlanUsageSource[];
}): CurrentSidebarCodingPlanUsageSource | null {
  const family = selectedProviderId
    ? resolveModelProviderFamilySpecByProviderId(selectedProviderId)?.id
    : undefined;
  if (!family) return null;
  const selection = selections?.[family];
  if (selection?.kind === "team-coding-plan") {
    const teamSource = teamSources.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.family === family &&
        source.accountAccess.productId === selection.productId &&
        source.accountAccess.organizationId === selection.organizationId &&
        source.accountAccess.projectId === selection.projectId,
    );
    return teamSource
      ? {
          audience: "team",
          providerId: teamSource.providerId,
          sourceId: teamSource.id,
          teamSource,
        }
      : null;
  }
  if (selection?.kind !== "individual-coding-plan") return null;
  const accountAccess = accountAccesses[family];
  if (!accountAccess || accountAccess.mode !== "individual-coding-plan") return null;
  const providerId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return { audience: "individual", providerId, sourceId: providerId, accountAccess };
}

export function matchesTeamPlanUsageSourceKey(sourceId: string, selectedKey: string): boolean {
  return sourceId === selectedKey;
}

// 先把产品与项目上下文交给团队套餐名格式化，拿不到名字就返回空
// 品牌前缀按产品家族规格的 label 取，与侧栏用量项的品牌一致
// [失败路径] 硬编码单一品牌前缀会让另一家族的团队来源显示错位
// 最终标签是品牌前缀加团队套餐名
function formatTeamUsageSourceLabel({
  product,
  organizationId,
  organizationName,
  projectId,
  projectName,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
}): string | null {
  const teamPlanName = formatTeamPlanDisplayName({
    ...product,
    organizationId,
    organizationName,
    projectId,
    projectName,
  });
  if (!teamPlanName) {
    return null;
  }
  // 原硬编码 "BigModel - " 前缀，zai team source 显示出来品牌也错位。
  // 按 product.family 取品牌前缀，与 codingPlanItem.providerName 对齐。
  const brandPrefix = `${getModelProviderFamilySpec(resolveEnterpriseCodingPlanProductFamily(product)).label} - `;
  return `${brandPrefix}${teamPlanName}`;
}
