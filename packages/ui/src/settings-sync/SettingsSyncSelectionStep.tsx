// INV-01 纯展示：守住位置 组件入参；改错故障：步骤自行请求发现结果，引导流程出现双份数据源。
// INV-02 选择键格式：守住位置 getSelectionKey 的拼接；改错故障：不同分类的同名 Agent 互相勾选。
// INV-03 分类顺序固定：守住位置 CATEGORY_ORDER；改错故障：分组顺序随发现结果返回顺序抖动。
// INV-04 并集只取已登记：守住位置 unionCategories 的过滤；改错故障：未知分类渲染出空分组。
// INV-05 分类内 Agent：守住位置 agentsWithCategory；改错故障：列表与计数使用两套筛选，结果不一致。
// INV-06 全选按实际条目：守住位置 total 的来源；改错故障：全选按钮勾选后仍有条目未选。
// INV-07 三态互斥：守住位置 allSelected 与 partiallySelected；改错故障：全选同时显示减号。
// INV-08 空分类禁用：守住位置 total 为零时的禁用；改错故障：空分组出现可点击的全选框。
// INV-09 事件不冒泡：守住位置 全选点击的 stopPropagation；改错故障：勾选分类同时触发行点击。
// INV-10 阻止默认：守住位置 preventDefault；改错故障：按钮触发页面滚动或表单提交。
// INV-11 回调上抛：守住位置 onToggleSelection 与批量回调；改错故障：组件内部维护已选，父级状态不同步。
// INV-12 集合查询：守住位置 Set 化；改错故障：逐项数组查找导致大列表卡顿。
// INV-13 引用依赖：守住位置 useMemo 的依赖数组；改错故障：已选变化后视图不更新。
// INV-14 名称回落：守住位置 formatAgentName 的默认分支；改错故障：未知 Agent 渲染为空白行。
// INV-15 描述回落：守住位置 formatCategoryDescription 的默认分支；改错故障：未知分类没有说明文字。
// INV-16 图标统一：守住位置 renderProviderCliIcon 调用；改错故障：各家 Agent 图标风格不一。
// INV-17 无障碍标签：守住位置 全选按钮的 aria-label；改错故障：读屏只念「按钮」。
// INV-18 文案全走字典：守住位置 所有 formatMessage；改错故障：界面混入硬编码语言。
//
// 模块职责：渲染设置同步引导中的分类与 Agent 勾选列表，并把勾选变化交给上层处理。
// 状态所有权：发现结果与已选键属于上层；本层只派生集合与计数。
// 阅读顺序：选择键与顺序 → 并集与筛选 → 文案格式化 → 步骤主体 → 三态判定。
import { useMemo } from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import type { SettingsSyncCategory, SettingsSyncDiscoveryResult } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { renderProviderCliIcon } from "@/lib/providerCliIcon.js";

// 选择键由 Agent 与分类拼成，保证跨分类互不干扰。
// 分隔符固定为冒号，两侧标识内不允许出现该字符。
// 键只用于比较，不解析回原始字段。
//
function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

// 分类展示顺序在此固定，新增分类必须同步加入这个数组。
// 顺序同时决定并集结果，发现结果里多出的分类不会显示。
// 数组顺序即渲染顺序，不在这里做排序或去重。
//
const CATEGORY_ORDER: SettingsSyncCategory[] = ["providers", "skills"];

// 先收集所有出现过的分类，再按固定顺序过滤，输出稳定。
// 没有任何分类的 Agent 不贡献类别，也不影响空态判断。
// 结果只含已登记分类，未登记分类在这里被静默丢弃。
//
function unionCategories(agents: SettingsSyncDiscoveryResult["agents"]): SettingsSyncCategory[] {
  const found = new Set<SettingsSyncCategory>();
  for (const agent of agents) {
    for (const c of agent.categories) {
      found.add(c.category);
    }
  }
  return CATEGORY_ORDER.filter((c) => found.has(c));
}

// 只保留拥有该分类的 Agent，勾选统计与列表共用这一结果。
// `agentsWithCategory` 结果为空时仍展示分组，但全选按钮禁用。
//
function agentsWithCategory(
  agents: SettingsSyncDiscoveryResult["agents"],
  category: SettingsSyncCategory,
) {
  return agents.filter((a) => a.categories.some((c) => c.category === category));
}

// Agent 名走字典，未知标识原样返回，避免出现空白行。
// 缺省分支是排障入口：出现原始标识即说明字典漏配。
//
function formatAgentName(agent: string, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  switch (agent) {
    case "zcode":
      return intl.formatMessage({ id: "settingsSync.agent.zcode" });
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    default:
      return agent;
  }
}

// 分类名同样走字典，未知分类回落原始值。
// 分类名同时用于全选按钮标签与组标题，两处共用同一函数。
//
function formatCategoryName(
  category: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  switch (category) {
    case "providers":
      return intl.formatMessage({ id: "settingsSync.category.providers" });
    case "skills":
      return intl.formatMessage({ id: "settingsSync.category.skills" });
    default:
      return category;
  }
}

// 描述只服务视觉，未知分类统一回落到默认说明。
// 描述与名称分开取键，改文案时互不牵连。
//
function formatCategoryDescription(
  category: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  switch (category) {
    case "providers":
      return intl.formatMessage({
        id: "settingsSync.category.providers.description",
      });
    case "skills":
      return intl.formatMessage({
        id: "settingsSync.category.skills.description",
      });
    default:
      return intl.formatMessage({
        id: "settingsSync.category.default.description",
      });
  }
}

/**
 * Onboarding 代理设置：与 MCP 平级的可勾选分类列表（当前仅模型供应商）；每类下为各 Agent。
 */
// 步骤只读发现结果：不请求也不改写，勾选变化全部通过回调上抛。
// 已选数组转成集合便于逐项查询，依赖数组变化时重建。
// 分类顺序先取并集再按固定顺序过滤，保证每次渲染一致。
//
export function SettingsSyncSelectionStep(props: {
  discovery: SettingsSyncDiscoveryResult;
  selectedKeys: string[];
  onToggleSelection: (key: string) => void;
  onSetCategorySelectionAllAgents: (category: SettingsSyncCategory, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = useMemo(() => new Set(props.selectedKeys), [props.selectedKeys]);

  const agents = props.discovery.agents;
  const categoriesInOrder = useMemo(() => unionCategories(agents), [agents]);

  return (
    <div className="flex w-full flex-col gap-4">
      {categoriesInOrder.map((category) => {
        const agentsForCategory = agentsWithCategory(agents, category);
        const total = agentsForCategory.length;
        const selectedForCategory = agentsForCategory.filter((agent) =>
          selected.has(getSelectionKey(agent.agent, category)),
        ).length;
        // `allSelected` / `partiallySelected` 组成三态：部分选中显示减号。
        // 两个布尔都要求 `total > 0`：空分类不显示任何勾。
        // `partiallySelected` 显式带 `selectedForCategory < total`，与全选互斥。
        //
        const allSelected = total > 0 && selectedForCategory === total;
        const partiallySelected =
          total > 0 && selectedForCategory > 0 && selectedForCategory < total;

        return (
          <div key={category} className="flex w-full flex-col gap-1">
            <div className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-surface-hover/50">
              <button
                type="button"
                className="flex size-5 shrink-0 items-center justify-start"
                disabled={total === 0}
                aria-label={intl.formatMessage(
                  { id: "onboarding.agentSettings.categoryToggleAllAria" },
                  { category: formatCategoryName(category, intl) },
                )}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onSetCategorySelectionAllAgents(category, !allSelected);
                }}
              >
                <div
                  className={cn(
                    "flex size-4 items-center justify-center rounded-sm border border-border",
                    allSelected && "border-primary bg-primary text-primary-foreground",
                    partiallySelected &&
                      !allSelected &&
                      "border-primary bg-primary/20 text-primary",
                  )}
                >
                  {allSelected ? (
                    <CheckIcon className="size-3.5" />
                  ) : partiallySelected ? (
                    <MinusIcon className="size-3.5" />
                  ) : null}
                </div>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-ui-base">
                  <div className="text-ui-base font-medium leading-none text-foreground">
                    {formatCategoryName(category, intl)}
                  </div>
                  <div className="min-w-0 truncate text-foreground-subtle">
                    {formatCategoryDescription(category, intl)}
                  </div>
                </div>
              </div>
            </div>
            <div className="ml-5 flex flex-col gap-1 border-l border-border py-1 pl-4">
              {agentsForCategory.map((agent) => {
                const key = getSelectionKey(agent.agent, category);
                const checked = selected.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => props.onToggleSelection(key)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors",
                      "hover:bg-surface-hover/50",
                    )}
                  >
                    <div className="flex size-5 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "flex size-4 items-center justify-center rounded-sm border border-border",
                          checked && "border-primary bg-primary text-primary-foreground",
                        )}
                      >
                        {checked ? <CheckIcon className="size-3.5" /> : null}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {renderProviderCliIcon("glm", "size-4 shrink-0 text-foreground")}
                      <div className="min-w-0 flex-1">
                        <div className="text-ui-base font-medium leading-none text-foreground">
                          {formatAgentName(agent.agent, intl)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
