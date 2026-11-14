// 职责边界：本文件只实现模型选择器——触发器展示、模型项、provider 连接方式子菜单、
// 菜单开关与关闭后的焦点恢复；不加载模型列表、不解析 provider 配置、不提交会话事实。
// 模型数据与选中值全部由上层通过 props 传入，本组件不持有第二份业务真相。
//
// 不变量（INV）表：
// | 编号 | 断言 | 守住它的位置 | 改错后的故障 |
// | INV-01 | 受控与非受控只由 controlledOpen 决定 | open 常量与 handlePopoverOpenChange | 两套状态互相覆盖，菜单抖动 |
// | INV-02 | pending 期间冻结展示快照 | presentation.current 的重写分支 | 菜单收缩并显示占位横线 |
// | INV-03 | 冻结只限展示，提交回调仍取当前 owner | 合并时保留 onValueChange | 提交事实被旧快照覆盖 |
// | INV-04 | 打开前按真实按钮宽度测量 | getBoundingClientRect 调用点 | 打开态宽度按占位文案计算并跳变 |
// | INV-05 | openRequestKey 只在递增且非零时触发 | useEffect 的首个守卫 | 每次渲染都重新打开菜单 |
// | INV-06 | disabled 时快捷键不得打开 | useEffect 内的 disabled 分支 | 只读状态仍弹出菜单 |
// | INV-07 | 快捷键直接改状态而非模拟 click | handlePopoverOpenChange(true) | asChild 合并 ref 后 click 丢失 |
// | INV-08 | 选中态唯一由 normalizedValue 推导 | itemSelected 与 RadioGroup value | 多项同时显示选中 |
// | INV-09 | 锁定项不可被选中 | itemLocked 分支的 onSelect | 受限模型被切换并提交 |
// | INV-10 | 锁定提示图标要吞掉指针事件 | TooltipTrigger 内的 preventDefault | 点提示就关闭整个菜单 |
// | INV-11 | 合并模式下选模型不关菜单 | onSelect 中的 composerOptions 判断 | 无法连续调整模型与档位 |
// | INV-12 | 非合并模式选中即关闭 | else 分支的 handlePopoverOpenChange | 菜单滞留遮挡输入区 |
// | INV-13 | 焦点恢复受触屏能力约束 | shouldRestoreChatInputFocusAfterPickerClose | 触屏上弹出软键盘或焦点丢失 |
// | INV-14 | 焦点选择器缺失时保留 Radix 默认 | onCloseAutoFocus 的早退 | 焦点掉到 body |
// | INV-15 | 菜单打开时 Tooltip 必须关闭 | open 为真时的 open={false} | Escape 只关提示，菜单仍锁指针 |
// | INV-16 | provider 分隔线只由 family 分组决定 | shouldRenderModelGroupSeparator | 出现重复分隔线 |
// | INV-17 | 无 group 时强制扁平展示 | shouldShowProviderLevel 的 ?? 兜底 | 扁平模型分支永不可达 |
// | INV-18 | 触发器文案不做大小写变换 | triggerDisplayLabel 直接取原值 | synthetic 占位被显示成大写 |
// | INV-19 | 管理入口不重复注入 | renderedFooterActions 的 composerOptions 判断 | 合并菜单出现两个管理模型入口
/* eslint-disable max-lines -- 模型菜单同时维护触发器、模型项、provider family 连接方式子菜单和焦点恢复，拆开会增加受控 Dropdown 状态同步成本。 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ProviderConfigObject } from "@zcode/provider";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { AlertCircle, CheckIcon, ChevronDownIcon, LoaderIcon, PackageIcon } from "lucide-react";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { ComposerTriggerTransition } from "@/chat-input-toolbar/ComposerTriggerTransition.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import {
  ComposerModelMenu,
  ComposerThoughtIndicator,
  isGlmHighspeedModel,
  type ComposerModelOptions,
} from "@/chat-input-toolbar/ComposerModelMenu.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";

// [契约] 单个模型项的展示形态，key 与 value 分离：key 供 React，value 供提交。
// badgeLabel 与 supportsVisionInput 只影响展示，不参与锁定与选中判定。
// 改错故障：用 name 当 value 会让同名模型互相覆盖选中态。
export interface ModelSelectGroupItem {
  key: string;
  value: string;
  name: string;
  badgeLabel?: string;
  supportsVisionInput?: boolean;
}

// [契约] 连接方式选项携带 familyId 与 mode，回调据此重建 provider 配置。
// disabled 只用于展示禁用，真正的可用性仍由上层在回调里复核。
// 改错故障：省略 mode 会让 oauth 与 apiKey 两种凭据被当成同一项。
export interface ModelSelectConnectionOption {
  key: string;
  label: string;
  badgeLabel?: string;
  value: string;
  providerId: string;
  familyId: string;
  mode: "oauth" | "apiKey";
  disabled?: boolean;
}

// [契约] 一个 group 对应一个 provider 或一个扁平分区的完整模型集合。
// directItems 表示模型直接平铺，不进入子菜单；与 connectionOptions 互斥使用。
// 改错故障：同时设置两者会让分隔线与子菜单渲染路径冲突，出现双层分组。
export interface ModelSelectGroup {
  key: string;
  label: string;
  labelBadge?: string;
  logo?: ProviderConfigObject["logo"];
  directItems?: boolean;
  selectedOptionKey?: string;
  connectionOptions?: ModelSelectConnectionOption[];
  items: ModelSelectGroupItem[];
}

// [契约] footer 是菜单底部的固定动作区，selected 只用于展示勾选标记。
// onSelect 在关闭菜单之后调用，不允许依赖菜单内部状态。
// 改错故障：在 onSelect 里读 open 会读到已关闭的值。
export interface ModelSelectFooterAction {
  key: string;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}

// [契约] 空数组常量用于默认参数，避免每次渲染新建引用触发 memo 失效。
// 该数组被冻结为只读类型，任何原地 push 都会在类型层被拒。
// 改错故障：默认值写 [] 会让 footerActions 每次都是新引用，useMemo 全部重算。
const EMPTY_MODEL_SELECT_FOOTER_ACTIONS: readonly ModelSelectFooterAction[] = [];
// [契约] 徽标样式集中一份，模型项与分组标签共用，保证尺寸一致。
// 该常量被外部引用，改动会同时影响其他菜单的徽标外观。
// 改错故障：就地复制类名会在两个菜单位置出现不同字号。
export const MODEL_CONFIG_SELECT_BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

// [契约] 只有存在 group 时才展示 provider 层，这是默认值的来源。
// 判断只看长度，不看 items 是否有内容，空组也算有 provider 层。
// 改错故障：改成按 item 数量判断会让空 provider 分组的标题消失。
export function shouldShowModelProviderLevel(modelGroups: readonly ModelSelectGroup[]): boolean {
  return modelGroups.length > 0;
}

// [契约] 三类特征任一命中即视为 family 连接组：前缀、徽标、连接选项。
// 判定刻意宽松，兼容旧数据里没有 connectionOptions 但带 badge 的分组。
// 改错故障：只认 connectionOptions 会让旧 family 分组丢掉分隔线。
function isFamilyConnectionGroup(
  group: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  return (
    // [契约] family: 前缀是历史约定，改前缀等于让所有旧分组失去分隔。
    // labelBadge 的 trim 判定保证空白徽标不被误认为 family 组。
    // 改错故障：改成 includes 会误伤 key 中偶然包含 family 的普通分组。
    group.key.startsWith("family:") ||
    Boolean(group.labelBadge?.trim()) ||
    (group.connectionOptions?.length ?? 0) > 0
  );
}

// [契约] 首组不画分隔线，之后只要相邻任一组是 family 组就画一条。
// 该函数是纯函数，供外部复用；不要在组件内另写一套条件。
// 改错故障：改成每组都画会让菜单出现连续空白与视觉断裂。
export function shouldRenderModelGroupSeparator(
  previousGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge"> | undefined,
  currentGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  if (!previousGroup) {
    return false;
  }
  return isFamilyConnectionGroup(previousGroup) || isFamilyConnectionGroup(currentGroup);
}

// [契约] 分组选中 = 组内任一 item 的 value 等于当前值，仅用于展示勾选。
// 不校验锁定状态，锁定项仍可能被标记为选中，这是刻意的展示语义。
// 改错故障：加上锁定过滤会让当前选中的受限模型失去勾选标记。
export function isModelSelectGroupSelected(
  group: Pick<ModelSelectGroup, "items">,
  normalizedValue: string,
): boolean {
  return group.items.some((item) => item.value === normalizedValue);
}

// [契约] 调用方传入的触发器标签类名优先，缺省才拼基础类与可见性类。
// trim 判定是为了让空字符串也能走默认分支。
// 改错故障：无条件覆盖会让自定义样式在各入口失效。
export function getModelTriggerLabelClassName({
  labelVisibilityClassName,
  triggerLabelClassName,
}: {
  labelVisibilityClassName: string | undefined;
  triggerLabelClassName?: string;
}): string {
  if (triggerLabelClassName?.trim()) {
    return triggerLabelClassName;
  }

  return cn("min-w-0 text-left", labelVisibilityClassName);
}

// [契约] 组件同时服务 Composer 合并入口与普通模型选择入口，由 composerOptions 区分。
// open/onOpenChange/openRequestKey 是可选的受控协议，缺省即内部自管。
// 改错故障：把 composerOptions 当必填会让所有旧调用点无法编译。
interface ModelConfigSelectProps {
  /** Composer 合并入口；其他使用点保持原有模型选择交互。 */
  composerOptions?: ComposerModelOptions;
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  triggerLabel: string;
  triggerLabelPrefix?: string;
  triggerLabelValue?: string;
  triggerLabelPrefixClassName?: string;
  showManageModelsAction: boolean;
  lockReasonMessage: string;
  isItemLocked: (candidateValue: string) => boolean;
  onValueChange: (value: string) => void;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
  disabled?: boolean;
  tooltipTitle?: string;
  guideTooltipTitle?: ReactNode;
  guideTooltipOpen?: boolean;
  onGuideTooltipDismiss?: () => void;
  shortcutLabel?: string;
  triggerRef?: RefObject<HTMLSpanElement | null>;
  /** 传入时由调用方统一协调菜单；省略则保持组件原有的内部开关状态。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  openRequestKey?: number;
  pendingLabel?: string | null;
  pending?: boolean;
  labelVisibilityClassName?: string;
  indicatorClassName?: string;
  triggerClassName?: string;
  triggerIconClassName?: string;
  triggerIcon?: ReactNode;
  triggerLabelClassName?: string;
  triggerTestId?: string;
  formatTriggerLabel?: (label: string) => string;
  /** false 时把第一个 group 作为无 provider 层的扁平模型列表展示。 */
  showProviderLevel?: boolean;
  /** 覆盖 provider 二级模型菜单样式；缺省按内容扩展并保留最小宽度。 */
  providerSubmenuClassName?: string;
  footerActions?: readonly ModelSelectFooterAction[];
  manageModelsLabel?: string;
  onManageModels?: () => void;
  focusSelectorOnClose?: string | null;
  contentSide?: "top" | "bottom" | "left" | "right";
  contentAlign?: "start" | "center" | "end";
  /**
   * 排在所有分组之上的单选项（与分组之间隔一条线）。工作流「配置」弹层用它把「会话模型」放在第一位；
   * 缺省即无。
   */
  leadingItems?: readonly ModelSelectGroupItem[];
  /** 触发器里标签之后的小徽标（如「会话模型」「不可用」）；缺省即无。 */
  triggerBadge?: ReactNode;
}

// [契约] memo 生效的前提是 props 引用稳定，上游传内联对象会使其失效。
// 组件内部不读全局 store，所有事实都由 props 注入，便于在多种入口复用。
// 改错故障：内部自取模型列表会让 memo 与数据刷新产生竞态。
export const ModelConfigSelect = memo(function ModelConfigSelectComponent({
  composerOptions,
  modelGroups,
  normalizedValue,
  triggerLabel,
  triggerLabelPrefix,
  triggerLabelValue,
  triggerLabelPrefixClassName,
  showManageModelsAction,
  lockReasonMessage,
  isItemLocked,
  onValueChange,
  onConnectionValueChange,
  disabled,
  tooltipTitle,
  guideTooltipTitle,
  guideTooltipOpen = false,
  onGuideTooltipDismiss,
  shortcutLabel,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  openRequestKey = 0,
  pendingLabel,
  pending,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  indicatorClassName,
  triggerClassName,
  triggerIconClassName = "hidden",
  triggerIcon,
  triggerLabelClassName: customTriggerLabelClassName,
  triggerTestId = TID_CHAT_MODEL_SELECT_TRIGGER,
  formatTriggerLabel,
  showProviderLevel,
  providerSubmenuClassName,
  footerActions = EMPTY_MODEL_SELECT_FOOTER_ACTIONS,
  manageModelsLabel,
  onManageModels,
  focusSelectorOnClose = '[data-testid="chat-input"]',
  contentSide = "top",
  contentAlign = "start",
  leadingItems,
  triggerBadge,
}: ModelConfigSelectProps) {
  // [并发] 这里保存的是「上一次非 pending 的展示快照」，不是业务状态副本。
  // 快照只在渲染期读写，不进入 effect，因此不会多渲染一轮。
  // 改错故障：改用 state 保存会让冻结逻辑触发额外渲染与闪烁。
  const presentation = useRef({ composerOptions, modelGroups, normalizedValue, triggerLabel });
  if (
    composerOptions?.providerMenu?.pending &&
    presentation.current.composerOptions?.providerMenu
  ) {
    // 原因：账号刷新和草稿解析分别到达，混用新选项与旧选中值会让菜单收缩并显示“—”。
    // loading 期间只冻结展示；回调和 pending/error 仍来自当前 owner，不影响提交事实。
    // [契约] 取快照要在重写之前完成，否则 previous 会指向刚合并的新值。
    // 后续所有冻结字段都来自这一个 previous，保证同一帧内展示自洽。
    // 改错故障：在赋值之后再读 current 会让冻结完全失效。
    const previous = presentation.current;
    composerOptions = {
      ...previous.composerOptions!,
      onValueChange: composerOptions.onValueChange,
      providerMenu: {
        ...composerOptions.providerMenu,
        groups: previous.composerOptions!.providerMenu!.groups,
        selectedKey: previous.composerOptions!.providerMenu!.selectedKey,
      },
    };
    modelGroups = previous.modelGroups;
    normalizedValue = previous.normalizedValue;
    triggerLabel = previous.triggerLabel;
  } else presentation.current = { composerOptions, modelGroups, normalizedValue, triggerLabel };
  // [契约] 非受控开关仅在没有 controlledOpen 时生效，初始为关闭。
  // 受控方一旦接管，这个 state 会被保留但不再驱动渲染。
  // 改错故障：受控模式下仍写该 state 会产生不会渲染的无效状态。
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // [契约] 用 ?? 而不是 ||，确保受控方显式传 false 时能覆盖内部状态。
  // 这是受控/非受控的唯一合并点，其他地方不得再读 uncontrolledOpen。
  // 改错故障：改成 || 会让受控方无法强制关闭菜单。
  const open = controlledOpen ?? uncontrolledOpen;
  // [资源] buttonRef 同时用于打开前测宽与 DropdownTrigger 的真实节点绑定。
  // 触发器被 Tooltip 的 asChild 包裹，ref 必须在 Button 上而不是外层 span。
  // 改错故障：挂到外层 span 会测到含 padding 的宽度，打开态文案偏移。
  const buttonRef = useRef<HTMLButtonElement>(null);
  // [契约] expandedWidth 取自打开瞬间按钮的 getBoundingClientRect 宽度，关闭即清空。
  // null 表示未测量，此时 CSS 变量按 8rem 兜底而不是 0。
  // 改错故障：保留上次宽度会让侧栏收缩后菜单仍按旧宽度展开。
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);
  // [契约] 空白值视为「未选中」，用于决定是否展示选中文案与思考档位。
  // 该判定只看值本身，不关心它是否存在于当前 modelGroups 中。
  // 改错故障：改用 find 判定会让列表尚未加载时的合法选中值被当成空态。
  const hasSelectedModel = Boolean(normalizedValue.trim());
  // [契约] 只有合并入口、菜单打开且已有选中模型时才切换为选中态文案。
  // 该布尔同时驱动宽度锁定与 ComposerTriggerTransition 动画。
  // 改错故障：去掉 open 条件会让关闭状态下也套用固定宽度。
  const showSelectionLabel = Boolean(composerOptions && open && hasSelectedModel);
  // 未选模型不代表缺失思考档位；空态不应显示横线、绿条或 Tooltip 的伪档位。
  // [契约] 未选模型时不推导档位，避免空态显示伪档位（横线或绿条）。
  // 档位标签按 composerOptions.value 匹配 levels，而不是按 normalizedValue。
  // 改错故障：无选中值也 find 会命中第一个档位，显示错误档位。
  const selectedThoughtLabel = hasSelectedModel
    ? composerOptions?.levels.find((level) => level.value === composerOptions.value)?.label
    : undefined;
  // [并发] 记录已消费的打开请求号，防止同一 key 在重渲染时重复打开。
  // 初值取当前 key，确保挂载时不因历史值触发一次意外打开。
  // 改错故障：初值取 0 会让首次渲染就把非零 key 当成新请求。
  const lastOpenRequestKeyRef = useRef(openRequestKey);
  // [契约] 只看 composerOptions 是否有分组，不检查分组内是否真的存在可选模型。
  // 它决定是否渲染列表区与分隔线，因此空组仍会显示标题。
  // 改错故障：改成检查 items 会让空分组菜单变成完全空白。
  const hasSelectableModel = modelGroups.length > 0;
  // 闲时任务白名单只有一层模型值；只要存在 group 就强制展示 provider 层的话，
  // 下方已有的扁平模型分支永远不可达，也无法复用 New Task 模型选择器。
  // [权衡] 显式的 showProviderLevel 优先，用于闲时任务等只有一层模型的场景。
  // 默认按是否有 group 推导，避免强制 provider 层导致扁平分支不可达。
  // 改错故障：改成 || 会让显式 false 被默认值覆盖。
  const shouldShowProviderLevel = showProviderLevel ?? shouldShowModelProviderLevel(modelGroups);
  // 模型名和上游占位值可能大小写敏感，强制大写会把 `<synthetic>` 改成 `<SYNTHETIC>` 这类非原始值。
  // [契约] 原样保留上游文案，不做大小写或空白规范化。
  // 模型名与占位值可能大小写敏感，例如 synthetic 这类尖括号占位。
  // 改错故障：转大写会把占位值改成非原始值，比较与展示都对不上。
  const triggerDisplayLabel = triggerLabel;
  // [契约] formatTriggerLabel 只影响展示，不改变提交用的 normalizedValue。
  // 未提供格式化函数时直接透传原值，保持零开销。
  // 改错故障：把格式化结果回写选中值会让提交的模型 id 变形。
  const renderedTriggerDisplayLabel =
    formatTriggerLabel?.(triggerDisplayLabel) ?? triggerDisplayLabel;
  // [契约] 占位文案也走同一格式化函数，保证 pending 与正常态风格一致。
  // 仅在同时存在 pendingLabel 与格式化函数时才处理，避免多余调用。
  // 改错故障：占位不格式化会让切换瞬间文案风格突变。
  const renderedPendingLabel =
    pendingLabel && formatTriggerLabel ? formatTriggerLabel(pendingLabel) : pendingLabel;
  // [契约] pending 且存在占位文案时才替换，否则展示真实模型名。
  // 替换只发生在触发器，aria-label 与 title 走各自的分支。
  // 改错故障：pending 时把真实名也清空会让读屏丢失上下文。
  const currentTriggerLabel =
    pending && renderedPendingLabel ? renderedPendingLabel : renderedTriggerDisplayLabel;
  // [契约] title 用未格式化的原始文案，便于用户看到真实 id。
  // 与 currentTriggerLabel 的取值不同是有意的：展示格式化、提示保原文。
  // 改错故障：两者合并会让长模型名在 title 中被截断样式影响。
  const currentTriggerTitle = pending && pendingLabel ? pendingLabel : triggerDisplayLabel;
  // [契约] 标签类名必须在渲染前算好，保证 memo 依赖稳定。
  // labelVisibilityClassName 默认值来自 props 解构，不是模块常量。
  // 改错故障：在 JSX 内联 cn 会让每次渲染产生新字符串，破坏子组件 memo。
  const triggerLabelClassName = getModelTriggerLabelClassName({
    labelVisibilityClassName,
    triggerLabelClassName: customTriggerLabelClassName,
  });

  // [并发] 所有开关变更都收敛到这一个回调，受控与非受控共用同一路径。
  // 依赖里必须包含 composerOptions，因为它决定是否测量宽度。
  // 改错故障：漏依赖会闭包到旧的 composerOptions，打开时不测宽。
  const handlePopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      // 打开前测量真实按钮，不能在替换文案后反过来测量占位内容。
      // [资源] 只在打开瞬间测量，关闭时清空，避免 DOM 变化后宽度失真。
      // 非合并入口 composerOptions 为空，不锁宽也不测量，省一次布局读取。
      // 改错故障：关闭时也测量会读到动画中的中间宽度。
      if (nextOpen && composerOptions && buttonRef.current)
        setExpandedWidth(buttonRef.current.getBoundingClientRect().width);
      else if (!nextOpen) setExpandedWidth(null);
      // [契约] 只有非受控模式才写内部 state，受控模式一律交给 onOpenChange。
      // 即使受控，也仍然回调 onOpenChange，保证上层能感知所有开关意图。
      // 改错故障：受控模式下也写内部 state 会让两种真相分叉。
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange, composerOptions],
  );

  // [契约] 该 effect 只处理外部打开请求，不做数据加载。
  // 依赖含 handlePopoverOpenChange，回调身份变化会重新注册，属预期行为。
  // 改错故障：把打开逻辑放进渲染期会与受控状态互相打架。
  useEffect(() => {
    // [并发] 0 与负值表示「无请求」，重复 key 表示「已消费」，两者都直接返回。
    // 消费前不写 ref，确保后续 disabled 早退不会把请求标记为已处理。
    // 改错故障：先写 ref 再判 disabled 会让禁用期间的请求被永久丢弃。
    if (openRequestKey <= 0 || openRequestKey === lastOpenRequestKeyRef.current) {
      return;
    }
    lastOpenRequestKeyRef.current = openRequestKey;

    // [契约] 禁用时忽略快捷键打开请求，但仍已消费该 key，防止解除禁用后突然弹出。
    // 这里不调用 handlePopoverOpenChange，避免产生受控方的状态变更。
    // 改错故障：禁用期间也打开会让只读视图出现可操作的菜单。
    if (disabled) {
      return;
    }

    // 模型菜单是受控 DropdownMenu，快捷键不能依赖模拟 click 触发。
    // Tooltip/Dropdown 多层 asChild 合并 ref 时，click 可能找不到真实 trigger；这里直接打开菜单状态。
    // [契约] 快捷键打开直接改状态，不模拟 click，因为 asChild 合并 ref 后 click 不可靠。
    // 打开后把焦点移到触发器，保证后续键盘操作落在菜单同源节点上。
    // 改错故障：改成 dispatchEvent click 会在 Tooltip 包裹层丢失目标。
    handlePopoverOpenChange(true);
    triggerRef?.current?.focus();
  }, [disabled, handlePopoverOpenChange, openRequestKey, triggerRef]);

  // [契约] 这是「选中模型」的唯一出口，锁定判断已在渲染层完成。
  // 此处不再校验锁定，避免同一规则在两层实现后出现不一致。
  // 改错故障：在此重复判锁定会让上层主动传入的值被静默丢弃。
  const handleModelValueChange = useCallback(
    (nextValue: string) => {
      onValueChange(nextValue);
    },
    [onValueChange],
  );

  // [契约] aria-label 优先取 pending 占位，其次 tooltipTitle，最后展示文案。
  // 优先级保证繁忙时可感知状态，且自定义提示能覆盖默认文案。
  // 改错故障：只用展示文案会让 pending 状态对读屏不可见。
  const triggerAriaLabel = useMemo(() => {
    return pending && pendingLabel ? pendingLabel : (tooltipTitle ?? currentTriggerTitle);
  }, [currentTriggerTitle, pending, pendingLabel, tooltipTitle]);

  // [契约] 单个模型项渲染收敛在此，锁定与选中两种状态叠加在同一结构里。
  // 依赖含 normalizedValue，选中态变化时必须重建回调。
  // 改错故障：漏依赖会让选中勾选停留在旧模型上。
  const renderModelItem = useCallback(
    (item: ModelSelectGroupItem) => {
      // [契约] 锁定判定是外部函数，组件不缓存结果，保证权限变化立即可见。
      // itemLocked 同时决定渲染组件类型（普通项或单选组项）。
      // 改错故障：缓存锁定结果会让解锁后仍无法选择。
      const itemLocked = isItemLocked(item.value);
      // [契约] 选中判定用严格相等，不做 trim 或大小写归一。
      // 与 Radix RadioGroup 的 value 判定口径保持一致，避免双高亮。
      // 改错故障：加归一化会让两个仅大小写不同的模型同时高亮。
      const itemSelected = item.value === normalizedValue;
      // React 的 key 不能跟随 props spread 传入，否则开发环境会在 CDP console 报警。
      // [契约] React key 必须显式传，不能通过 props 展开带入。
      // key 与 value 分离，保证同一模型在不同分组下也不冲突。
      // 改错故障：用 value 当 key 会让跨分组同名模型复用错误的 DOM。
      const itemKey = item.key;
      // [契约] 锁定与未锁定项共享同一组 data 属性，便于测试选择器统一。
      // as const 保证字面量类型，避免展开时被拓宽为 string。
      // 改错故障：拆成两套属性会让测试遗漏锁定分支。
      const commonProps = {
        "data-model-option-locked": itemLocked ? "true" : undefined,
        "data-model-option-selected": itemSelected ? "true" : undefined,
        "data-testid": testId(TID_CHAT_MODEL_SELECT_ITEM, item.value),
        "data-checked": itemSelected ? "true" : undefined,
      } as const;
      // [契约] 项内容与容器解耦，锁定分支与单选分支共用同一份 JSX。
      // 内容里的提示图标包裹在 TooltipProvider 内，避免依赖外层 Provider。
      // 改错故障：只给其中一个分支加提示会让锁定项在另一种容器里失去说明。
      const content = (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            {item.badgeLabel ? (
              <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{item.badgeLabel}</span>
            ) : null}
            {item.supportsVisionInput ? <ModelInputCapabilityBadge /> : null}
          </span>
          {itemLocked ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:text-foreground-subtle"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <AlertCircle className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="center" sideOffset={6}>
                  {lockReasonMessage}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {itemLocked && itemSelected ? (
            <CheckIcon className="size-4 text-foreground-subtle" />
          ) : null}
        </>
      );

      // [契约] 锁定项渲染为普通 DropdownMenuItem 并阻止选择，不进入 RadioGroup。
      // 阻止选择用 preventDefault，保证菜单项本身仍可被悬停读取原因。
      // 改错故障：用 disabled 属性会让提示 Tooltip 无法悬停触发。
      if (itemLocked) {
        return (
          <DropdownMenuItem
            key={itemKey}
            {...commonProps}
            className="min-h-8 cursor-not-allowed gap-2 px-2 text-ui-base text-foreground-subtlest data-[highlighted]:text-foreground-subtlest"
            onSelect={(event) => event.preventDefault()}
          >
            {content}
          </DropdownMenuItem>
        );
      }

      return (
        <DropdownMenuRadioItem
          key={itemKey}
          {...commonProps}
          value={item.value}
          className="min-h-8 gap-2 pl-2 pr-8 text-ui-base"
          onSelect={(event) => {
            handleModelValueChange(item.value);
            // 合并菜单选模型后还可继续调档，阻止菜单项默认关闭；外侧点击仍走原关闭链路。
            if (composerOptions) event.preventDefault();
            else handlePopoverOpenChange(false);
          }}
        >
          {content}
        </DropdownMenuRadioItem>
      );
    },
    [
      composerOptions,
      handleModelValueChange,
      handlePopoverOpenChange,
      isItemLocked,
      lockReasonMessage,
      normalizedValue,
    ],
  );

  // [契约] 一组模型统一包在 DropdownMenuRadioGroup 内，value 即当前选中值。
  // 该函数被 ComposerModelMenu 复用，因此不能引入组件内部状态。
  // 改错故障：在内部再包一层 div 会让 Radix 的键盘导航失效。
  const renderModelItems = useCallback(
    (items: readonly ModelSelectGroupItem[]) => (
      <DropdownMenuRadioGroup value={normalizedValue}>
        {items.map((item) => renderModelItem(item))}
      </DropdownMenuRadioGroup>
    ),
    [normalizedValue, renderModelItem],
  );

  // [契约] 分组标签允许换行，避免长 provider 名被省略号吞掉。
  // mutedLabel 只改变颜色，不改变布局，供子菜单标题复用。
  // 改错故障：改用 truncate 会让同名前缀的 provider 无法区分。
  const renderGroupLabel = useCallback(
    (group: ModelSelectGroup, options: { mutedLabel?: boolean } = {}) => (
      <span className="min-w-0 flex-1 items-center gap-1.5 text-left inline-flex">
        <span
          className={cn(
            "min-w-0 whitespace-normal break-words text-ui-base",
            options.mutedLabel && "text-foreground-subtle",
          )}
          title={group.label}
        >
          {group.label}
        </span>
        {group.labelBadge ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{group.labelBadge}</span>
        ) : null}
      </span>
    ),
    [],
  );

  // [契约] 连接方式子菜单只在有 connectionOptions 时渲染，否则返回 null。
  // 切换连接方式不关闭外层菜单，保证用户能继续选刷新后的模型。
  // 改错故障：切换后关闭菜单会让用户每次都要重新打开两级菜单。
  const renderProviderConnectionHeader = useCallback(
    (group: ModelSelectGroup) => {
      // [契约] 选项数组缺失时按空处理，后续统一走 options.length 分支。
      // 该数组直接来自 props，不做拷贝，避免每次渲染产生新引用。
      // 改错故障：用 [...] 拷贝会让依赖数组每次都判定为变化。
      const options = group.connectionOptions ?? [];
      // [契约] options.length 为 0 即不渲染头部，由调用方决定是否退化为纯标签。
      // 该分支保证 Select 的 value 一定在 options 中存在。
      // 改错故障：无条件渲染会让空 Select 显示为空白触发器。
      if (options.length > 0) {
        // [契约] 未指定选中项时回落到第一个选项，保证受控 Select 有值。
        // 回落的 key 也必须参与后续 find，不能直接用 options[0] 当选中对象。
        // 改错故障：缺省传 undefined 会让 Select 显示占位而不是默认连接方式。
        const selectedOptionKey = group.selectedOptionKey ?? options[0]?.key;
        const selectedConnection =
          options.find((option) => option.key === selectedOptionKey) ?? options[0];
        return (
          <div className="flex min-h-8 items-center gap-2 px-2 py-1">
            <span
              className="min-w-0 flex-1 truncate text-left text-ui-sm font-medium text-foreground-subtlest"
              title={group.label}
            >
              {group.label}
            </span>
            <Select
              value={selectedOptionKey}
              onValueChange={(nextKey) => {
                const option = options.find((candidate) => candidate.key === nextKey);
                if (!option) {
                  return;
                }
                // 切换连接方式后需要保留外层模型菜单，方便用户继续选择刷新后的模型。
                onConnectionValueChange?.(option);
              }}
            >
              <SelectTrigger
                size="xs"
                variant="outline"
                className="min-w-0 shrink-0 gap-0.5 rounded-full pr-1.5 text-ui-sm text-foreground-subtle [&_svg]:size-3"
                data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                data-model-provider-key={group.key}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="max-w-28 truncate">
                  {selectedConnection?.badgeLabel ?? selectedConnection?.label ?? group.label}
                </span>
              </SelectTrigger>
              <SelectContent
                align="end"
                position="popper"
                className="w-max min-w-40 max-w-72"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {options.map((option) => (
                  <SelectItem
                    key={option.key}
                    value={option.key}
                    data-model-connection-option={option.key}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      }

      return null;
    },
    [onConnectionValueChange],
  );

  // [契约] footer 动作在渲染期合成：外部动作在前，管理模型入口在后。
  // 只有非合并入口才注入管理入口，避免与 Composer 底部动作重复。
  // 改错故障：合并入口也注入会让菜单出现两个管理模型按钮。
  const renderedFooterActions = useMemo<ModelSelectFooterAction[]>(() => {
    // [契约] 复制后再 push，绝不修改传入的只读数组。
    // 复制成本很低，但保证了 memo 依赖与外部数据都不被污染。
    // 改错故障：直接 push 会改写调用方常量，第二次渲染出现重复项。
    const actions = [...footerActions];
    // [契约] 管理模型入口需要同时满足：非合并入口、开关允许、有文案。
    // 三者缺一即不注入，避免出现无文案的空按钮。
    // 改错故障：只看 showManageModelsAction 会渲染出没有标签的菜单项。
    if (!composerOptions && showManageModelsAction && manageModelsLabel) {
      actions.push({
        key: "manage-models",
        label: manageModelsLabel,
        onSelect: onManageModels,
      });
    }
    return actions;
  }, [composerOptions, footerActions, manageModelsLabel, onManageModels, showManageModelsAction]);

  // [契约] 高速档由 isGlmHighspeedModel 按模型 name 判定，查找范围是 modelGroups 全部 items。
  // 当前值找不到模型时 name 传空串，isGlmHighspeedModel 需能安全处理空值。
  // 改错故障：只查第一个分组会让子菜单里的模型丢失高速标记。
  const highspeed = isGlmHighspeedModel(
    modelGroups.flatMap((group) => group.items).find((item) => item.value === normalizedValue)
      ?.name ?? "",
  );
  // [契约] 打开态与关闭态是两套触发器内容，不能在同一分支里混用。
  // 打开态用绝对定位叠放文案与图标，靠 group-data 属性切换可见性。
  // 改错故障：两套内容共用一个容器会让宽度锁定失效并出现跳动。
  const triggerContents = showSelectionLabel ? (
    <>
      <span
        data-composer-open-label
        className="absolute inset-x-1.5 truncate text-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:hidden"
      >
        {composerOptions!.selectModelLabel}
      </span>
      <span
        data-composer-open-icon
        aria-hidden="true"
        className="hidden size-4 shrink-0 items-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        {triggerIcon ?? <PackageIcon className="size-4" />}
      </span>
      <span
        data-composer-open-thought
        className="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        <ComposerThoughtIndicator options={composerOptions!} highspeed={highspeed} />
      </span>
    </>
  ) : (
    <>
      {triggerIcon ?? (
        <PackageIcon
          className={cn("pointer-events-none size-4 shrink-0 text-current", triggerIconClassName)}
          aria-hidden="true"
        />
      )}
      <span className={triggerLabelClassName} title={currentTriggerTitle}>
        <RollingToolbarLabel
          label={currentTriggerLabel}
          prefix={pending ? undefined : triggerLabelPrefix}
          prefixClassName={triggerLabelPrefixClassName}
          value={pending ? undefined : triggerLabelValue}
        />
      </span>
      {composerOptions && hasSelectedModel ? (
        <ComposerThoughtIndicator options={composerOptions} highspeed={highspeed} />
      ) : null}
      {triggerBadge}
      {pending ? (
        <LoaderIcon className="pointer-events-none size-3.5 animate-spin text-foreground" />
      ) : null}
      {!pending && (
        <ChevronDownIcon
          className={cn(
            "pointer-events-none size-3.5 text-foreground-subtle",
            indicatorClassName,
            composerOptions && "group-data-[composer-compact=true]/combined:hidden",
          )}
        />
      )}
    </>
  );

  // [契约] 触发器必须是 DropdownMenuTrigger 的直接子节点，asChild 由 Button 承接。
  // 宽度变量只在打开态注入，关闭态必须完全释放，否则挤占其他入口。
  // 改错故障：关闭态保留锁宽会让模型名很长时挤压相邻按钮。
  const modelTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        ref={buttonRef}
        style={
          showSelectionLabel
            ? ({
                // 锁宽只稳定打开态文案；图标态必须释放宽度，否则 resize 后仍挤占其他入口。
                "--composer-model-open-width": `max(${expandedWidth ?? 0}px, 8rem)`,
              } as CSSProperties)
            : undefined
        }
        type="button"
        variant="ghost"
        size="default"
        disabled={disabled}
        data-chat-toolbar-popover-trigger="true"
        data-testid={triggerTestId}
        data-model-current-value={normalizedValue}
        aria-label={
          selectedThoughtLabel ? `${triggerAriaLabel} ${selectedThoughtLabel}` : triggerAriaLabel
        }
        data-composer-combined-model={composerOptions ? "true" : undefined}
        data-composer-collapse-priority={composerOptions ? "3" : undefined}
        onClick={guideTooltipOpen ? onGuideTooltipDismiss : undefined}
        className={cn(
          "w-fit justify-between gap-1 rounded-lg pl-2 pr-1.5 text-ui-base whitespace-nowrap",
          triggerClassName,
          composerOptions && "group/combined relative",
          showSelectionLabel &&
            "px-2 w-(--composer-model-open-width) min-w-32 max-w-(--composer-model-open-width) group-data-[composer-model-icon=true]/toolbar:w-auto group-data-[composer-model-icon=true]/toolbar:min-w-0 group-data-[composer-model-icon=true]/toolbar:max-w-none",
          composerOptions &&
            !hasSelectedModel &&
            "text-foreground-subtle hover:text-foreground-subtle aria-expanded:text-foreground-subtle",
        )}
      >
        {composerOptions ? (
          <ComposerTriggerTransition open={showSelectionLabel}>
            {triggerContents}
          </ComposerTriggerTransition>
        ) : (
          triggerContents
        )}
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={open} onOpenChange={handlePopoverOpenChange}>
      {tooltipTitle ? (
        <ControlHintTooltip
          // 合并入口的 Tooltip 应提示操作，不重复按钮已有的模型和档位。
          title={
            guideTooltipOpen && guideTooltipTitle
              ? guideTooltipTitle
              : (composerOptions?.selectModelLabel ?? tooltipTitle)
          }
          shortcut={guideTooltipOpen ? undefined : shortcutLabel}
          triggerRef={triggerRef}
          // 菜单打开时 Tooltip 不能再成为最上层；否则 Escape 只关闭提示，菜单仍锁住指针。
          open={open ? false : guideTooltipOpen ? true : undefined}
          className={guideTooltipOpen ? "bg-background py-0.5 pr-0.5 pl-2" : undefined}
        >
          {modelTrigger}
        </ControlHintTooltip>
      ) : (
        modelTrigger
      )}
      {open && composerOptions ? (
        <DropdownMenuPortal>
          {/* 插件 webview 显式接收指针，内部事件不冒泡到宿主；透明层让外侧点击走 Radix 关闭链路。
              层级位于插件（10）之上、Composer（20）和浮窗（30）之下，保留同一工具栏的菜单切换。 */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-[19] pointer-events-auto [app-region:no-drag]"
          />
        </DropdownMenuPortal>
      ) : null}
      {open ? (
        <DropdownMenuContent
          className={cn(
            composerOptions
              ? // 外层滚动会带走供应商和 Effort；只让 Models 列表收缩，且排除窗口拖拽命中。
                "w-72 overflow-y-hidden [app-region:no-drag] [&>*:not([data-composer-model-list]):not([data-composer-provider-list])]:shrink-0"
              : shouldShowProviderLevel
                ? "w-max min-w-48 max-w-[calc(100vw-2rem)]"
                : "w-48 max-h-72 overflow-y-auto",
          )}
          collisionPadding={composerOptions ? 12 : undefined}
          align={contentAlign}
          side={contentSide}
          onCloseAutoFocus={(event) => {
            if (!focusSelectorOnClose) {
              // Automations 没有聊天输入框可恢复；保留 Radix 默认行为，
              // 让键盘焦点回到触发器，而不是 preventDefault 后掉到 body。
              return;
            }
            event.preventDefault();
            if (
              !shouldRestoreChatInputFocusAfterPickerClose({
                isCoarseTouchDevice: isCoarseTouchDevice(),
              })
            ) {
              return;
            }
            // 聊天输入框的 data-testid 挂在 contenteditable 自身上，不是父节点。
            // 这里与 mode 选择器保持同一个入口，避免关闭模型弹层后找不到输入框而丢失焦点。
            const input = document.querySelector<HTMLElement>(focusSelectorOnClose);
            input?.focus();
          }}
        >
          {leadingItems !== undefined && leadingItems.length > 0 ? (
            <>
              {renderModelItems(leadingItems)}
              {hasSelectableModel ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {composerOptions ? (
            <ComposerModelMenu
              groups={modelGroups}
              normalizedValue={normalizedValue}
              options={composerOptions}
              isItemLocked={isItemLocked}
              onSelectModel={handleModelValueChange}
              renderItems={renderModelItems}
              renderConnection={renderProviderConnectionHeader}
              providerFooter={
                showManageModelsAction && manageModelsLabel ? (
                  <DropdownMenuItem
                    className="min-h-8 gap-2 px-2"
                    data-model-footer-action="manage-models"
                    onSelect={() => {
                      handlePopoverOpenChange(false);
                      onManageModels?.();
                    }}
                  >
                    {manageModelsLabel}
                  </DropdownMenuItem>
                ) : null
              }
            />
          ) : hasSelectableModel && shouldShowProviderLevel ? (
            modelGroups.map((group, index) => {
              // [契约] 分隔线由相邻两组共同决定，必须在 map 内按 index 取前一组。
              // index 为 0 时传 undefined，函数据此返回 false。
              // 改错故障：用后一组判断会让分隔线整体前移一位。
              const groupSeparator = shouldRenderModelGroupSeparator(
                modelGroups[index - 1],
                group,
              ) ? (
                <DropdownMenuSeparator />
              ) : null;
              // [契约] directItems 分组平铺模型，但仍渲染分组标题与连接方式头部。
              // 该分支与子菜单分支互斥，二者共用同一个分隔线节点。
              // 改错故障：两个分支都渲染会让同一分组出现两次标题。
              if (group.directItems) {
                return (
                  <Fragment key={group.key}>
                    {groupSeparator}
                    <div>
                      <DropdownMenuLabel
                        className="flex min-h-8 items-center px-2 py-1"
                        data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                        data-model-provider-key={group.key}
                      >
                        {renderGroupLabel(group)}
                      </DropdownMenuLabel>
                      {renderProviderConnectionHeader(group)}
                      <DropdownMenuRadioGroup value={normalizedValue}>
                        {group.items.map((item) => renderModelItem(item))}
                      </DropdownMenuRadioGroup>
                    </div>
                  </Fragment>
                );
              }

              // [契约] 非 directItems 分组用子菜单展示，选中信息体现在触发器勾选上。
              // 该值只驱动勾选图标与 data 属性，不改变子菜单展开逻辑。
              // 改错故障：用它替代 Radix 的选中态会让子项与父项显示不一致。
              const groupSelected = isModelSelectGroupSelected(group, normalizedValue);
              return (
                <Fragment key={group.key}>
                  {groupSeparator}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      className="min-h-8"
                      data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                      data-model-provider-key={group.key}
                      data-model-provider-selected={groupSelected ? "true" : undefined}
                    >
                      {renderGroupLabel(group)}
                      {groupSelected ? (
                        <CheckIcon className="size-4 text-foreground-subtle" />
                      ) : null}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className={cn(
                        "max-h-72 overflow-y-auto",
                        // 固定宽度会提前截断模型名；按内容扩展，并让可用空间优先于最小宽度。
                        providerSubmenuClassName ??
                          "w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)",
                      )}
                    >
                      {renderModelItems(group.items)}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </Fragment>
              );
            })
          ) : hasSelectableModel ? (
            renderModelItems(modelGroups[0]?.items ?? [])
          ) : null}
          {renderedFooterActions.length > 0 ? (
            <div className="sticky bottom-0 z-10 bg-menu after:absolute after:left-0 after:top-full after:h-1 after:w-full after:bg-menu after:content-['']">
              {hasSelectableModel ? <DropdownMenuSeparator /> : null}
              {renderedFooterActions.map((action) => (
                <DropdownMenuItem
                  key={action.key}
                  className="min-h-8 gap-2 px-2"
                  data-model-footer-action={action.key}
                  data-model-footer-action-selected={action.selected ? "true" : undefined}
                  onSelect={() => {
                    handlePopoverOpenChange(false);
                    action.onSelect?.();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.selected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
                </DropdownMenuItem>
              ))}
            </div>
          ) : null}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
});
