// ChatPromptActionMenu：composer 左下角「+」按钮的添加菜单（附件、快捷命令、@ 上下文与插件）。
// 标记约定：[并发] 异步/竞态，[事务] 多段状态一致性，[资源] 句柄与订阅，[失败路径] 异常分支，[权衡] 取舍。
// INV-01 菜单可见性恒为 open 与 !disabled 的合取：由 Popover 的 open 表达式守卫；只取 open 会让禁用态仍可打开并插入。
// INV-02 禁用时禁止任何插入：selectOption 首行提前返回；放开会让禁用输入框收到 mention 节点。
// INV-03 选项顺序恒为 附件、快捷命令、mentionItems：由 options 与 sections 两处同构拼装维持；错序会让下标映射错位。
// INV-04 下标换算恒以 attachmentCount 补偿附件占位：selectOption 中两处减法；漏减会把附件点击当成首条命令。
// INV-05 快捷命令仅对严格空草稿提供：onOpenChange 内 emptyDraft 判定；放开会在消息中间插入被 CLI 忽略的裸文本。
// INV-06 /goal 仅在新会话提供：offered 的 sessionId === null 条件；放开会让已有会话的目标命令被静默丢弃。
// INV-07 /workflow 依赖 CLI catalog 存在：用 normalizeSlashCommandValue 比对名称；catalog 缺项后仍会照发裸文本。
// INV-08 excludedSlashCommandNames 必须参与过滤：offered 的第三项；忽略会让调用方显式排除的命令仍出现在菜单。
// INV-09 quickCommands 只在打开瞬间计算一次：setQuickCommands 位于 nextOpen 分支；每次渲染重算会造成候选漂移。
// INV-10 打开时的 EditorState 快照不可省：selectionStateRef 赋值；丢掉快照会让插入落点漂移到失焦后的选区。
// INV-11 打开时必须重置 selectedIndex 为 0：与快照同段执行；不复位会沿用上次高亮导致回车选中错误项。
// INV-12 提及类 provider 仅在可见且未禁用时激活：各 provider 的激活布尔参数；无条件拉取会在禁用态产生无效请求。
// INV-13 plugins 与 files 共用 showPlugins 开关：同一布尔传入两处；拆分会导致两栏显隐不一致。
// INV-14 sessions 的 scope 恒为 @：getSessionMentionWorkspaceScope 入参；换默认触发符会与 @ 面板语义冲突。
// INV-15 「添加」分区在无选项时整体剔除：sections 尾部 filter；不剔除会渲染出空白标题条。
// INV-16 面板锚点必须是容器矩形：anchorRef 的 getBoundingClientRect；退回按钮锚点会让菜单错位到旧按钮。
// INV-17 键盘上下移动必须跳过禁用项：onKeyDown 内按 options.length 取模的循环；不跳过会停在不可选项上。
// INV-18 Enter/Tab/Space 必须阻止默认行为与冒泡：对应分支的两次调用；否则空格会落进编辑器并关闭菜单。
// INV-19 插入后需把焦点交还编辑器：restoreEditorFocusRef 与 onCloseAutoFocus 配合；否则下一次输入丢失焦点。
// INV-20 关闭时不重置高亮与候选，只在下次打开时覆盖；若在关闭分支清空，重开会先渲染空列表再补齐，造成闪空。
import { ContextMentionOptionContent } from "@/mentions/components/ContextMentionOptionContent.js";
import { useFileMentionProvider } from "@/mentions/providers/fileMentionProvider.js";
import { useSessionsMentionProvider } from "@/mentions/providers/sessionsMentionProvider.js";
// 依赖方向恒为 UI 组件指向 mention provider 与命令目录，此处不反向引用 composer 状态；新增导入前先确认无循环依赖。
// [资源] 每个 provider hook 都会建立订阅，数量与参数决定请求次数；激活条件统一收敛为 open && !disabled && showPlugins，新增 hook 需沿用同一条件。
import {
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  buildVisibleMentionGroups,
} from "@/mentions/mentionSearch.js";
import { getSessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import { useMemo, useRef, useState, type MutableRefObject } from "react";
import type { EditorState } from "lexical";
import { GoalIcon, Info, PaperclipIcon, PlusIcon, Workflow } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { normalizeSlashCommandValue } from "@/slashCommandHelpers.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MentionPanel, type MentionPanelSection } from "@/mentions/components/MentionPanel.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import { usePluginsMentionProvider } from "@/mentions/providers/pluginsMentionProvider.js";

/**
 * 「添加」分区里紧随附件之后的命令快捷项，选中即插入与 `/` 面板相同的命令标签。
 * 两者都只在消息开头解析/展开，所以只对严格空草稿提供。
 */
// QUICK_COMMANDS 是静态目录：只描述图标与文案标识，不含可用性判断，可用性一律在 onOpenChange 里按草稿与会话状态计算。
// [权衡] 把 goal 与 workflow 写死在此而不从 catalog 动态生成，是因为插入载荷必须是斜杠命令文本；动态生成会混入不需要的命令。
// id 前缀 add- 只用于面板内部 key，与插入值无关；改 id 不影响 CLI 展开，但会让既有测试选择器失效。
// labelId 指向 i18n key，缺 key 时 intl 回退为 key 本身，表现为菜单出现 chat.xxx 字样，新增命令必须同步语言包。
const QUICK_COMMANDS = {
  goal: { id: "add-goal", labelId: "chat.goalBanner.label", Icon: GoalIcon },
  workflow: { id: "add-workflow", labelId: "chat.composer.addWorkflow", Icon: Workflow },
} as const;
// QuickCommand 由目录键推导，新增命令只需扩表即可获得类型覆盖；手写联合类型会与目录漂移。
// 该类型把 offered 的入参收窄到目录内取值，防止把任意字符串当成命令拼进斜杠载荷。
type QuickCommand = keyof typeof QUICK_COMMANDS;

// 组件是展示加事件转发：不持有草稿文本，所有文本读写都经 inputApiRef，由此保证编辑器是唯一数据源。
// inputApiRef 允许为空（输入框未挂载），所有调用点都用可选链兜底；去掉兜底会在首帧抛错。
// container 为空表示尚未拿到承载容器，此时退回默认按钮锚点；该分支与 PopoverAnchor 的条件渲染一一对应。
export function ChatPromptActionMenu({
  actionMenuTitle,
  attachmentAction,
  disabled,
  disabledReason,
  inputApiRef,
  workspacePath,
  workspaceIdentity,
  sessionId,
  container,
  showPlugins,
  excludedSlashCommandNames,
}: {
  actionMenuTitle: string;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  disabled?: boolean;
  disabledReason?: string;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  container: HTMLElement | null;
  showPlugins: boolean;
  excludedSlashCommandNames?: readonly string[];
}) {
  // [事务] 三个 useState 共同描述一次菜单会话：open 是开关，quickCommands 是打开瞬间冻结的候选，selectedIndex 是高亮位置。
  // open 用组件内 state 而非受控 props，调用方无法外部关闭；若需外部关闭必须新增受控分支，不能直接复用 setOpen。
  // selectedIndex 初值 0 与「附件总在首位」的布局假设绑定；若未来把附件移出首位，需同步调整初值与跳过逻辑。
  // intl 来自上层 Provider，此处不做 locale 判断；文案 key 缺失属于构建期问题，运行期只做回退不做兜底文案。
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // [资源] 三个 ref 都不触发重渲染：selectionStateRef 存打开瞬间的编辑器状态，contentRef 指向面板根节点用于聚焦。
  // restoreEditorFocusRef 是「关闭后是否把焦点还给编辑器」的意图标记，只在插入成功路径上置真，附件路径不置真。
  // ref 初值必须为空而非空对象，否则 insertMention 会把无效状态当作有效选区处理。
  const selectionStateRef = useRef<EditorState | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreEditorFocusRef = useRef(false);
  // [并发] anchorRef 按 container 记忆，容器变化才重建；每次渲染新建对象会让 Radix 反复解绑重绑锚点。
  // 虚拟锚点只实现 getBoundingClientRect 并返回容器矩形；缺该方法时 Radix 会退回 trigger 尺寸并导致定位跳动。
  // container 为空时返回空 DOMRect，宽高为 0；这是可接受降级，因为此时根本不渲染 PopoverAnchor。
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => container?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [container],
  );
  // [资源] 四个 provider 的激活布尔完全一致，保证菜单关闭后不再发起目录拉取；任一参数变化都会重建请求。
  // 空态与标题文案在调用处即时取 intl，属于每次渲染新建对象，但 provider 只消费字符串，不引起额外请求。
  // provider 返回的 items 直接进入 mentionItems，顺序即渲染顺序；provider 内部排序变更会改变键盘下标语义。
  const plugins = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId,
    "",
    open && !disabled && showPlugins,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );
  const provider = useChatViewActiveTaskProvider(sessionId, workspacePath, workspaceIdentity);
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  // 文件 provider 额外传入预览上限 MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT，避免一次拉取全部工作区文件。
  // [失败路径] 文件查询失败时 provider 把错误放进 error，随后在 contextGroups 折算成 errorText，面板显示错误而非空列表。
  const files = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    "",
    open && !disabled && showPlugins,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  );
  // 会话 provider 依赖 activeTask provider 的实例，两者必须成对调用；拆开会让会话范围解析拿到未初始化的上下文。
  // 会话列表与文件列表同属 @ 上下文，但 scope 固定为 @，不复用斜杠或美元触发符路由，避免跨触发符串味。
  const sessions = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    "",
    open && !disabled && showPlugins,
    getSessionMentionWorkspaceScope("@"),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
  );
  // buildVisibleMentionGroups 负责过滤空分组与排序，此处只把 error 折算为 errorText；折算缺失会让失败分组静默消失。
  // 分组 id 决定分区 key 与标题，files 与 sessions 两个 id 与 provider 名称一一对应，改名会破坏面板折叠记忆。
  const contextGroups = buildVisibleMentionGroups(
    [
      { id: "files", ...files },
      { id: "sessions", ...sessions },
    ].map((group) => ({
      ...group,
      errorText: group.error?.message ?? null,
    })),
  );
  // [事务] mentionItems 是扁平化后的候选全集，plugins 在前、上下文组在后；该顺序同时决定 options 与 sections 的可见序列。
  // 扁平化只做一次，后续不再按分区重排；若在渲染期再排序，键盘下标会与视觉顺序脱节。
  const mentionItems = [...plugins.items, ...contextGroups.flatMap((group) => group.items)];
  const attachmentCount = attachmentAction ? 1 : 0;
  const options = [
    ...(attachmentAction ? [{ disabled: false }] : []),
    ...quickCommands.map(() => ({ disabled: false })),
    ...mentionItems,
  ];
  // sections 是面板的唯一结构来源：add 分区装附件与快捷命令，plugins 分区装插件，其余由 contextGroups 映射。
  // [权衡] 附件被建模为分区内的一项而非独立按钮，换取统一键盘导航；代价是 selectOption 需要按下标区分附件与命令。
  const sections: MentionPanelSection[] = [
    {
      id: "add",
      title: intl.formatMessage({ id: "chat.composer.addSection" }),
      emptyText: "",
      options: [
        ...(attachmentAction
          ? [
              {
                id: "attach-files",
                label: attachmentAction.label,
                description: "",
                content: (
                  <>
                    <PaperclipIcon className="size-4 shrink-0" />
                    <span
                      className="truncate text-ui-base font-medium"
                      data-testid={attachmentAction.menuItemTestId}
                    >
                      {attachmentAction.label}
                    </span>
                  </>
                ),
              },
            ]
          : []),
        ...quickCommands.map((command) => {
          const { id, labelId, Icon } = QUICK_COMMANDS[command];
          const label = intl.formatMessage({ id: labelId });
          return {
            id,
            label,
            description: "",
            content: (
              <>
                <Icon className="size-4 shrink-0" />
                <span className="truncate text-ui-base font-medium">{label}</span>
              </>
            ),
          };
        }),
      ],
    },
    {
      id: "plugins",
      title: plugins.title,
      emptyText: plugins.emptyText,
      loading: plugins.loading,
      loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
      errorText: plugins.error?.message,
      options: plugins.items.map((item) => ({
        ...item,
        label: item.displayLabel ?? item.label,
        content: <PluginMentionOptionContent item={item} />,
      })),
    },
    ...contextGroups.map((group) => ({
      id: group.id,
      title: group.title,
      emptyText: group.emptyText,
      loading: group.loading,
      loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
      errorText: group.errorText,
      options: group.items.map((item) => ({
        ...item,
        content: <ContextMentionOptionContent item={item} workspacePath={workspacePath} />,
      })),
    })),
  // 空的分区必须剔除，否则面板会渲染只有标题的空壳；filter 只对 add 生效，其余分区靠 emptyText 表达空态。
  // filter 在数组构建之后执行，属于一次额外遍历，但分区数是个位数，不构成性能问题。
  ].filter((section) => section.id !== "add" || section.options.length > 0);

  // selectOption 是唯一的提交入口：面板点击与键盘回车都汇到这里，保证两条路径的下标语义完全一致。
  // [事务] 先关闭弹层再执行插入，避免插入引发的编辑器更新与弹层卸载竞争；顺序颠倒会出现焦点被弹层收回。
  // 下标是相对扁平候选序列的位置，不是分区内位置；调用方传入的必须是 options 的下标。
  const selectOption = (index: number) => {
    // [失败路径] 越界与禁用项一律静默返回：越界来自快速连按或候选在异步刷新后收缩，抛错会打断键盘事件链。
    // 禁用判断读取 options 对应项，而 options 由附件占位、快捷命令占位与 mentionItems 拼成；前两者显式可用，提及项可用性由 provider 决定。
    // 这里不检查 open，因为 selectOption 只会在弹层内被触发；外部若直接调用需自行保证弹层已打开。
    if (disabled || !options[index] || options[index].disabled) return;
    setOpen(false);
    if (attachmentAction && index === 0) {
      attachmentAction.onSelect();
      return;
    }
    // 附件固定占据下标 0，只有当 attachmentAction 存在时才占位，attachmentCount 是 0 或 1 的补偿量。
    // [事务] 命令与提及项的下标都基于同一补偿量做减法，任何一处漏减都会把点击映射到相邻项，这是本文件最易回归的点。
    // quickCommands 与 options 中的占位数量必须相等，二者由同一个数组派生；若改为过滤式拼装，需保证占位数等于实际项数。
    const command = quickCommands[index - attachmentCount];
    const item = command
      ? buildSlashApplyMentionPayload({
          id: `slash:${command}`,
          trigger: "/",
          value: command,
          label: `/${command}`,
          description: "",
        })
      : mentionItems[index - attachmentCount - quickCommands.length];
    // [失败路径] 命令载荷构造与提及项查找都可能返回空值，此处直接返回表示无操作，不关闭已关闭的弹层也不报错。
    // 该分支同时兜住候选在打开后收缩导致的悬空下标，属于竞态下的静默兜底，不应改成抛错。
    if (!item) return;
    restoreEditorFocusRef.current = true;
    // [并发] 插入前先置 restoreEditorFocusRef，再调用 insertMention；顺序颠倒会在关闭回调里读到假值而丢失焦点恢复。
    // insertMention 接收打开瞬间的状态快照，用于在弹层夺焦后仍把节点插入原选区；传当前状态会插到错误位置。
    inputApiRef.current?.insertMention(item, selectionStateRef.current);
  };

  return (
    // Popover 的 open 由 open 与 !disabled 合取，禁用时保持关闭；该表达式是 INV-01 的唯一守卫点。
    // onOpenChange 承担「打开时准备候选」与「同步开关」两件事，所有候选计算都必须留在 nextOpen 为真的分支内。
    <Popover
      open={open && !disabled}
      // [事务] nextOpen 分支内的三次状态写入应视为一次原子切换：候选、快照、高亮位置同时生效，拆开会让首帧读到旧值。
      // 关闭方向只写 setOpen，不清理 quickCommands 与快照；保留旧值是下一次打开时对比与调试的依据，也避免关闭动画期间重建列表。
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          // 打开瞬间快照，菜单打开期间候选不平移，键盘选择不会错位。
          // /goal 仍是消息开头命令且是会话级目标：仅新会话空草稿提供，避免在消息中间插入后被忽略。
          // /workflow 同样只在消息开头展开，但不绑定会话状态：任意会话空草稿都提供；
          // 命令目录以 CLI catalog 为权威，catalog 缺 workflow（插件被禁用）时不提供，
          // 否则会把 CLI 不会展开的裸文本发给模型。
          // 空草稿判定读的是编辑器当前文本，而不是 React 状态；编辑器是唯一数据源，状态副本可能滞后一帧。
          // [权衡] 用严格空串比较做空判定，含空格的草稿不算空；这样避免用户在段落中间误插只在行首展开的命令。
          const emptyDraft = inputApiRef.current?.getText() === "";
          const offered = (command: QuickCommand, available: boolean) =>
            emptyDraft && available && !excludedSlashCommandNames?.includes(command);
          // 候选数组按 goal、workflow 的固定顺序展开，顺序影响下标但不影响语义；新增命令请追加在末尾以免改变既有下标。
          // [失败路径] offered 的三个条件任一不满足即剔除该命令；剔除后 options 的占位数量随 quickCommands 长度自动收缩。
          setQuickCommands([
            ...(offered("goal", sessionId === null) ? (["goal"] as const) : []),
            ...(offered(
              "workflow",
              slashCommands.some((entry) => normalizeSlashCommandValue(entry.name) === "workflow"),
            )
              ? (["workflow"] as const)
              : []),
          ]);
          // 快照取的是 getEditorState 的返回值，可能为空（编辑器未就绪），此时插入退化为使用当前选区。
          // 快照与 setSelectedIndex(0) 必须同段执行，保证「打开即高亮首项」与「插入落点」来自同一次打开动作。
          selectionStateRef.current = inputApiRef.current?.getEditorState();
          setSelectedIndex(0);
        }
        setOpen(nextOpen);
      }}
    >
      <ControlHintTooltip title={disabledReason ?? actionMenuTitle}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="gap-1 rounded-lg text-ui-base"
            onMouseDown={(event) => event.preventDefault()}
            aria-label={actionMenuTitle}
            data-testid={attachmentAction?.testId}
            disabled={disabled}
            title={disabledReason}
          >
            <PlusIcon className="size-4" />
            <span className="sr-only">{actionMenuTitle}</span>
          </Button>
        </PopoverTrigger>
      </ControlHintTooltip>
      {/* 默认按钮锚点在首次挂载时也会注册；自定义锚点必须随后注册，避免被即将卸载的旧按钮覆盖。 */}
      {container ? <PopoverAnchor virtualRef={anchorRef} /> : null}
      <PopoverContent
        ref={contentRef}
        align="start"
        side="top"
        sideOffset={0}
        // Radix 将虚拟锚点尺寸也写入 trigger-width；使用不存在的 anchor-width 会让虚拟列表塌缩。
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-1rem)] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none"
        tabIndex={-1}
        // [并发] 打开后自动聚焦被阻止，改由面板根节点接管焦点；这样键盘事件先落到面板，再冒泡到 onKeyDown。
        // 若允许默认聚焦，Radix 会聚焦首个可聚焦子元素（可能是按钮），方向键可能被按钮语义吞掉而无法切换候选。
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        // [资源] 关闭后只有在插入成功时才把焦点还给编辑器；附件路径不改焦点，因为附件选择器会自行接管。
        // 读取后立即复位 restoreEditorFocusRef，避免下一次无关关闭再次抢焦点；这一复位是幂等性的前提。
        onCloseAutoFocus={(event) => {
          if (restoreEditorFocusRef.current) {
            event.preventDefault();
            restoreEditorFocusRef.current = false;
            inputApiRef.current?.focus();
          }
        }}
        // [事务] 上下方向键在同一循环里处理，取模保证首尾环绕；步长从 1 递增到 options.length 以跳过连续禁用项。
        // 若整列都不可用，循环自然结束且不写入高亮，保持原选中项；这里刻意不做回落到首项，以免高亮跳动。
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            for (let step = 1; step <= options.length; step++) {
              const next = (selectedIndex + delta * step + options.length) % options.length;
              if (!options[next]?.disabled) {
                setSelectedIndex(next);
                break;
              }
            }
          // [失败路径] 回车、Tab、空格都视为确认：三者共享同一提交路径，避免空格在编辑器里落成字符。
          // 两个阻止调用缺一不可：阻止默认避免插入换行，阻止冒泡避免编辑器快捷键再把事件处理一遍。
          } else if (event.key === "Enter" || event.key === "Tab" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            selectOption(selectedIndex);
          }
        }}
      >
        <MentionPanel
          title={actionMenuTitle}
          description=""
          listMaxHeight="min(24rem, max(8rem, calc(var(--radix-popover-content-available-height, 32rem) - 6rem)))"
          footer={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-ui-sm text-foreground-subtle">
              {(
                [
                  ["@", "chat.composer.contextShortcut"],
                  ["/", "chat.composer.capabilityShortcut"],
                  ["$", "chat.composer.skillShortcut"],
                ] as const
              ).map(([trigger, id]) => (
                <div key={trigger} className="flex shrink-0 items-center gap-1.5">
                  <code className="flex size-5 shrink-0 items-center justify-center rounded bg-tooltip-tag font-mono text-foreground">
                    {trigger}
                  </code>
                  <span>{intl.formatMessage({ id })}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <Info className="size-4 shrink-0" />
                <span>{intl.formatMessage({ id: "chat.composer.contextSearchHint" })}</span>
              </div>
            </div>
          }
          // 底部快捷键提示是静态文案，不参与导航；触发符顺序与插入载荷的 trigger 取值必须保持一致，否则会误导用户。
          trigger="+"
          sections={sections}
          emptyText=""
          selectedIndex={selectedIndex}
          hasActiveQuery={false}
          onSelect={selectOption}
        />
      </PopoverContent>
    </Popover>
  );
}
