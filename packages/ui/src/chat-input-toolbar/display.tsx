/* eslint-disable max-lines -- 工具展示 */
// 聊天输入工具栏「配置下拉」展示层：把 ZCodeConfigOption 投影成带图标、告警色、国际化文案与
// 键盘语义的 Select；纯函数负责文案/图标/搜索口径，ConfigSelect 负责渲染与焦点交接。
// 不负责：选项抓取与持久化、选择后的服务写回、焦点策略的底层判定（见 hooks 与 pickerFocus）。
//
// INV-01 断言：高权限模式的判定只来自 HIGH_PERMISSION_MODE_VALUES 集合 —— 守住它的位置：isHighPermissionModeValue 与 ConfigSelect 的配色分支 —— 改错故障：新增高权限 id 未登记时工具栏不再显示告警色与告警盾，用户在全权限模式下失去风险提示
// INV-02 断言：hook 调用必须全部位于 ConfigSelect 的 early return 之前 —— 守住它的位置：handleContentKeyDown 与 option.type 判断的先后顺序 —— 改错故障：option 在 select 与非 select 之间切换时 React 抛 Rendered fewer hooks than expected，整个工具栏区域白屏
// INV-03 断言：值域外的 onValueChange 回调一律丢弃 —— 守住它的位置：isConfigSelectValueInOptions 与 Select 的 onValueChange —— 改错故障：Radix 受控值与子项注册竞争产生的空值被当成用户选择，Automations 详情页仅打开就被标记为未保存
// INV-04 断言：空搜索词恒命中 —— 守住它的位置：matchesModelDisplayNameSearch 的空串分支 —— 改错故障：搜索框清空后模型列表为空，用户以为模型不可用
// INV-05 断言：模型搜索只比对展示名 —— 守住它的位置：buildModelSearchText 与匹配函数 —— 改错故障：搜索重新命中分组名或模型值，出现搜 A 命中 B 的不可解释结果
// INV-06 断言：重试文案不输出倒计时 —— 守住它的位置：ChatApiRetryStatus 的 useMemo —— 改错故障：上游只给单帧快照，渲染 X 秒后继续 后数字静止，用户以为重试卡死
// INV-07 断言：无重试数据时整块不渲染 —— 守住它的位置：ChatApiRetryStatus 的 null 早退 —— 改错故障：工具栏插入空 span，左侧文字与按钮间距被撑开
// INV-08 断言：模式文案按 provider 分层查表 —— 守住它的位置：getModeOptionLabelMessageId 与 getModeOptionDescriptionMessageId —— 改错故障：不同厂商同名模式串文案，菜单标题与描述对不上
// INV-09 断言：标题表与描述表互不兜底 —— 守住它的位置：getConfigOptionEntryDescription 的回退链 —— 改错故障：缺描述的模式把标题当描述渲染，菜单项出现重复的两行同文
// INV-10 断言：非 mode 类别不翻译候选名称 —— 守住它的位置：getConfigOptionEntryLabel 的类别分支 —— 改错故障：服务端已本地化的思考等级名称被二次翻译，出现错译或未翻译占位
// INV-11 断言：toolbar 浮层定位只服务 mode 与 thought_level —— 守住它的位置：shouldUseToolbarFloatingSelect 与 selectContentProps —— 改错故障：其他下拉被强制向上展开，靠近窗口顶部时内容被裁切
// INV-12 断言：当前值不在候选列表时仍要能回显 —— 守住它的位置：currentEntry 为 undefined 时的 mode 分支 —— 改错故障：隐藏模式在触发器中显示原始协议 id 或空白，用户不知道当前处于哪个模式
// INV-13 断言：restoreFocusSelector 为 null 时保留 Radix 默认回焦 —— 守住它的位置：onCloseAutoFocus 的首个分支 —— 改错故障：Automations 权限选择器关闭后焦点掉到 body，键盘用户失去操作起点
// INV-14 断言：触发器与菜单项 testId 只对受支持类别输出 —— 守住它的位置：getConfigSelectTriggerTestId 与 getConfigSelectItemTestId —— 改错故障：e2e 锚点缺失或改名，工具栏相关用例静默失效而不报红
// INV-15 断言：受控值统一字符串化后再交给 Select —— 守住它的位置：Select 的 value 与 String(option.currentValue) —— 改错故障：null 或数字让 Radix 退化为非受控，选中项与状态不同步
// 阅读顺序：先核对 INV 表，再看各函数前的 [契约]/[失败路径]/[权衡] 块；标 [权衡] 的多是看似可改、实际会回归的位置。
import {
  useCallback,
  useMemo,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodeConfigSelectValue,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ChevronDownIcon,
  HandIcon,
  NotepadText,
  ShieldAlertIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ZCODE_MODE_OPTION_DESCRIPTION_IDS,
  ZCODE_MODE_OPTION_LABEL_IDS,
} from "./display-help.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";

export {
  ChatContextUsage,
  getContextCompressionCommand,
  getRenderableTaskUsage,
} from "@/chat-input-toolbar/contextUsage.js";

type ConfigSelectTriggerSize = ComponentProps<typeof SelectTrigger>["size"];
type ConfigSelectTriggerVariant = ComponentProps<
  typeof SelectTrigger
>["variant"];

/** Radix Select 在受控值与子项注册竞争时可能发出空值等未渲染值；直接上抛会把
 * 系统事件误当成用户选择（如 Automations 编辑页仅打开详情就被标记未保存修改）。
 * 用户只能点到已渲染的 option，值域外的选择回调一律丢弃。 */
export function isConfigSelectValueInOptions(
  option: ZCodeConfigOption,
  value: string,
): boolean {
  return option.options?.some((entry) => String(entry.value) === value) ?? false;
}

// [契约] 高权限模式集合是唯一判定源，工具栏配色、图标与告警态都从这里派生
// 新增协议侧高权限 id 时必须同步登记，否则该模式会被当成普通模式渲染
// 集合故意保留历史 id（full-access 与 yolo），兼容旧会话回放时的存量取值
// 不要在渲染处再写字符串比较分支，重复判定会在新增 id 时漏掉一处
const HIGH_PERMISSION_MODE_VALUES = new Set([
  "bypassPermissions",
  "full-access",
  // Bugfix: Agent 0.0.44 将旧 full-access mode id 改为 agent-full-access。
  // 高权限视觉提示必须跟随协议 id，否则用户选中全权限后工具栏不再显示 warning 状态。
  "agent-full-access",
  "yolo",
]);

// [契约] 触发器 e2e 锚点只对 thought_level 与 mode 两类下拉暴露，其余返回 undefined
// 自动化用例靠这两个 testId 定位工具栏按钮，改名等于让整条用例静默失效
// 新增类别若也需要锚点，请扩展 shared 里的 test-ids，不要在组件内拼裸字符串
// 返回 undefined 时 SelectTrigger 不写 data-testid 属性，属预期而非缺陷
function getConfigSelectTriggerTestId(
  option: ZCodeConfigOption,
): string | undefined {
  if (option.category === "thought_level") {
    return TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER;
  }
  // 模式选择器 e2e 锚点（v4 switchCollaborationMode 链路断言用）。
  if (option.category === "mode") {
    return TID_CHAT_MODE_SELECT_TRIGGER;
  }

  return undefined;
}

// [契约] 菜单项锚点由 testId 前缀加候选值拼装，value 必须取自 option 的候选值
// 候选顺序由上层数据源决定，这里只做拼接，不排序也不去重
// 模式项与思考等级项的锚点前缀不同，混用会让断言命中错误的下拉
// 非受支持类别统一返回 undefined，避免给无关下拉留下可被误用的钩子
function getConfigSelectItemTestId(
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string | undefined {
  if (option.category === "thought_level") {
    return testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, entry.value);
  }
  if (option.category === "mode") {
    return testId(TID_CHAT_MODE_SELECT_ITEM, entry.value);
  }

  return undefined;
}

// [权衡] 搜索文本只保留展示名，是产品明确收敛的结果，不要顺手并进分组名或模型值
// 合并更多字段会让搜 A 命中 B 重新出现，用户侧表现为搜索结果不可解释
// trim 后原样返回，空串表示不过滤，过滤与否交由匹配函数统一判断
// 该函数无副作用，可在渲染期直接调用，不要改成带缓存的实现
export function buildModelSearchText({
  itemName,
}: {
  itemName: string;
}): string {
  // Bugfix: 需求要求模型搜索仅匹配“展示名”，不能再命中分组名/模型值。
  // 这里统一只返回展示名，保证搜索范围收敛且稳定。
  return itemName.trim();
}

// [契约] 空搜索词恒为真，等价于不过滤，任何早退重构都必须保住这条
// 大小写不敏感通过 toLocaleLowerCase 实现，保证非英语 locale 下行为一致
// 只做包含匹配，不做分词与模糊打分，避免搜索结果的顺序抖动
// 展示名与搜索词同口径 trim，否则前后空格会让用户搜不到已展示的项
export function matchesModelDisplayNameSearch(
  modelDisplayName: string,
  searchText: string,
): boolean {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  if (normalizedSearchText.length === 0) {
    return true;
  }

  // Bugfix: 统一用大小写不敏感匹配，避免用户输入大小写与展示名不一致时搜不到。
  return modelDisplayName
    .trim()
    .toLocaleLowerCase()
    .includes(normalizedSearchText);
}

// [失败路径] 上游只推某一刻的重试快照，没有递减心跳，因此文案不展示倒计时
// 把 retryDelayMs 渲染成 X 秒后继续 会让用户以为卡死，这是已被回退的旧实现
// apiRetry 与文案同时为空时整块返回 null，工具栏既不占位也不留空白间距
// 错误码用中点加 HTTP 拼进 title 而非正文，避免正文被状态码撑长换行
export function ChatApiRetryStatus({
  apiRetry,
  intl,
  locale,
}: {
  apiRetry: ZCodeApiRetryStatus | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
}) {
  const retryLabel = useMemo(() => {
    if (!apiRetry) {
      return null;
    }

    // 当前 ZCode Agent 只会推送某一刻的 retryDelayMs 快照，不会每秒递减。
    // 继续把这个值渲染成“X 秒后继续”会给用户造成倒计时在卡住的错觉。
    // 这里先收敛成稳定的重试状态文案，只展示第几次重试。
    const formatter = new Intl.NumberFormat(locale);
    return intl.formatMessage(
      { id: "chat.apiRetryStatus" },
      {
        attempt: formatter.format(apiRetry.attempt),
        maxRetries: formatter.format(apiRetry.maxRetries),
      },
    );
  }, [apiRetry, intl, locale]);

  if (!apiRetry || !retryLabel) {
    return null;
  }

  const retryTitle =
    apiRetry.errorStatus == null
      ? retryLabel
      : `${retryLabel} · HTTP ${apiRetry.errorStatus}`;

  return (
    <span
      className="inline-flex h-7 items-center whitespace-nowrap px-1 text-ui-base"
      title={retryTitle}
    >
      {/* 样式修复原因：Retry 需要保留 ToolCall/Thinking 的字号、扫光节奏和低透明度移动低谷，
      但作为次级运行状态不应使用同等的纯黑/纯白峰值；这里只将峰值降到 secondary 文本色。 */}
      <span className="animated-gradient-text animated-gradient-text-subtle font-medium">
        {retryLabel}
      </span>
    </span>
  );
}

// [契约] 有 provider 且命中文案表时优先走国际化，否则回退到协议下发的名称
// 回退分支保证未知 provider 或新模式仍显示可读 label，不会渲染成空按钮
// 文案 id 的查找集中在 getModeOptionLabelMessageId，不要在此重复维护映射
// 当前值不在候选列表时也会走到这个回退（见隐藏模式的回显分支）
export function getModeOptionDisplayLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "name" | "value">,
): string {
  const labelMessageId = getModeOptionLabelMessageId(provider, entry);
  if (!labelMessageId) {
    return entry.name;
  }

  return intl.formatMessage({ id: labelMessageId });
}

// [契约] provider 缺失时直接返回 null，调用方据此走回退名称
// 映射表按 provider 分层，同一 value 在不同 provider 下文案可以不同
// 查不到时返回 null 而不是抛错，新模式上线初期必然存在未登记文案
// 不要在返回值里做格式化，格式化统一交给 intl.formatMessage
export function getModeOptionLabelMessageId(
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "value">,
): string | null {
  if (!provider) {
    return null;
  }

  return ZCODE_MODE_OPTION_LABEL_IDS[provider]?.[entry.value] ?? null;
}

// [契约] 描述文案与标题文案是两张独立表，不能互相兜底
// 返回 null 表示该模式没有描述，菜单项会省略第二行而不是渲染空行
// provider 维度必须保留，否则不同厂商的同名模式会串描述
// 新增模式时两张表都要补，只补标题会出现有标题无说明的半成品菜单
export function getModeOptionDescriptionMessageId(
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "value">,
): string | null {
  if (!provider) {
    return null;
  }

  return ZCODE_MODE_OPTION_DESCRIPTION_IDS[provider]?.[entry.value] ?? null;
}

// [契约] 只有 mode 类别走模式文案解析，其余类别原样使用候选自带的名称
// 思考等级等类别的名称来自服务端且已本地化，二次翻译会得到错误文案
// 不要把判断改成按 value 猜类别，扩展类别会误入模式分支
// 该函数只读，可在 map 渲染中重复调用，不需要引入缓存层
export function getConfigOptionEntryLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string {
  if (option.category === "mode") {
    return getModeOptionDisplayLabel(intl, provider, entry);
  }

  return entry.name;
}

// [契约] 非 mode 类别直接透传候选描述，可能是 undefined
// mode 类别优先取国际化描述，缺失时回退到候选自带描述
// 调用方需容忍 undefined，菜单项据此决定是否渲染说明行
// 不要在这里 trim，是否展示空描述由渲染处的判断负责
export function getConfigOptionEntryDescription(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string | undefined {
  if (option.category !== "mode") {
    return entry.description;
  }

  const descriptionMessageId = getModeOptionDescriptionMessageId(
    provider,
    entry,
  );
  if (descriptionMessageId) {
    return intl.formatMessage({ id: descriptionMessageId });
  }

  return entry.description;
}

// [契约] 入参放宽为 unknown，因为 currentValue 可能为 null 或数字
// 非字符串一律视为非高权限，避免类型漂移时把普通模式标成告警色
// 判定只做集合查询，不做 trim 或大小写折叠，协议值需保持精确匹配
// 新增高权限 id 请改集合常量，不要在此处追加散落条件
export function isHighPermissionModeValue(value: unknown): boolean {
  return typeof value === "string" && HIGH_PERMISSION_MODE_VALUES.has(value);
}

// [契约] 图标优先级固定：高权限告警高于 default 与 build，plan 次之，编辑类再次之，最后兜底手形
// build 与 default 共用常规确认图标，因为 build 会被本地化成默认模式
// 正则大小写不敏感，兼容 autoEdit 与 acceptEdits 这类混合命名
// 未知取值回退 HandIcon 而非报错，保证新协议值上线时工具栏不空白
export function resolveModeOptionIcon(value: unknown): LucideIcon {
  if (isHighPermissionModeValue(value)) {
    return ShieldAlertIcon;
  }

  // Bugfix: build 会被本地化成“默认模式”，和 default 一样应使用常规确认图标。
  if (typeof value === "string" && /^(default|build)$/i.test(value))
    return HandIcon;
  if (typeof value === "string" && value.toLocaleLowerCase() === "plan")
    return NotepadText;

  if (
    typeof value === "string" &&
    /^(auto|acceptEdits|agent|autoEdit|dontAsk|edit|guarded)$/i.test(value)
  ) {
    return ShieldCheckIcon;
  }

  return HandIcon;
}

// [契约] 本组件同时服务聊天工具栏与 Automations 弹窗，默认值都按工具栏场景设定
// restoreFocusSelector 传 null 表示宿主页面没有聊天输入框，焦点策略随之切换
// labelVisibilityClassName 默认在大容器下展示文字，窄容器隐藏以节省横向空间
// 不要在此组件内取服务或读 store，选项与当前值全部由入参驱动
export function ConfigSelect({
  option,
  onValueChange,
  open,
  onOpenChange,
  disabled,
  tooltipTitle,
  shortcutLabel,
  triggerRef,
  triggerClassName,
  indicatorClassName,
  triggerVariant = "ghost",
  triggerSize = "lg",
  leadingIcon: LeadingIcon,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  provider,
  restoreFocusSelector = '[data-testid="chat-input"]',
}: {
  option: ZCodeConfigOption;
  onValueChange: (value: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  tooltipTitle: string;
  shortcutLabel?: string;
  triggerRef?: RefObject<HTMLSpanElement | null>;
  triggerClassName?: string;
  indicatorClassName?: string;
  triggerVariant?: ConfigSelectTriggerVariant;
  triggerSize?: ConfigSelectTriggerSize;
  leadingIcon?: LucideIcon;
  labelVisibilityClassName?: string;
  provider?: ZCodeProvider;
  restoreFocusSelector?: string | null;
}) {
  // [契约] 国际化实例在此取一次，后续所有文案解析复用同一个 intl
  // 下方 early return 之前不允许再新增 hook，否则会重现渲染 hook 数量不一致的崩溃
  // 需要新 hook 时请加在 early return 之前，并复核每次渲染都会执行
  // 不要把这个取值下移到条件分支内，条件执行 hook 同样会破坏调用顺序
  const { intl } = useZCodeIntl();

  // [权衡] 菜单内的 Tab 键被改装成提交高亮项，与普通下拉的焦点跳转语义不同
  // 高亮项查找依次回退到选中项和首项，保证键盘打开菜单后 Tab 一定有事可做
  // 这里只接管 Tab，其余按键继续交给 Radix，避免自实现完整键盘导航
  // 阻止默认行为必须在确认存在目标项之后，否则空菜单会吞掉焦点移动
  // 注意：handleContentKeyDown 必须在 early return 之前调用。
  // 之前 `if (option.type !== "select" ...) return null` 写在 useCallback 之前，
  // 当 option 在 select/非 select 之间切换（或 options 数组从空变非空）时，
  // 本组件这次渲染执行的 hook 数量和上次不一致，React 会抛
  // "Rendered fewer hooks than expected" 导致工具栏区域崩溃。
  // 修复方式：early return 下移到所有 hook 之后，保证 hook 调用顺序稳定。
  const handleContentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") {
        return;
      }

      const highlightedItem =
        event.currentTarget.querySelector<HTMLElement>(
          '[data-slot="select-item"][data-highlighted]',
        ) ??
        event.currentTarget.querySelector<HTMLElement>(
          '[data-slot="select-item"][data-state="checked"]',
        ) ??
        event.currentTarget.querySelector<HTMLElement>(
          '[data-slot="select-item"]',
        );

    if (!highlightedItem) {
      return;
    }

      event.preventDefault();
      highlightedItem.click();
    },
    [],
  );

  // [契约] early return 必须位于所有 hook 之后，这是硬约束而不是风格偏好
  // option 在 select 与非 select 之间切换时，hook 数量变化会直接抛错并炸掉工具栏
  // options 由空变非空也会触发同一问题，不能只按类别判断风险
  // 若将来引入 useMemo，同样要放在此处之前
  // early return 必须在所有 hook 之后（见上方注释说明的崩溃原因）
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  // [契约] 只有 mode 与 thought_level 使用 toolbar 浮层样式，其余类别沿用默认行为
  // 该判定同时决定下拉展开方向与宽度，改动会影响工具栏底部的可视区域
  // 新增类别若也靠近窗口底边，需要在此扩展而不是在样式里逐处覆盖
  // 两个类别共享同一浮层配置，保证相邻两个下拉的间距与方向一致
  const shouldUseToolbarFloatingSelect =
    option.category === "mode" || option.category === "thought_level";
  const shouldShowHighPermissionModeIcon =
    option.category === "mode" &&
    isHighPermissionModeValue(option.currentValue);
  const ResolvedLeadingIcon =
    option.category === "mode"
      ? resolveModeOptionIcon(option.currentValue)
      : LeadingIcon;
  // [权衡] 高权限告警色挂在 trigger 而非图标上，hover 与展开态才不会闪回默认色
  // guarded 用浅蓝与 YOLO 的告警色区分，两者视觉语义不同不可合并
  // 样式优先级依赖 cn 的合并顺序，调整参数顺序可能让告警色被覆盖
  // 颜色状态与图标选择分离：图标换成告警盾，但配色仍由这里统一承载
  const resolvedTriggerClassName = cn(
    triggerClassName,
    shouldShowHighPermissionModeIcon &&
      // 高权限模式需要在工具栏中持续保持 warning 文字颜色，避免用户忽略当前风险级别。
      // 图标只负责替换为 shield-alert，颜色状态仍由 trigger 统一承载，保证 hover/展开态不闪回默认色。
      "text-warning hover:text-warning aria-expanded:text-warning",
    // Guarded 与 YOLO 视觉区分；图标继承浅蓝色，hover/展开时也不回退为默认色。
    option.category === "mode" &&
      option.currentValue === "guarded" &&
      "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue",
  );
  const resolvedLeadingIconClassName = cn(
    "pointer-events-none size-4 text-current",
    shouldShowHighPermissionModeIcon && "text-warning",
  );

  // [权衡] 工具栏下拉改用 popper 向上展开，item-aligned 会被窗口底边压缩高度
  // sideOffset 与 collisionPadding 是有意收敛的常量，改动会打破两个菜单的对齐一致
  // mode 菜单固定宽度以容纳图标加描述的复合内容，思考等级保持自适应
  // 非工具栏类别不传浮层参数，交给 Radix 默认定位
  const selectContentProps = shouldUseToolbarFloatingSelect
    ? {
        // 聊天工具栏底部的 mode / thought_level 选单如果继续使用默认 item-aligned，
        // 会因为触发器靠近窗口底边而压缩可视高度，导致展开方向和可见区域不一致。
        // 这里统一改成 popper 向上展开，并收敛成一致的 4px 间距，保证两个菜单表现一致。
        position: "popper" as const,
        side: "top" as const,
        align: "start" as const,
        sideOffset: 4,
        collisionPadding: 8,
        className: option.category === "mode" ? "w-64" : undefined,
      }
    : undefined;
  const triggerTestId = getConfigSelectTriggerTestId(option);
  // [失败路径] 当前值可能已被隐藏出候选列表，此时 currentEntry 为 undefined
  // mode 类别需要按当前值单独翻译回显文案，否则按钮会显示原始协议 id
  // 回显只借用翻译能力，不把隐藏项补回 options，避免用户重新选到已下线的模式
  // 其余类别直接字符串化当前值，保持与候选名称同源
  const currentEntry = option.options.find(
    (entry) => entry.value === option.currentValue,
  );
  const currentValueLabel = currentEntry
    ? getConfigOptionEntryLabel(intl, provider, option, currentEntry)
    : option.category === "mode"
      // 隐藏旧模式候选不应丢失其回显文案；只翻译当前值，不把它补回可选列表。
      ? getModeOptionDisplayLabel(intl, provider, {
          value: String(option.currentValue ?? ""),
          name: String(option.currentValue ?? ""),
        })
    : String(option.currentValue ?? "");
  // [契约] 思考等级需要首字母大写，是唯一的文本变换，不涉及翻译
  // 该类名同时作用于触发器与菜单项，保证两处大小写一致
  // mode 类别保持 undefined，避免复合内容被额外变换
  // 不要在渲染处内联拼接首字母大写逻辑，容易与截断样式冲突
  const thoughtLevelTextClassName =
    option.category === "thought_level" ? "first-letter:uppercase" : undefined;

  // [契约] 受控值统一字符串化，Select 不接受 null 或数字，否则会退化为非受控
  // onValueChange 内先做值域校验，值域外回调来自 Radix 内部竞争而非用户点击
  // 下拉关闭后的焦点交接依赖 onCloseAutoFocus，与 restoreFocusSelector 成对出现
  // 菜单内容全部由 option.options 派生，不在此处插入额外的静态项
  return (
    <Select
      open={open}
      onOpenChange={onOpenChange}
      value={String(option.currentValue)}
      onValueChange={(value) => {
        // 见 isConfigSelectValueInOptions：值域外的回调来自 Radix 内部竞争，不是用户选择。
        if (!isConfigSelectValueInOptions(option, value)) {
          logger.warn("[ConfigSelect] 忽略值域外的选择回调", {
            category: option.category,
            value,
          });
          return;
        }
        onValueChange(value);
      }}
      disabled={disabled}
    >
      <ControlHintTooltip
        title={tooltipTitle}
        shortcut={shortcutLabel}
        triggerRef={triggerRef}
      >
        <SelectTrigger
          variant={triggerVariant}
          size={triggerSize}
          className={resolvedTriggerClassName}
          indicator={
            <ChevronDownIcon
              className={cn(
                "pointer-events-none size-3.5 text-foreground-subtle",
                indicatorClassName,
              )}
            />
          }
          aria-label={tooltipTitle}
          data-testid={triggerTestId}
        >
          {ResolvedLeadingIcon ? (
            <ResolvedLeadingIcon className={resolvedLeadingIconClassName} />
          ) : null}
          <span className={labelVisibilityClassName}>
            {/* Bugfix: mode 菜单项现在是“图标 + 标题 + 描述”的复合内容。
            如果继续让 Radix 从 ItemText 自动回填，trigger 会把描述也塞进按钮里。 */}
            {option.category === "mode" ? (
              <RollingToolbarLabel label={currentValueLabel} />
            ) : (
              <SelectValue>
                <span className={thoughtLevelTextClassName}>
                  {currentValueLabel}
                </span>
              </SelectValue>
            )}
          </span>
        </SelectTrigger>
      </ControlHintTooltip>
      <SelectContent
        {...selectContentProps}
        onKeyDown={handleContentKeyDown}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusSelector) {
            // Automations 权限选择器没有聊天输入框可恢复；之前无条件
            // preventDefault 会把 Radix 默认的“回焦到 trigger”一并吃掉，键盘焦点
            // 关闭菜单后掉到 body。null 时保留默认行为，让焦点回到触发器。
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
          // Bugfix: ConfigSelect 被 Bot 弹窗复用时，关闭菜单不能强制抢焦点到聊天输入框。
          const input =
            document.querySelector<HTMLElement>(restoreFocusSelector);
          logger.debug("[ConfigSelect] picker focus handoff", {
            category: option.category,
            restoreFocusSelector,
            targetFound: Boolean(input),
          });
          input?.focus();
        }}
      >
        {option.category === "mode"
          ? option.options.map((entry) => {
              const ModeIcon = resolveModeOptionIcon(entry.value);
              const optionLabel = getConfigOptionEntryLabel(
                intl,
                provider,
                option,
                entry,
              );
              const optionDescription = getConfigOptionEntryDescription(
                intl,
                provider,
                option,
                entry,
              );

              return (
                <SelectItem
                  key={entry.value}
                  value={entry.value}
                  className="min-h-13 items-start gap-3 py-2 pl-2 pr-8"
                  data-testid={getConfigSelectItemTestId(option, entry)}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <ModeIcon className="mt-0.5 size-4.5 shrink-0 text-foreground" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-ui-base/relaxed text-foreground">
                        {optionLabel}
                      </span>
                      {optionDescription?.trim() ? (
                        <span className="line-clamp-2 text-ui-sm/relaxed text-foreground-subtle whitespace-nowrap">
                          {optionDescription}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </SelectItem>
              );
            })
          : option.options.map((entry) => (
              <SelectItem
                key={entry.value}
                value={entry.value}
                data-testid={getConfigSelectItemTestId(option, entry)}
              >
                <span className={thoughtLevelTextClassName}>
                  {getConfigOptionEntryLabel(intl, provider, option, entry)}
                </span>
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );
}
