// 主视图布局模块：拼装侧边栏、会话区、输入区与各类候选/审批面板。
// 边界：所有状态与回调都经 props 传入，本组件只做展示与事件转发，不持有会话数据、不做 IO。
// 口径：子代理详情选中时进入只读模式（隐藏主会话、输入回调置空）；审批请求优先于选择面板与输入区。
// 失败语义：纯渲染无失败路径；缺失可选 props（如 queuedInputs）时按空值渲染。
// INV-01 侧边栏可见性与预留宽度同源：可见即按预留列宽排版，不可见即整宽渲染；守住位置：AppView 中 sidebar 计算与 actionPanelContentWidth 两处；改错故障：正文按含侧栏宽度排版但侧栏未渲染，每行尾部出现大片空白或被截断。
// INV-02 展示宽度只由终端宽度减侧栏预留得出，不缓存进状态；守住位置：actionPanelContentWidthForTerminal 调用点；改错故障：终端 resize 后沿用旧宽度，换行位置错乱、边框错位，长行被横向裁掉。
// INV-03 选择面板两处互斥：composer 归输入区、其余归主区，同一 selection 只能渲染一次；守住位置：composerSelection 与 actionSelection 的推导；改错故障：同一次按键被两个面板各消费一遍，选中项跳两格或执行错误命令。
// INV-04 审批队列非空时只渲染队首，且不再渲染选择面板与输入区；守住位置：主区三元分支的首个条件；改错故障：审批被输入框遮挡，用户回车把草稿提交也给待批请求，造成误批准。
// INV-05 只读模式由子代理选中态单向推导，不接受外部覆写；守住位置：readOnly 计算处；改错故障：详情页仍可输入，回车把文本提交进主会话，用户看到内容写进了看不见的会话。
// INV-06 只读模式下提交与写入回调被替换为空函数，而不是取消绑定；守住位置：ComposerInputArea 入参处的 setDraftValue 与 submitValue；改错故障：编辑器内部残留旧回调，退格或回车仍改到主会话草稿。
// INV-07 只读模式隐藏主会话容器但组件仍挂在树上；守住位置：main-conversation-view 的 visible 属性；改错故障：若改成条件不渲染，返回时会重建编辑器，草稿与光标位置一起丢失。
// INV-08 鼠标抬起先复制选区、再恢复输入焦点；守住位置：handleShellMouseUp；改错故障：顺序颠倒时焦点切换清掉选区，复制得到空串。
// INV-09 焦点恢复只在非只读时执行；守住位置：handleShellMouseUp 内的条件分支；改错故障：只读详情页抢走焦点，快捷键落到隐藏的输入框上，按键全部失效。
// INV-10 记忆化依赖必须覆盖 readOnly 与全部回调；守住位置：handleShellMouseUp 的依赖数组；改错故障：闭包捕获过期 readOnly，退出只读后焦点不再回到输入框。
// INV-11 流式文本以追加方式合成最后一条 agent 消息，不改写 messages 数组；守住位置：transcriptMessages 计算；改错故障：直接改动入参数组会让上层状态与渲染不同源，重放历史时出现重复消息。
// INV-12 流式合成只在 liveModelText 非空时发生，空串不得产生空消息；守住位置：transcriptMessages 的三元分支；改错故障：每帧多出一条空 agent 气泡，列表抖动并让消息计数虚增。
// INV-13 队列输入缺省为空数组，不区分未传与传空；守住位置：queuedInputs 兜底处；改错故障：旧调用点不传该 prop 时面板拿到 undefined 崩溃，或焦点被空面板劫持。
// INV-14 MCP 状态订阅在登录态缺失时传 undefined 以停订；守住位置：useMcpSidebarStatus 入参；改错故障：未登录仍轮询，持续打空请求，侧栏长期显示离线提示。
// INV-15 登录提示优先于文件提及与选择面板出现；守住位置：ComposerInputArea 的渲染顺序；改错故障：未登录时仍显示命令候选，用户选中后无响应，误判为界面卡死。
// INV-16 覆盖层顺序固定为登录、文件提及、通用选择、各命令候选、队列、输入框、状态行；守住位置：ComposerInputArea 返回的 Fragment；改错故障：候选被队列面板压住，用户看不到当前选中项。
// INV-17 输入框始终位于最后且常驻，焦点默认开启，仅只读时关闭；守住位置：InputPane 的 focused 入参；改错故障：浮层出现时输入框被卸载，输入法组合串丢失、草稿回滚到旧值。
// INV-18 长列表裁剪交给下层组件，本文件只透传全量数据与宽度；守住位置：ContentPane 与各面板的入参；改错故障：在此处提前切片会让滚动窗口与真实长度不一致，滚到底后看不到最新消息。
import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import React from "react";
import { ApprovalPanel } from "./app-approval-panel.js";
import {
  actionPanelContentWidthForTerminal,
  AppShell,
  LoginRequiredPanel,
  SlashSuggestionPanel,
} from "./app-components.js";
import { SelectionPanel } from "./app-selection-panel.js";
import { ContentPane } from "./app-transcript-components.js";
import { FileMentionPanel } from "./app-file-mention-panel.js";
import type { FileMentionState } from "./app-file-mentions.js";
import { EffortSuggestionPanel } from "./app-effort-suggestion-panel.js";
import { InputPane, type PromptInputEditor } from "./app-input-pane.js";
import { InputActiveStatus } from "./app-input-status.js";
import { QueuedInputPanel } from "./app-queued-inputs.js";
import { ModeSuggestionPanel } from "./app-mode-suggestion-panel.js";
import { ModelSuggestionPanel } from "./app-model-suggestion-panel.js";
import { useMcpSidebarStatus } from "./app-mcp-status.js";
import { Sidebar } from "./app-sidebar.js";
import {
  type SidebarLayout,
  type SidebarSectionId,
  type SidebarSectionExpansion,
} from "./app-sidebar-layout.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  EffortCommandSelectionState,
  Message,
  ModifiedFileStat,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiOptions } from "./types.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";
import { SubagentView } from "./app-subagent-view.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// TUI 主视图：负责布局拼装（侧边栏 + 会话区 + 输入区 + 各类候选/审批面板）。
// props 承载所有 UI 状态与回调；本组件只做展示与事件转发，不持有会话数据。
// readOnly 由子代理详情选中态推导：为 true 时隐藏主会话并禁用输入，但保留侧边栏。
// approvalQueue 非空时优先展示审批面板；否则按 selection 展示选择面板或输入区。
// 纯渲染，无 IO/持久化；所有副作用都通过 props 回调交还调用方。
export function AppView(props: {
  subagents?: SubagentsController;
  toggleSidebar?: () => boolean;
  activeTurnId?: TurnId;
  approvalQueue: ApprovalPrompt[];
  busy: boolean;
  cacheStats?: CacheStats;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  copyCurrentSelection: () => boolean;
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  lastError?: string;
  lastEvent: string;
  loginRequired: boolean;
  liveModelText: string;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modifiedFiles: ModifiedFileStat[];
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  messages: Message[];
  networkRequests: NetworkRequest[];
  options: TuiOptions;
  queuedInputs?: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  sidebarLayout: SidebarLayout;
  sidebarSections: SidebarSectionExpansion;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  status: string;
  statusDetails: string[];
  submitValue: (value: string) => void;
  thoughtLevel: string;
  todos: TodoItem[];
  toggleSidebarSection?: (section: SidebarSectionId) => boolean;
  traceId?: string;
  terminalWidth: number;
  usage?: ModelUsageSummary;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
  expandedWorkflowRunIds?: ReadonlySet<string>;
}): React.ReactElement {
  // 子代理详情打开时进入只读模式：主会话隐藏，输入与提交回调替换为空操作。
  const readOnly = Boolean(props.subagents?.selected);
  // [并发] 鼠标抬起是整壳唯一的事件汇聚点：复制选区与恢复焦点必须在同一次同步回调内完成，
  // 中间不等待任何异步任务，否则紧接着的按下事件会把刚选中的文本清掉。
  // 复制返回值被丢弃是有意的：无选区时复制失败属于常态，此处弹提示反而打断输入。
  // 焦点恢复排在复制之后，因为编辑器获得焦点会重置选区，先聚焦就只能复制到光标位置。
  // [失败路径] 只读态下 editorRef 仍指向旧编辑器实例，跳过聚焦可避免把按键送进隐藏的输入框。
  // 依赖数组刻意带上 readOnly：漏掉它会让闭包永久记住进入只读前的值，退出详情后焦点不回来。
  // copyCurrentSelection 返回布尔表示是否真的写入剪贴板，这里不消费该值：提示由状态行统一负责，
  // 视图层再补一条会连闪两次。同理若把这段逻辑下放到壳组件，只读判断就得写两遍并迟早漂移。
  const handleShellMouseUp = React.useCallback(() => {
    props.copyCurrentSelection();
    if (!readOnly) props.editorRef.current?.focus();
  }, [props.copyCurrentSelection, props.editorRef, readOnly]);
  // 宽度每帧重算而不是存进组件状态：终端 resize 只有到下一次渲染才能反映，
  // 缓存值一旦与实际终端列数不同步，就会把内容排到侧栏底下。
  // 计算基准是终端宽度减去侧栏预留，而不是当前剩余可用宽度：
  // 侧栏可见性与预留宽度必须来自同一份布局快照，否则浮层展开的瞬间内容会比容器宽一列，边框换行。
  // 该值同时喂给会话区、审批面板、选择面板与各候选面板，保证同一屏内所有块级区域同宽。
  // 若各处自己算宽度，候选项与正文的对齐会差出侧栏宽度，看起来像两套布局拼在一起。
  // [权衡] 向下层传 terminalWidth 与 reservedWidth、由下层单点做扣减，避免宽度被扣两次而逐层收窄。
  // 该值刻意不参与记忆化：宽度变化必须穿透到每一层，缓存命中会让 resize 后仍按旧列数换行。
  const actionPanelContentWidth = actionPanelContentWidthForTerminal(
    props.terminalWidth,
    props.sidebarLayout.reservedWidth,
  );
  // [资源] 该 hook 内部持有订阅与周期性请求，只允许在组件挂载期间存在；
  // 登录态缺失时传 undefined 是让它停订的唯一入口，传空回调会让它继续按旧地址轮询。
  // [失败路径] 登出后未停订的后果是后台请求持续返回未授权，错误态覆盖状态行，用户以为是网络故障。
  // 订阅随 loginRequired 变化重建，因此这里不能给入参加记忆化，否则切换登录态后仍连着旧会话。
  // [权衡] 把停订判定放在视图层而非 hook 内部，是为了让 hook 保持无状态、可在测试里直接驱动。
  // 状态本身只读：视图层不改写返回值，侧栏每次拿到的都是同一份快照。
  const mcpStatus = useMcpSidebarStatus(
    props.loginRequired ? undefined : props.options.listMcpServers,
  );
  // 流式模型文本单独拼到最后一条 agent 消息，避免每帧都改写已落库的消息数组。
  // 流式文本不写回 messages：messages 是上层持有的已落库历史，
  // 视图层追写会让已确认与正在生成两种状态混进同一个数组，回滚时无法区分。
  // 每次渲染都新建数组、引用恒变，因此下游不能靠引用相等跳过重渲染；
  // [权衡] 接受 transcriptMessages 的重算，而换来流式结束时不需要额外一次状态同步，避免最后一帧丢字。
  // 合成的消息不带 id 与时间戳：它只是展示用的尾巴，带上 id 会让列表对比把它当成新历史。
  // streaming 标记交给下层决定样式（光标、淡化），而本文件不判断内容是否为空。
  // [失败路径] liveModelText 为空串时走 props.messages 的原引用，避免空消息插入造成高度跳动。
  // 消息计数取 transcriptMessages.length，侧栏与滚动锚点因此与用户实际看到的气泡数一致。
  const transcriptMessages = props.liveModelText
    ? [
        ...props.messages,
        {
          content: props.liveModelText,
          role: "agent" as const,
          streaming: true,
        },
      ]
    : props.messages;

  // 旧的测试入口和嵌入式调用不会传 queuedInputs；默认空队列，避免队列面板在无数据时打断焦点交互。
  const queuedInputs = props.queuedInputs ?? [];
  // 选择状态按 placement 分流：输入框内联选择与主区选择互斥，只渲染其中一处。
  // placement 只有两个取值，这里用是否等于 composer 来判断，而不是对主区取反：
  // 未知取值会落进主区分支，宁可面板出现在正文区，也不要两处同时显示。
  // 互斥的直接收益是按键消费唯一：候选项上下移动只被一个面板处理，不会一次跳两行。
  // [失败路径] 两处渲染同一个 selection 时，回车会触发两次确认，第二次落在已关闭的面板上变成空操作，
  // 用户看到的是第一次没反应、第二次才生效，onSubmit 双触发会让它很难复现。
  // actionSelection 由 composerSelection 的反向结果推导，保证两者不会同时有值。
  // actionSelection 的推导不写任何状态，纯函数性质让测试快照与服务端渲染都可重复。
  const composerSelection = props.selection?.placement === "composer" ? props.selection : undefined;
  const actionSelection = props.selection && !composerSelection ? props.selection : undefined;
  // 浮层模式下打开子代理详情会收起侧边栏，给只读详情内容腾出整宽。
  // 侧栏是否渲染只看 sidebarLayout.visible，不重复判断终端宽度：宽度不足时由布局层决定切浮层，
  // 视图层再判一次就会出现布局以为可见、视图没渲染的宽度错配。
  // 打开子代理详情且处于浮层模式时要顺手收起侧栏，否则详情页被浮层压在左边，只剩半屏宽度。
  // [失败路径] 收起动作失败（回调未提供）不阻断打开详情：详情照常渲染，只是侧栏继续占位。
  // 侧栏入参里的 messageCount 用合成后的长度，保证侧栏与正文对消息条数的口径一致。
  // Sidebar 的入参都是透传，侧栏不持有副本，而本文件卸载时无需清理任何订阅。
  // [权衡] 先把侧栏建成变量再交给壳组件，而不是内联在返回结构里，是为了让可见性判断紧挨宽度计算，
  // 后续改 actionPanelContentWidth 时不容易漏掉这一支。
  const sidebar = props.sidebarLayout.visible
    ? h(Sidebar, {
        subagents: props.subagents,
        onOpenSubagent: (item: SubagentItem) => {
          props.subagents?.open(item);
          if (props.sidebarLayout.overlay) props.toggleSidebar?.();
        },
        activeTurnId: props.activeTurnId,
        busy: props.busy,
        cacheStats: props.cacheStats,
        contextUsage: props.contextUsage,
        draft: props.draft,
        lastError: props.lastError,
        lastEvent: props.lastEvent,
        messageCount: transcriptMessages.length,
        mcpStatus,
        mode: props.mode,
        model: props.model,
        modifiedFiles: props.modifiedFiles,
        networkRequests: props.networkRequests,
        onToggleSection: props.toggleSidebarSection,
        sectionExpansion: props.sidebarSections,
        status: props.status,
        statusDetails: props.statusDetails,
        thoughtLevel: props.thoughtLevel,
        todos: props.todos,
        traceId: props.traceId,
        usage: props.usage,
        developerMode: props.options.developerMode,
        version: props.options.version,
        workspaceDirectory: props.options.workspaceDirectory,
        workspaceGitBranch: props.options.workspaceGitBranch,
        copy: props.copy,
      })
    : null;

  return h(
    AppShell,
    { onMouseUp: handleShellMouseUp, sidebar, sidebarLayout: props.sidebarLayout },
    readOnly && props.subagents
      ? h(SubagentView, {
          controller: props.subagents,
          copy: props.copy,
          contentWidth: actionPanelContentWidth,
          pendingMain: props.approvalQueue.length > 0 || Boolean(props.selection),
        })
      : null,
    h(
      "box",
      {
        id: "main-conversation-view",
        visible: !readOnly,
        style: { flexDirection: "column", flexGrow: 1, minHeight: 0 },
      },
      h(ContentPane, {
        id: "main-transcript",
        animateEmptyLogo: !props.options.noColor,
        copy: props.copy,
        focused: false,
        messages: transcriptMessages,
        terminalWidth: actionPanelContentWidth,
        workflowCardsByToolCallId: props.workflowCardsByToolCallId,
        expandedWorkflowRunIds: props.expandedWorkflowRunIds,
      }),
      // 审批优先级最高：存在待批请求时暂时收起选择面板/输入区，防止焦点被抢走。
      // 审批优先于一切：只要队首存在，选择面板与输入区都不渲染，键盘焦点只能落在审批按钮上。
      // 只渲染队首而不是整队，是因为审批需要独占确认；同屏多个待批会让回车语义变得不确定。
      // [失败路径] 队首处理完由上层出队，本文件不做本地已处理标记；
      // 若在此处标记，上层重渲染时同一请求会再出现一次，用户可能重复批准。
      // 审批面板出现时输入区被卸载，草稿留在上层 props.draft 里，不会随卸载丢失。
      // 这也是草稿必须受控的原因：非受控输入框随面板卸载会把已输入内容一起丢掉。
      // busy 在审批态下仍透传，用于禁用重复提交，而不是用来隐藏面板。
      // [权衡] 用三元链而非提前返回，保持返回结构单一，避免两条分支各自维护一份壳组件入参。
      props.approvalQueue[0]
        ? h(ApprovalPanel, {
            approval: props.approvalQueue[0],
            contentWidth: actionPanelContentWidth,
          })
        : actionSelection
          ? h(SelectionPanel, {
              contentWidth: actionPanelContentWidth,
              copy: props.copy,
              selection: actionSelection,
            })
          : h(ComposerInputArea, {
              focused: !readOnly,
              busy: props.busy,
              contentWidth: actionPanelContentWidth,
              contextUsage: props.contextUsage,
              copy: props.copy,
              draft: props.draft,
              editorRef: props.editorRef,
              effortOptions: props.effortOptions,
              effortSelection: props.effortSelection,
              fileMention: props.fileMention,
              inputCursorToEndVersion: props.inputCursorToEndVersion,
              loginRequired: props.loginRequired,
              mode: props.mode,
              modeOptions: props.modeOptions,
              modeSelection: props.modeSelection,
              model: props.model,
              modelOptions: props.modelOptions,
              modelSelection: props.modelSelection,
              queuedInputs,
              selection: composerSelection,
              setDraftValue: readOnly ? () => {} : props.setDraftValue,
              slashCommands: props.slashCommands,
              slashSelection: props.slashSelection,
              submitValue: readOnly ? () => {} : props.submitValue,
              thoughtLevel: props.thoughtLevel,
            }),
    ),
  );
}

// 输入区组合件：按状态叠加登录提示、文件提及、选择面板与队列面板，最后固定输入框与状态行。
// 覆盖层顺序决定视觉优先级（登录 → 文件提及 → 通用选择 → 各命令候选 → 队列）；输入框始终在最下方。
// contentWidth 由调用方按终端宽度减去侧边栏预留列宽算出，避免内容被侧栏遮挡。
export function ComposerInputArea(props: {
  focused?: boolean;
  busy: boolean;
  contentWidth: number;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  loginRequired: boolean;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  queuedInputs: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  submitValue: (value: string) => void;
  thoughtLevel: string;
}): React.ReactElement {
  return h(
    React.Fragment,
    null,
    props.loginRequired ? h(LoginRequiredPanel, { copy: props.copy }) : null,
    props.fileMention
      ? h(FileMentionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          state: props.fileMention,
        })
      : null,
    props.selection
      ? h(SelectionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          selection: props.selection,
        })
      : null,
    props.modelSelection
      ? h(ModelSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentModel: props.model,
          models: props.modelOptions,
          selectedIndex: props.modelSelection.selectedIndex,
        })
      : null,
    props.effortSelection
      ? h(EffortSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentEffort: props.thoughtLevel,
          efforts: props.effortOptions,
          selectedIndex: props.effortSelection.selectedIndex,
        })
      : null,
    props.modeSelection
      ? h(ModeSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentMode: props.mode,
          modes: props.modeOptions,
          selectedIndex: props.modeSelection.selectedIndex,
        })
      : null,
    props.slashSelection
      ? h(SlashSuggestionPanel, {
          contentWidth: props.contentWidth,
          commands: props.slashCommands,
          copy: props.copy,
          selectedIndex: props.slashSelection.selectedIndex,
        })
      : null,
    // 队列面板常驻挂载，空队列时由它自己渲染空内容：条件挂载会让面板高度在入队瞬间跳变，
    // InputPane 随之上移，正好打断用户正在敲的那一行。
    // QueuedInputPanel 排在所有候选面板之后、输入框之前：队列是已确定的后续输入，而视觉上要贴着输入框。
    // [失败路径] 若把队列面板放到候选之前，模型或模式候选会被压到下方并裁掉，用户看不到选中项。
    // 队列内容只读展示，本文件不提供删除或重排回调，改队列必须回到上层状态里做。
    // contentWidth 与其它面板同源，保证队列条目换行位置与正文一致，不出现半宽条目。
    // [权衡] 不在这里按条数裁剪：裁剪阈值由 QueuedInputPanel 内部决定，才能在窗口变化时重新计算。
    // 面板拿到的 inputs 是已兜底的空数组，因此它无需再判断 undefined。
    h(QueuedInputPanel, {
      contentWidth: props.contentWidth,
      copy: props.copy,
      inputs: props.queuedInputs,
    }),
    h(InputPane, {
      busy: props.busy,
      contentWidth: props.contentWidth,
      copy: props.copy,
      editorRef: props.editorRef,
      focused: props.focused ?? true,
      mode: props.mode,
      model: props.model,
      onInput: props.setDraftValue,
      onSubmit: props.submitValue,
      resetCursorToEndVersion: props.inputCursorToEndVersion,
      thoughtLevel: props.thoughtLevel,
      value: props.draft,
    }),
    // 状态行永远最后渲染且占位高度固定：放在输入框之前会让忙碌提示把输入框往下推，光标位置跳动。
    // active 直接取 busy，不额外维护一份正在加载标志：两份状态迟早有一方先变，出现转圈但可输入的矛盾态。
    // contextUsage 与输入区其它位置共用同一份快照，避免状态行显示的占用率与提示条不一致。
    // [失败路径] 忙碌态与错误态互斥由上层保证；状态行不自行判断错误，否则错误文案会被忙碌提示盖住。
    // 快捷键提示文案由 InputActiveStatus 内部决定，而本文件不参与优先级排序，按键分发统一在 InputPane 里完成。
    // [权衡] 不把登录提示并进状态行：登录是阻塞态，需要独立高度与醒目样式，混排会削弱提示。
    // InputActiveStatus 没有交互回调，纯展示组件不引入任何订阅或清理逻辑。
    h(InputActiveStatus, {
      active: props.busy,
      contentWidth: props.contentWidth,
      contextUsage: props.contextUsage,
      copy: props.copy,
    }),
  );
}
