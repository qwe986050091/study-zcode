// 【模块】模型供应商家族头部与连接模式切换控件：把当前导航条目投影成标题、副标题与套餐下拉。
// 【边界】全部输入来自设置页容器的受控 props，本文件不发请求、不读 store、不持久化任何选择。
// 【契约】选择结果以上抛回调交回父级，组件自身只做派发与展示，保证单一写入路径。
// 【权衡】任何必需输入缺失时整块不渲染，宁可留空也不给用户可点却无落点的控件。
// INV-01 【不变量】缺失当前导航条目时头部整块渲染为空，不留占位骨架；守住位置：ProviderFamilyHeader 的空条目分支；改错故障：设置页出现空标题栏并挤压下方表单。
// INV-02 【不变量】连接模式切换仅在既有选中条目又有上抛回调时出现；守住位置：ProviderFamilyPlanModeSwitch 首道守卫；改错故障：下拉可点但选择无处落地，交互看似响应实则丢弃。
// INV-03 【不变量】家族标识只从 preset、codingPlan、teamPlan 三类条目取 presetId；守住位置：两处 providerId 派生三元；改错故障：自定义条目误命中他人家族，展示错误套餐选项。
// INV-04 【失败路径】家族规格查询失败即中止渲染，不回退到原始 id；守住位置：familySpec 缺失分支；改错故障：标题露出内部标识而非产品名，用户无法确认当前供应商。
// INV-05 【不变量】Start Plan 条目不展示连接模式下拉；守住位置：codingPlan 与 Start Plan 的组合守卫；改错故障：Start Plan 页冒出可切换下拉，把用户导向错误的购买路径。
// INV-06 【失败路径】可选套餐集合为空时整块控件不渲染；守住位置：options 长度判定；改错故障：出现空下拉，展开后一片空白，用户以为功能损坏。
// INV-07 【设计权衡】仅剩唯一可选项且已命中时收起控件；守住位置：单选项短路返回；改错故障：用户被迫在等价选项间做无意义二选一，还多一次误操作风险。
// INV-08 【并发】选中身份只取已保存或提交中的付费选择快照；守住位置：connectionSelections 取值处；改错故障：团队导航复用个人 provider 时串台，下拉显示他人套餐。
// INV-09 【失败路径】未命中任何选项时下拉值取空串而非首项；守住位置：Select 的 value 派生；改错故障：未购买却显示首项标签，掩盖真实未选择状态。
// INV-10 【失败路径】选中值到导航条目的解析失败必须静默丢弃；守住位置：onValueChange 内的 option 查找；改错故障：过期 key 触发上抛，父级收到已不存在的条目。
// INV-11 【不变量】标题对 Start Plan 使用固定展示名，其余走家族规格标签；守住位置：标题三元表达式；改错故障：Start Plan 显示内部家族名，与入口文案不一致。
// INV-12 【失败路径】加载失败时文案切为失败提示并附警示图标；守住位置：connectionSettingsFailed 分支；改错故障：接口已失败仍显示正常标签，用户误以为可正常切换。
// INV-13 【设计权衡】失败态只改颜色与图标，不禁用交互；守住位置：警示样式与 Select 渲染；改错故障：用户被锁死在错误态，既不能重试也无法改选。
// INV-14 【设计权衡】操作区以基础宽度参与换行分配，名称在剩余空间收缩；守住位置：trailingAction 容器与标题截断；改错故障：按全称固有宽度分配会让标题右侧空着却整组掉行。
// INV-15 【不变量】触发按钮始终带 aria-label 且随失败态切换文案；守住位置：SelectTrigger 的无障碍属性；改错故障：读屏用户听不到控件用途，也感知不到失败。
// INV-16 【不变量】选项顺序先 codingPlan 后 teamPlan，团队项按出现次序递增；守住位置：order 字段与末尾排序；改错故障：套餐顺序随导航数组抖动，用户难以稳定复选。
// INV-17 【不变量】preset 与 Start Plan 条目在构建选项前被剔除；守住位置：buildProviderFamilyConnectionOptions 的类型过滤；改错故障：个人订阅以套餐名义混入团队下拉，误导付费。
// INV-18 【失败路径】团队名称为空、全空白或缺失时回退到本地化兜底标签；守住位置：formatTeamPlanConnectionLabel 的归一化；改错故障：下拉出现空白项，用户分不清是哪个团队。
// INV-19 【不变量】标题与选项标签均由国际化消息派生，不拼接英文后缀；守住位置：formatMessage 调用与团队名处理；改错故障：中文界面出现中英混排的产品名。
import {
  resolveModelProviderFamilySpecByProviderId,
  isStartPlanModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { connectionSelectionMatchesNavigationItem } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import { resolveModelProviderNavLogo } from "@/settings/model-provider-section/utils.js";
import { ProviderLogo } from "./ProviderLogo.js";
import type { ModelProviderNavItem } from "./constants.js";

type ProviderFamilyConnectionOption = {
  key: string;
  label: string;
  item: Extract<ModelProviderNavItem, { type: "preset" | "codingPlan" | "teamPlan" }>;
  order: number;
};

export function ProviderFamilyDetailShell({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  // 【不变量】header 为空时外壳直接透传 children，不额外包裹布局容器；改错故障：无头部页面多套一层 flex，垂直间距翻倍。
  // 【设计权衡】只有存在头部时才建立 gap-4 纵向节奏，避免空节点仍参与间隔计算而在底部留下空白。
  // 【生命周期】外壳不创建订阅也不缓存节点，children 的挂载与卸载完全由父级条件渲染决定。
  if (!header) {
    return children;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {children}
    </div>
  );
}

// 【不变量】标题只依赖 selectedNavItem 与家族规格，不读取 store 或远端数据；改错故障：切换条目时标题滞后一帧，与左侧导航错位。
// 【失败路径】条目或家族规格任一缺失即返回 null，宁可整块消失也不渲染半成品标题。
// 【受控 props】trailingAction 由父级注入，本组件不复制其状态、不拦截其事件、不做二次包裹决策。
// 【设计权衡】标题用 h3 承接视觉层级，导航面板已提供 h2 语义，避免标题级别跳跃破坏读屏顺序。
// 【不变量】名称列与操作区各自允许收缩，flex 收缩优先于溢出，超长名称走截断而非撑破容器。
// 【失败路径】超长家族名触发 truncate，不会换行撑高固定的 32px 标题条。
export function ProviderFamilyHeader({
  selectedNavItem,
  trailingAction,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  trailingAction?: ReactNode;
}) {
  if (!selectedNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (!providerId) {
    return null;
  }

  // 【不变量】家族规格查询是纯映射，同一 providerId 必得同一结果；改错故障：重复查询给出不同家族，标题与下拉分属两家。
  // 【失败路径】未知 providerId 返回空，调用方必须就地中止，不得兜底猜测前缀或默认家族。
  // 【设计权衡】规格集中在 shared 包维护，UI 不做前缀字符串匹配，避免各处手写判断漂移。
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  return (
    <div className="flex h-8 min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderLogo logo={resolveModelProviderNavLogo(selectedNavItem)} className="size-5" />
        <h3 className="truncate text-ui-lg font-medium text-foreground">
          {selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId)
            ? "Start Plan"
            : familySpec.label}
        </h3>
      </div>
      {/* 修复原因：按团队全称的固有宽度参与外层换行，会让标题右侧空着却整组掉行；以操作区基础宽度参与分配，再让名称在剩余空间内收缩。 */}
      {trailingAction ? (
        <div className="min-w-0 max-w-full flex-1 basis-64">{trailingAction}</div>
      ) : null}
    </div>
  );
}

// 【受控 props】选中值、导航条目与回调全部由父级提供，本组件不保存选择结果，也不做乐观镜像。
// 【失败路径】缺少选中条目或回调时整块不渲染，而不是渲染禁用态；改错故障：出现永远无法选择的死控件。
// 【不变量】回调只上抛导航条目本身，路由与提交由父级决定，避免在此出现第二条写入路径。
// 【设计权衡】startPlanSubscriptionCount 保留在类型中但不参与展示，调用方无需为计数调整而改签名。
// 【并发】connectionSelections 视为父级快照，渲染期间不订阅变更，同帧内多次取值结果一致。
// 【不变量】标签与下拉用 flex-wrap 承载，窄屏时分行而非压缩到不可读。
// 【失败路径】缺少对应文案时回退到 message id 原文，至少保留可诊断文本而非空白。
// 【生命周期】国际化上下文只读取当前语言，不在组件内创建 Provider 或跨渲染缓存消息。
export function ProviderFamilyPlanModeSwitch({
  selectedNavItem,
  navigationItems,
  connectionSettingsFailed = false,
  connectionSelections,
  onSelectNavItem,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems: ModelProviderNavItem[];
  startPlanSubscriptionCount?: number;
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
}) {
  const { intl } = useZCodeIntl();
  // 【失败路径】两个受控入口任一缺失都直接短路，避免出现可点击却无接收方的下拉。
  // 【不变量】守卫在派生任何 id 之前执行，未选中时不做无谓的家族查询。
  // 【设计权衡】此处不渲染禁用态控件，只读场景由父级决定不挂载本组件。
  if (!selectedNavItem || !onSelectNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (
    !providerId ||
    (selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId))
  ) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  // 【不变量】三个本地化标签在构建前一次性解析，保证同一次渲染内文案语言一致。
  // 【失败路径】文案缺失时以 message id 作为可见文本，便于定位缺失 key 而非显示空白项。
  // 【设计权衡】构建函数保持纯函数形态，标签作入参传入，便于单测脱离国际化上下文。
  const options = buildProviderFamilyConnectionOptions({
    familyId: familySpec.id,
    navigationItems,
    startPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.startPlan",
    }),
    codingPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.codingPlan",
    }),
    teamPlanFallbackLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.teamPlan",
    }),
  });
  if (options.length === 0) {
    return null;
  }

  // 团队导航条目可能复用个人 provider；选中身份只来自已保存／提交中的付费选择。
  // 【不变量】选中身份只来自已保存或提交中的付费选择，不从导航条目当前高亮推断。
  // 【失败路径】团队导航复用个人 provider 时，按高亮推断会把个人套餐当成团队已选。
  // 【并发】提交中的临时选择与已保存值同源，渲染只读一次快照，避免两次读取之间被改写。
  // 【生命周期】快照随 props 整体替换，本组件不持有跨渲染引用，不会读到已失效对象。
  const selection = connectionSelections?.[familySpec.id];
  const selectedOption = selection
    ? options.find((option) =>
        connectionSelectionMatchesNavigationItem(familySpec.id, selection, option.item),
      )
    : undefined;
  // 【不变量】唯一可选项且已命中时收起控件，避免零信息量的二选一。
  // 【失败路径】唯一项尚未命中时必须继续展示，用于提示用户完成选择。
  if (options.length === 1 && selectedOption) return null;
  const connectionModeLabel = intl.formatMessage({
    id: connectionSettingsFailed
      ? "settings.modelProvider.connectionMode.loadFailed"
      : "settings.modelProvider.connectionMode",
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span
        className={[
          "inline-flex min-w-0 shrink-0 items-center gap-1 text-ui-base",
          connectionSettingsFailed ? "text-warning" : "text-foreground-subtle",
        ].join(" ")}
      >
        {connectionSettingsFailed ? <InfoIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{connectionModeLabel}</span>
      </span>
      <Select
        // 【受控语义】空串表示尚未命中任何选项，下拉展示占位文案而非默认首项。
        // 【失败路径】过期 key 不在选项中时展示为空，等父级快照刷新后自动纠正。
        // 【不变量】值与选项列表同源，禁止在此维护本地 state 镜像。
        // 【并发】回调同步触发父级重渲染，控件不做乐观切换，避免与真实快照分叉。
        value={selectedOption?.key ?? ""}
        onValueChange={(optionKey) => {
          const option = options.find((item) => item.key === optionKey);
          if (!option) {
            return;
          }
          onSelectNavItem(option.item);
        }}
      >
        <SelectTrigger
          size="lg"
          // 固定最大宽度会在宽屏仍截断全称；先占用剩余空间，只有不足控件基本宽度时才换行。
          className="min-w-0 max-w-fit flex-1 basis-12 justify-between"
          aria-label={connectionModeLabel}
          data-testid={TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER}
        >
          <SelectValue
            className="min-w-0 flex-1"
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchase.selectPlan",
            })}
          >
            {selectedOption ? (
              <span className="min-w-0 truncate text-left">{selectedOption.label}</span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="min-w-40 max-w-[calc(100vw-2rem)]">
          {options.map((option) => (
            <SelectItem
              key={option.key}
              value={option.key}
              className="min-w-0 whitespace-normal pr-8 [overflow-wrap:anywhere]"
              data-testid={testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, option.key)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// 【不变量】只收集同一家族且类型为 codingPlan 或 teamPlan 的条目。
// 【失败路径】家族规格缺失或家族 id 不匹配时跳过，严禁跨家族混入选项。
// 【不变量】preset 与 Start Plan 条目在进入选项前被剔除，个人订阅不冒充套餐。
// 【设计权衡】codingPlan 固定 order 10，团队项从 100 起递增，排序稳定且新增团队不影响首项。
// 【并发】导航数组按引用读取一次，循环内不修改，返回全新数组不污染父级快照。
// 【生命周期】每次渲染重建选项，不做跨调用缓存，语言与导航变化可即时生效。
export function buildProviderFamilyConnectionOptions({
  familyId,
  navigationItems,
  codingPlanLabel,
  teamPlanFallbackLabel,
}: {
  familyId: string;
  navigationItems: ModelProviderNavItem[];
  startPlanLabel: string;
  codingPlanLabel: string;
  teamPlanFallbackLabel: string;
}): ProviderFamilyConnectionOption[] {
  const options: ProviderFamilyConnectionOption[] = [];
  for (const item of navigationItems) {
    if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
      continue;
    }
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec || familySpec.id !== familyId) {
      continue;
    }
    if (item.type === "preset" || isStartPlanModelProviderId(item.presetId)) continue;
    if (item.type === "teamPlan") {
      options.push({
        key: item.key,
        item,
        label: formatTeamPlanConnectionLabel(item.teamPlanName, teamPlanFallbackLabel),
        order: 100 + options.length,
      });
      continue;
    }
    options.push({
      key: item.key,
      item,
      label: codingPlanLabel,
      order: 10,
    });
  }

  return options.sort((left, right) => left.order - right.order);
}

// 【失败路径】名称为空、全空白或未提供时回退到本地化兜底标签。
// 【不变量】非空名称原样返回，不追加英文 Plan 后缀，以免破坏中文与自定义命名。
// 【设计权衡】`normalizeLabel` 只做首尾去空白，内部空白原样保留以尊重团队命名。
// 【生命周期】纯字符串函数，无缓存无副作用，可在排序前逐项安全调用。
function formatTeamPlanConnectionLabel(
  teamPlanName: string | null | undefined,
  fallbackLabel: string,
): string {
  const normalized = teamPlanName?.trim();
  if (!normalized) {
    return fallbackLabel;
  }
  // 团队项目名已由权益接口提供，额外拼接英文 Plan 会破坏中文和自定义名称。
  return normalized;
}
