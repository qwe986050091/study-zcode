// INV-01 团队身份不整组隐藏：守住位置 可用性判定；改错故障：当前团队不可用导致其他团队入口一起消失。
// INV-02 未知不等于不可用：守住位置 可用性比较的严格相等；改错故障：状态未知的团队被隐藏。
// INV-03 补充行条件：守住位置 缺失 Provider 的过滤链；改错故障：已禁用或非账号供应商被补进行内。
// INV-04 键格式统一：守住位置 连接键序列化；改错故障：同一选择生成两种键，选中态丢失。
// INV-05 团队键五元：守住位置 团队分支的数组；改错故障：不同项目折叠成同一连接。
// INV-06 回退首项：守住位置 模型选择回退；改错故障：找不到模型时返回空值，下拉首项空白。
// INV-07 计划与其余分桶：守住位置 开始计划排除；改错故障：开始计划被当作可切换连接。
// INV-08 个人分支：守住位置 个人套餐识别；改错故障：个人套餐被当作团队处理。
// INV-09 订阅过滤：守住位置 已订阅与标识非空判断；改错故障：未订阅或空标识的商品生成连接。
// INV-10 项目展开：守住位置 团队项目数组回退；改错故障：无子项目的商品整条丢失。
// INV-11 标签生成：守住位置 团队展示名调用；改错故障：同名项目连接无法区分。
// INV-12 空字段跳过：守住位置 组织、项目、标签的判空；改错故障：残缺商品生成不可用连接。
// INV-13 不可用跳过：守住位置 密钥状态判断；改错故障：凭据不可用的团队仍可选中。
// INV-14 去重：守住位置 已见集合；改错故障：重复项目生成重复行。
// INV-15 当前团队过期：守住位置 过期跳过条件；改错故障：当前团队被移出列表而看不到过期提示。
// INV-16 无团队目录：守住位置 保留原组条件；改错故障：目录晚到时整个 Provider 消失。
// INV-17 排序稳定：守住位置 个人先于团队的比较器；改错故障：同品牌内顺序抖动。
// INV-18 纯函数：守住位置 本文件全部导出；改错故障：读取全局状态导致同输入不同结果。
//
// 模块职责：把模型分组、账号商品与设置视图合成为输入框可用的计划分组，按个人与团队拆分连接。
// 状态所有权：无状态；全部输入由调用方传入，输出为新的分组数组。
// 阅读顺序：数据结构 → 连接键与模型选择 → 分组构建 → 团队项目展开 → 排序输出。
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import {
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyDomain,
  type ProviderFamilyConnectionSelection,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";
// 连接描述：一个可切换的模型来源，键决定选中态，标签决定展示名。
// 团队连接的键包含商品、组织与项目，个人连接只含家族与类型。
//
export interface ComposerConnection {
  key: string;
  label: string;
  providerId: string;
  family: ProviderFamilyDomain;
  selection?: ProviderFamilyConnectionSelection;
  items: ModelSelectGroupItem[];
  disabled?: boolean;
}
// 计划分组：在模型分组上附带连接信息，没有连接的分组归入其余列表。
// 分组键沿用原分组键，团队连接会被覆盖成连接键。
//
export interface ComposerPlanGroup extends ModelSelectGroup {
  connection?: ComposerConnection;
}
// 账号商品：订阅状态、组织与项目信息都来自设置视图。
// 团队项目可为空，为空时商品自身充当唯一项目。
//
interface TeamProduct {
  family?: ProviderFamilyDomain;
  productId: string;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  apiKeyStatus?: string | null;
  teamProjects?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projectId?: string | null;
    apiKeyStatus?: string | null;
  }> | null;
}
// 连接键：序列化成字符串，团队选择必须带上完整五元组。
// 只带家族与类型会让同家族的不同项目共享键，选中态互相覆盖。
//
export function composerConnectionKey(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
) {
  return JSON.stringify(
    selection.kind === "team-coding-plan"
      ? [family, selection.kind, selection.productId, selection.organizationId, selection.projectId]
      : [family, selection.kind],
  );
}
// `chooseConnectionModel` 先按名称精确匹配并在未命中时回退 `items[0]`，保证切换连接后仍有可用模型。
// 回退保证切换到新连接时总有一个可用模型，不会留空。
//
export function chooseConnectionModel(items: readonly ModelSelectGroupItem[], model?: string) {
  return items.find((item) => item.name === model) ?? items[0];
}
/** 只投影账号套餐行；API、自定义供应商及模型目录仍沿用原始对象。 */
// 分组构建：先补齐缺失的账号 Provider 行，再按家族拆个人、团队与其余三类。
// 团队 Provider 的可用性不能用来整组隐藏，因为同 ID 下有多个团队身份。
// 补充行只针对已启用、可用且带账号访问方式的供应商。
//
export function buildComposerPlanGroups(
  groups: readonly ModelSelectGroup[],
  products: readonly TeamProduct[],
  settingsView?: ProviderSettingsView | null,
  agentProvider: ZCodeProvider = "glm",
  labels: ModelProviderGroupLabelOptions = {},
  selections?: Partial<Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>>,
): ComposerPlanGroup[] {
  // 原因：团队共用 Provider ID，服务状态只校验当前团队；不能整组隐藏其他团队身份。
  // 可用性：只有明确标记不可用才算不可用，未知状态保持可见。
  // 该判定同时用于团队项目跳过与补充行过滤。
  //
  const isAvailable = (providerId: string) =>
    settingsView?.providers.find((provider) => provider.providerId === providerId)?.accountState
      ?.availability !== "unavailable";
  const isTeamProvider = (providerId: string) =>
    providerId === resolveModelProviderFamilySpecByProviderId(providerId)?.teamCodingPlanProviderId;
  const includeProvider = (providerId: string) =>
    isTeamProvider(providerId) || isAvailable(providerId);
  const missing =
    settingsView?.providers
      .filter(
        (p) =>
          !groups.some((g) => g.key === `registry-provider:${p.providerId}`) &&
          p.enabled &&
          includeProvider(p.providerId) &&
          p.effectiveConfig.access?.type === "zhipu-account" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            (p.effectiveConfig.access.mode === "individual-coding-plan" &&
              p.accountState?.availability === "available" &&
              p.accountState.entitled)),
      )
      .map((p) => ({ providerId: p.providerId, config: p.effectiveConfig, models: [] })) ?? [];
  // 候选集合：原分组按 Provider 可用性过滤，再拼上补充生成的账号行。
  // 补充行需要当前语言标签，否则回退成英文个人套餐名。
  //
  const candidates = [
    ...groups.filter((group) => includeProvider(group.key.replace(/^registry-provider:/, ""))),
    // 原因：未激活个人套餐由此补充；漏传当前语言会回退成英文 Individual。
    ...buildRegistryModelSelectGroups(
      agentProvider,
      {
        revision: 0,
        providers: missing,
      } as ModelSelectionView,
      labels,
    ),
  ];
  const plans: ComposerPlanGroup[] = [];
  const others: ComposerPlanGroup[] = [];
  for (const group of candidates) {
    const providerId = group.key.replace(/^registry-provider:/, "");
    const spec = resolveModelProviderFamilySpecByProviderId(providerId);
    if (!spec || providerId === spec.startPlanProviderId) {
      others.push(group);
      continue;
    }
    if (providerId === spec.individualCodingPlanProviderId) {
      const selection = { kind: "individual-coding-plan" as const };
      plans.push({
        ...group,
        connection: {
          key: group.key,
          label: group.labelBadge ?? "",
          providerId,
          family: spec.id,
          selection,
          items: group.items,
        },
      });
      continue;
    }
    if (providerId !== spec.teamCodingPlanProviderId) {
      others.push(group);
      continue;
    }
    // 去重集合：以连接键为单位，保证同一团队项目只出现一次。
    // 键在加入前先查重，重复项直接跳过。
    //
    const seen = new Set<string>();
    for (const product of products) {
      if (
        (product.family ?? "bigmodel") !== spec.id ||
        product.subscribed !== true ||
        !product.productId.trim()
      )
        continue;
      for (const project of product.teamProjects?.length ? product.teamProjects : [product]) {
        const organizationId = project.organizationId?.trim();
        const projectId = project.projectId?.trim();
        const label = formatTeamPlanDisplayName({
          organizationName: project.organizationName ?? product.organizationName,
        });
        // 不可用是明确的凭据事实；unknown 仅表示尚未确认，不能误当不可用隐藏。
        if (
          !organizationId ||
          !projectId ||
          !label ||
          (project.apiKeyStatus ?? product.apiKeyStatus) === "unavailable"
        )
          continue;
        const selection = {
          kind: "team-coding-plan" as const,
          productId: product.productId,
          organizationId,
          projectId,
        };
        const key = composerConnectionKey(spec.id, selection);
        const selected = selections?.[spec.id];
        // 当前团队过期不能补回；其他团队的状态未知时仍允许用户切换。
        if (
          !isAvailable(providerId) &&
          selected?.kind === "team-coding-plan" &&
          key === composerConnectionKey(spec.id, selected)
        )
          continue;
        if (seen.has(key)) continue;
        seen.add(key);
        plans.push({
          ...group,
          key,
          labelBadge: label,
          connection: {
            key,
            label,
            providerId,
            family: spec.id,
            selection,
            items: group.items,
          },
        });
      }
    }
    // 目录晚到时保留当前 Provider 身份，不能把团队同名模型错勾到个人行。
    if (
      // 无团队目录：商品列表里还没有该家族时，保留原分组并沿用原键。
      // 保留可避免目录晚到造成 Provider 入口整段消失。
      //
      !seen.size &&
      isAvailable(providerId) &&
      group.items.length &&
      !products.some((product) => (product.family ?? "bigmodel") === spec.id)
    )
      plans.push(group);
  }
  // 同品牌个人排在团队之前；API 与 Start Plan 内部顺序不变。
  return [
    ...plans.sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        Number(a.connection?.selection?.kind === "team-coding-plan") -
          Number(b.connection?.selection?.kind === "team-coding-plan"),
    ),
    ...others,
  ];
}
