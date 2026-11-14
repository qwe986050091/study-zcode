/* oxlint-disable eslint(max-lines) -- 输入壳同时收口 Lexical 同步、拖拽和工具栏插槽，暂不拆组件。 */
// 输入展示壳：纯 props 组件、无 store/协议依赖；mention 面板通过 enableMentionPanel 透传。
// 输入展示壳：本文件把 LexicalChatInput、动作菜单、拖拽落点与工具栏插槽拼成一个统一输入框。
// 不负责：不做提交后状态收敛、不拥有草稿持久化、不直接调服务；onSubmit 的返回值决定编辑器是否 reset。
// 边界：纯 props 组件，workspace/task/i18n/拖拽开关/布局全部由调用方注入，组件内只持有 ref 与一次性同步标记。
//
// INV-01 断言：初值同步只允许执行一次 —— 守住它的位置：hasSyncedInitialValueRef 与 useEffect 的提前 return —— 改错故障：task 草稿恢复后父级每次重渲染都会把用户正在编辑的文本重置回 initialValue。
// INV-02 断言：initialValue 同步必须延后到下一帧执行 —— 守住它的位置：runAfterFrame 包裹的 setText —— 改错故障：挂载期 Lexical editor 尚未就绪，setText 落在空实例上，草稿恢复静默丢失。
// INV-03 断言：程序化写入前必须先比对编辑器现有 markdown —— 守住它的位置：getMarkdown() === initialValue 的提前 return —— 改错故障：用户每敲一个字符父级就回传 onChange，同步逻辑把内容整体重写，光标与输入法组合态被打断。
// INV-04 断言：handleSubmit 必须自己 preventDefault —— 守住它的位置：handleSubmit 第一行 —— 改错故障：表单原生提交触发页面跳转或刷新，消息没发出且草稿丢失。
// INV-05 断言：提交值优先取编辑器实时 markdown，ref 为空才回退 latestTextRef —— 守住它的位置：handleSubmit 的取值表达式 —— 改错故障：编辑器已卸载或 ref 未挂载时提交空串，用户消息丢失。
// INV-06 断言：handleEditorSubmit 必须原样透传 onSubmit 的返回值 —— 守住它的位置：handleEditorSubmit 的箭头函数体 —— 改错故障：业务层用 false 表示拒绝提交并保留草稿，吞掉返回值后 Enter 路径每次都清空输入。
// INV-07 断言：Esc 取消要跳过已被 Dialog 消费的事件 —— 守住它的位置：handleKeyDown 里的 defaultPrevented 与 closest 判断 —— 改错故障：在弹窗里按 Esc 关弹窗，同时把背后的消息编辑态也取消，用户编辑内容消失。
// INV-08 断言：submitting 期间 Esc 不得触发 onCancel —— 守住它的位置：handleKeyDown 的提前 return 条件 —— 改错故障：提交中的请求被误取消后，UI 与运行时状态不一致。
// INV-09 断言：dragover 阶段只能用 types 判断 workspace 文件拖拽 —— 守住它的位置：hasWorkspaceFileDragPayload 分支 —— 改错故障：浏览器在该阶段不暴露 getData 内容，判断恒失败，可投放高亮不亮，用户以为不能拖。
// INV-10 断言：workspace 文件拖入必须转成 @ mention 而不是附件 —— 守住它的位置：handleDrop 的 workspaceFilePayload 分支 —— 改错故障：contenteditable 里插入纯文本路径，后端收到无法解析的文件参数。
// INV-11 断言：workspace 拖拽分支必须 stopPropagation —— 守住它的位置：handleDrop 消费 payload 之后 —— 改错故障：用户消息编辑器嵌在 ChatView drop target 内，同一次拖拽被底部主输入框再收一遍，出现重复 mention。
// INV-12 断言：handleDragLeave 只在真正离开组件子树时清状态 —— 守住它的位置：relatedTarget 是否仍被 currentTarget 包含 —— 改错故障：鼠标在子元素之间移动就清掉拖拽态，高亮持续闪烁。
// INV-13 断言：两种布局共用同一棵 DOM 树，切换时编辑器不得重新挂载 —— 守住它的位置：isInline 只影响 className 与插槽顺序 —— 改错故障：布局切换重建 Lexical，输入焦点、输入法状态与撤销历史全部丢失。
// INV-14 断言：动作菜单在不同布局下挂载位置不同，但编辑器节点位置不变 —— 守住它的位置：actionMenuNode 在 isInline 分支的摆放 —— 改错故障：把菜单挪进 editorNode 内部会连带编辑器重挂载，切布局时草稿闪烁。
// INV-15 断言：triggerPanelContainer 由外部提供时不再渲染内部占位 div —— 守住它的位置：return 顶部的三元分支 —— 改错故障：两个容器同时存在，mention 与斜杠面板定位错乱或重复渲染。
// INV-16 断言：输入 API ref 由外部传入时优先使用外部 ref —— 守住它的位置：resolvedInputApiRef 的取或表达式 —— 改错故障：调用方拿到的 ref 永远为空，外部聚焦与取值全部失效。
// INV-17 断言：拖拽遮罩只做展示，不得拦截指针事件 —— 守住它的位置：遮罩 div 的 pointer-events-none —— 改错故障：遮罩盖住输入框后 drop 事件被吃掉，拖放彻底不可用。
// INV-18 断言：提交按钮的 disabled 只由 submitDisabled 决定，不叠加 submitting —— 守住它的位置：Button 的 disabled 与 Spinner 分支 —— 改错故障：提交中按钮退出可达性树，读屏用户无法感知进行中状态。
import type {
  KeyboardEventHandler,
  DragEventHandler,
  FormEventHandler,
  MutableRefObject,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TID_CHAT_SEND_BUTTON } from "@zcode/shared/test-ids";
import { ArrowUpIcon, Hand, XIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import {
  LexicalChatInput,
  type ChatComposerPasteEvent,
  type LexicalChatInputHandle,
} from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import {
  hasWorkspaceFileDragPayload,
  readWorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";

// [权衡] 初值同步依赖 rAF 把写编辑器推迟到布局之后，让 Lexical 先完成挂载与选区初始化
// 回调不返回句柄也不支持取消，卸载后仍可能执行一次，因此回调内只能通过可选链访问 ref
// 没有 rAF 的环境（单测、探针）直接同步调用，保证行为一致而不是静默跳过
// 此处不要再叠加防抖或超时，否则 task 草稿恢复会被可见地推迟一帧以上
function runAfterFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

// [契约] 本组件是展示壳：业务状态由调用方持有，组件内只有 ref 与一次性同步标记
// props 刻意保持扁平，新增字段必须能透传到 LexicalChatInput 或工具栏，不要在这里另存副本
// onSubmit 返回 false 是业务层的拒绝提交信号，本组件不解释它，只做透传
// 布局、拖拽开关、插槽内容全部走 props，禁止在组件内读 store，否则无法在消息编辑与主输入框之间复用
export function ChatPromptEditor({
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  initialValue,
  syncInitialValueOnMount = true,
  placeholder,
  disabled = false,
  disabledReason,
  submitting = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  submitLabel,
  cancelLabel,
  showMentionButton = false,
  showSlashButton = false,
  enableWorkspaceFileDrop = false,
  enableExternalFileDrop = false,
  isDraggingOver = false,
  dragAttachmentHint,
  topContent,
  inputLeadingContent,
  leadingActions,
  attachmentAction,
  betweenCancelAndSubmitAction,
  submitControl,
  inputTestId,
  submitTestId,
  cancelTestId,
  inputApiRef,
  onModeSwitchContainerChange,
  triggerPanelContainer,
  promptHistory,
  className,
  shellClassName,
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  layout = "stacked",
  onChange,
  onSubmit,
  onModifiedSubmit,
  onCancel,
  onFocus,
  onWhiteboardMentionSelected,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅供 Composer Skill catalog；可为草稿的 prewarm Session。 */
  skillCatalogSessionId?: string | null;
  initialValue?: string;
  syncInitialValueOnMount?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  showMentionButton?: boolean;
  showSlashButton?: boolean;
  enableWorkspaceFileDrop?: boolean;
  enableExternalFileDrop?: boolean;
  isDraggingOver?: boolean;
  dragAttachmentHint?: string;
  topContent?: ReactNode;
  /** 与输入正文同一行的前置内容；Highspeed 使用紧凑 Fast 标签。 */
  inputLeadingContent?: ReactNode;
  leadingActions?: ReactNode;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  /** 行内编辑专用：固定插在取消与主提交之间的第二动作。 */
  betweenCancelAndSubmitAction?: ReactNode;
  submitControl?: ReactNode;
  inputTestId?: string;
  submitTestId?: string;
  cancelTestId?: string;
  inputApiRef?: MutableRefObject<LexicalChatInputHandle | null>;
  onModeSwitchContainerChange?: (container: HTMLSpanElement | null) => void;
  triggerPanelContainer?: HTMLElement | null;
  promptHistory?: readonly string[];
  className?: string;
  shellClassName?: string;
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  /**
   * stacked：输入区在上、工具栏在下；inline：[+] 输入区 [控件][发送] 排成一行，控件只显示图标
   * （Side Pane 完整视图浮窗，docs/ui/side-pane-full-view.md）。两种布局共用同一棵 DOM 树，
   * 切换时编辑器不重新挂载。
   */
  layout?: "stacked" | "inline";
  onChange?: (value: string) => void;
  // 适配：返回 false 表示业务层拒绝/延迟本次提交，Lexical 不自行 reset（草稿保留）。
  onSubmit: (value: string) => boolean | void;
  onModifiedSubmit?: (value: string) => boolean | void;
  onCancel?: () => void;
  onFocus?: () => void;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（透传 LexicalChatInput）。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention 面板开关（透传 LexicalChatInput）。 */
  enableMentionPanel?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // [契约] inline 与 stacked 只改样式和子节点顺序，不换根节点类型，切换时 Lexical 实例必须存活
  // isInline 只用于 className 与条件插槽，不要把它升级成两套 return 分支
  // 一旦拆成两个 return，React 会按位置重建子树，编辑器重挂载导致焦点、输入法与撤销历史丢失
  // 新增布局时改这一个布尔与少量类名即可，不要复制整棵 JSX
  const isInline = layout === "inline";
  // [权衡] 工具栏宽度测量封装在 hook 内，本组件只负责把 ref 挂到真实 DOM 上
  // iconOnly 跟随布局变化，切换时 hook 自行重测，不要在这里额外加 useLayoutEffect 抢跑
  // ref 必须挂在包裹工具栏的容器而非按钮上，否则测量结果缺少间距与换行信息
  // [失败路径] 测量失败时 hook 只降级为不压缩，不要把测量结果回写进 props
  const toolbarRef = useComposerToolbarFit({ iconOnly: isInline });
  const internalInputApiRef = useRef<LexicalChatInputHandle | null>(null);
  // [契约] 外部传入 ref 时本组件不再持有编辑器句柄，全部读写都走 resolvedInputApiRef
  // 不要在内部另存一份并双写，两个句柄在重挂载后会指向不同实例
  // 父组件提交、聚焦、清空都依赖这条链路，任何绕过它的直接 DOM 操作都会让两侧状态分叉
  // 内部 ref 只在未传参时兜底，不要对外暴露
  const resolvedInputApiRef = inputApiRef ?? internalInputApiRef;
  const [internalTriggerPanelContainer, setInternalTriggerPanelContainer] =
    useState<HTMLDivElement | null>(null);
  const resolvedTriggerPanelContainer = triggerPanelContainer ?? internalTriggerPanelContainer;
  // [契约] latestTextRef 是编辑器文本的影子副本，用于 ref 尚未挂载时取值
  // 只在 onChange 与初值同步处写入，不要在其他分支顺手更新，否则会覆盖真实输入
  // 它是兜底而非事实来源：有编辑器实例时必须优先 getMarkdown，避免副本滞后
  // 初值用空值合并而非逻辑或，空串是合法初始值，不能被当成缺省值替换
  const latestTextRef = useRef(initialValue ?? "");
  const hasSyncedInitialValueRef = useRef(false);
  const {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  } = usePromptEditorDragState({
    enableExternalFileDrop,
    enableWorkspaceFileDrop,
  });
  const actionMenuTitle = intl.formatMessage({
    id: "chat.composer.actionMenu",
  });
  const workspaceFileDragHint = intl.formatMessage({
    id: "chat.composer.workspaceFileDragHint",
  });
  // [契约] 三个开关任一为真就渲染动作菜单，菜单内部再按各自开关决定子项
  // 不要把 enableMentionPanel 算进来：该字段只控制面板是否可用，不等于显示按钮
  // 全部关闭时必须完全不渲染外层 span，否则留下空的 flex 占位把工具栏挤歪
  // [权衡] 该值只影响渲染，不要用它推导提交可用性
  const hasActionMenu = Boolean(attachmentAction) || showMentionButton || showSlashButton;

  // [契约] 初值同步是一次性副作用：只在挂载后把外部草稿灌进 Lexical，不参与后续输入
  // 依赖里保留 initialValue 是必须的：父级可能在挂载后才拿到草稿
  // 真正的幂等由 hasSyncedInitialValueRef 保证，不要指望依赖数组去挡重复执行
  // [失败路径] 若这里抛错，编辑器会停在空态且不再重试，因此写编辑器前必须做空判
  useEffect(() => {
    // [契约] 该开关为 false 表示调用方自己掌控初始化时机，例如行内编辑复用已挂载的编辑器
    // 此时既不写 latestTextRef 也不置已同步标记，后续手动 setText 仍然可用
    // 不要在这里清空编辑器：关闭同步只代表不动，不代表重置
    // [失败路径] 把它误读成每次重挂载都同步，会让受控输入与 Lexical 互相抢内容
    if (!syncInitialValueOnMount) {
      return;
    }
    if (initialValue === undefined) {
      return;
    }
    if (hasSyncedInitialValueRef.current) {
      return;
    }
    // [并发] 标记与赋值必须在同一同步段内完成，不能挪到 rAF 回调里再置标记
    // 否则父级一次渲染内的重复 effect 会各自排队一次 setText，最终内容取决于执行顺序
    // 标记一旦置位永不复位：初值只属于挂载语义，运行期内容由用户与业务层负责
    // 不要为了支持重新载入草稿把它改回 false，那会让用户输入被历史草稿覆盖
    hasSyncedInitialValueRef.current = true;

    latestTextRef.current = initialValue;
    // [事务] 回调读的是闭包里的 initialValue，effect 重跑会排入新回调，旧回调不会自动失效
    // 因此回调内先比对当前 markdown，命中等价就直接返回，避免旧值覆盖新输入
    // 不要在回调里再读其它 props 做分支，它们可能已经变化
    // [资源] 该回调没有取消句柄，卸载后执行也必须安全，全部访问走可选链
    runAfterFrame(() => {
      // task 草稿恢复时外层 input state 已经更新，但 Lexical 内部文本不会自动跟随 props。
      // 同时普通打字也会更新 input prop，必须先比较当前编辑器文本，避免每个字符都程序化重写编辑器。
      if (resolvedInputApiRef.current?.getMarkdown() === initialValue) {
        return;
      }
      resolvedInputApiRef.current?.setText(initialValue);
    });
  }, [initialValue, resolvedInputApiRef, syncInitialValueOnMount]);

  // [契约] 编辑器每次文本变化都要同步影子副本并上抛 onChange，两条路径不能只做其一
  // 顺序是先写 latestTextRef 再调 onChange，业务层在回调里同步读取时拿到的是最新值
  // 依赖只有 onChange，不要加 resolvedInputApiRef，否则父级每次重渲染都会换掉引用
  // [权衡] 这里不做去抖：需要节流请在上层 onChange 处理，编辑器必须逐字符同步
  const handleTextChange = useCallback(
    (value: string) => {
      latestTextRef.current = value;
      onChange?.(value);
    },
    [onChange],
  );

  // [契约] 表单提交入口只做两件事：阻止默认行为、把当前 markdown 交给 onSubmit
  // preventDefault 必须最先执行，即使后续取值抛错也不会触发原生提交
  // 取值优先编辑器实时内容，ref 为空才回退影子副本，避免卸载瞬间提交空串
  // 不要在这里 await 或包 try/catch：返回值语义本身就是同步的接受与否
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current);
    },
    [onSubmit, resolvedInputApiRef],
  );

  // [契约] 表单级键盘处理只接管 Esc 取消，Enter 提交由 Lexical 内部负责
  // 不要在表单层再加 Enter 分支，否则一次回车会触发两次提交
  // submitting 期间直接返回，等于请求完成前无法从这里取消
  // 依赖里保留 submitting，闭包必须看到最新提交态
  const handleKeyDown: KeyboardEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      if (event.key !== "Escape" || !onCancel || submitting) {
        return;
      }

      // [失败路径] Portal 只改变 DOM 归属不改变 React 事件树，弹窗里的 Esc 会冒泡到这里的 form
      // 因此要同时看 defaultPrevented 与最近的 role=dialog，任一命中都说明这次 Esc 已被消费
      // 不要改成只判断 defaultPrevented：部分弹窗只关自身而没有阻止默认行为
      // 判断用 closest 而非 target 自身，命中任意后代都算在弹窗内
      // Dialog 通过 React Portal 挂载时，Esc 关闭弹窗的事件仍会沿组件树
      // 冒泡到行内编辑 form；弹窗已消费这次交互，不能再把消息编辑一并取消。
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return;
      }

      // 交互说明：用户消息 edit 是临时编辑态，Esc 应等价于点击取消，方便键盘流快速退出。
      event.preventDefault();
      onCancel();
    },
    [onCancel, submitting],
  );

  // [契约] 这一层存在的唯一目的是把业务返回的布尔值原样交回 Lexical
  // 返回 false 表示不要 reset 编辑器、草稿保留，这是延迟提交与校验失败路径的约定
  // 不要在这里做 trim、判空或二次校验：编辑器内部已按 allowSubmitWhenEmpty 等开关处理
  // [权衡] 多包一层箭头函数换来返回值语义，不能用 onSubmit 直传替代
  const handleEditorSubmit = useCallback(
    // 适配：透传业务层返回值（false = 不 reset 编辑器，草稿保留），
    // 吞掉返回值会让 Enter 路径总是清空。
    (value: string) => onSubmit(value),
    [onSubmit],
  );

  // [契约] dragover 只负责点亮可投放态与设置 dropEffect，不在这里读取文件内容
  // workspace 文件必须走 types 判断的提前 return，不能落到底部的普通外部拖拽分支
  // [失败路径] 漏掉 preventDefault 时浏览器把该元素当成不可投放，drop 永远不会触发
  // 外部文件只置标记，真消费留到 drop，避免 dragover 阶段频繁读取 dataTransfer
  const handleDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const hasWorkspaceFilePayload =
        enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer);
      // [权衡] 这里用 types 而非完整 payload 判断，是因为浏览器在 dragover 阶段不暴露 getData
      // 曾经用完整 payload 判断，结果输入框能 drop 但 hover 高亮始终不亮，用户以为不支持拖放
      // preventDefault 与 dropEffect=copy 必须同时设置，否则光标仍显示禁止符号
      // 该分支只置状态不插文本：真实转换在 drop 里做一次，避免重复 mention
      if (hasWorkspaceFilePayload) {
        // 浏览器在 dragover 阶段通常只暴露 dataTransfer.types，不保证能读到 getData 内容。
        // 之前用完整 payload 判断，导致编辑输入框 drop 可用但 hover 状态不亮。
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setWorkspaceFileDragging(true);
        setInternalDragging(true);
        return;
      }
      if (enableExternalFileDrop && Array.from(event.dataTransfer.types).includes("Files")) {
        setExternalFileDragging(true);
      }

      onDragOver?.(event);
    },
    [enableExternalFileDrop, enableWorkspaceFileDrop, onDragOver],
  );

  // [失败路径] dragleave 在进入子元素时也会触发，直接清状态会让高亮频繁闪烁
  // 因此先看 relatedTarget 是否仍被 currentTarget 包含，包含则视为子树内部移动
  // 只清 internal 标记，不碰 workspace 与 external：它们由各自的 enter、leave 与 drop 负责
  // relatedTarget 在离开窗口时为 null，正好落到清理分支
  const handleDragLeave: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setInternalDragging(false);
      onDragLeave?.(event);
    },
    [onDragLeave],
  );

  // [事务] drop 是拖拽状态的收口点：无论走哪条分支都要把三种 dragging 标记清零
  // workspace 文件分支只做 mention 插入，其余情况才回调 onDrop 交给外层处理
  // [并发] 事件对象在异步回调里会失效，payload 与 currentMarkdown 必须同步读出
  // 清标记要在插入之前，避免插入抛错后遮罩一直挂着
  const handleDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const workspaceFilePayload = enableWorkspaceFileDrop
        ? readWorkspaceFileDragPayload(event.dataTransfer)
        : null;
      // [契约] workspace 拖拽不是系统文件上传，必须转成与 @ 文件一致的 mention
      // 直接把路径插进 contenteditable 会变成普通文本，后端无法识别成文件引用
      // stopPropagation 必须保留：编辑器嵌在 ChatView 的 drop target 内，冒泡会让同一次拖拽被再消费
      // 插入成功后不回调 onDrop，避免外层再走一遍附件分支
      if (workspaceFilePayload) {
        // file tree 拖拽不是系统文件，不能走附件分支；
        // 这里统一转换成和 @ 文件一致的 mention，避免 contenteditable 插入纯文本。
        event.preventDefault();
        // 用户消息编辑器嵌套在 ChatView drop target 内；消费后必须停止冒泡，
        // 否则同一条 mention 还会被底部主输入框再次接收。
        event.stopPropagation();
        setInternalDragging(false);
        setWorkspaceFileDragging(false);
        const currentMarkdown = resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current;
        appendWorkspaceFileMentionToComposer({
          inputApiRef: resolvedInputApiRef,
          currentMarkdown,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: handleTextChange,
        });
        return;
      }

      setInternalDragging(false);
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      onDrop?.(event);
    },
    [
      enableWorkspaceFileDrop,
      handleTextChange,
      onDrop,
      resolvedInputApiRef,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // file tree 拖进编辑框时走的是 mention 插入，不是附件上传。
  // 这里单独使用 workspace file 文案，并从拖拽开始事件就点亮可投放状态，避免必须 over 到输入框才有反馈。
  const isWorkspaceFileDropActive = workspaceFileDragging || internalDragging;
  const isExternalFileDropActive = externalFileDragging || isDraggingOver;
  const draggingOverlayHint = isWorkspaceFileDropActive
    ? workspaceFileDragHint
    : isExternalFileDropActive
      ? dragAttachmentHint
      : undefined;

  // [契约] editorNode 只构造一次 JSX，两种布局共用同一节点，位置差异由外层容器承担
  // inline 时给输入区最小宽度与 contenteditable 最小高度，保证与 h-7 图标控件对齐
  // stacked 时外层类名为 contents，让编辑器直接参与上层 flex 排版
  // 不要在这里按 isInline 返回两种结构，那会让 Lexical 在切换布局时重挂载
  const editorNode = (
    // 单行时输入区至少占一半宽度，上下留白与 h-7 控件对齐；两行布局下 contents 不改变原有排版。
    <div className={isInline ? "min-w-1/2 flex-1 py-1 [&_[contenteditable]]:min-h-5" : "contents"}>
      <LexicalChatInput
        placeholder={placeholder}
        disabled={disabled}
        submitDisabled={submitDisabled}
        allowSubmitWhenEmpty={allowSubmitWhenEmpty}
        enterSubmits={enterSubmits}
        onSubmit={handleEditorSubmit}
        onModifiedSubmit={onModifiedSubmit}
        onChange={handleTextChange}
        onFocus={onFocus}
        triggerPanelContainer={resolvedTriggerPanelContainer}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        taskId={taskId}
        skillCatalogSessionId={skillCatalogSessionId}
        inputTestId={inputTestId}
        editorApiRef={resolvedInputApiRef}
        promptHistory={promptHistory}
        avoidIosInputFocusZoom={avoidIosInputFocusZoom}
        compactPlaceholder={compactPlaceholder}
        onWhiteboardMentionSelected={onWhiteboardMentionSelected}
        onPaste={onPaste}
        excludedSlashCommandNames={excludedSlashCommandNames}
        appSlashCommands={appSlashCommands}
        enableMentionPanel={enableMentionPanel}
      />
    </div>
  );
  const actionMenuNode = hasActionMenu ? (
    <span data-composer-action-menu className="flex shrink-0 items-center">
      <ChatPromptActionMenu
        actionMenuTitle={actionMenuTitle}
        excludedSlashCommandNames={excludedSlashCommandNames}
        attachmentAction={attachmentAction}
        disabled={disabled}
        disabledReason={disabledReason}
        inputApiRef={resolvedInputApiRef}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        sessionId={taskId}
        container={resolvedTriggerPanelContainer}
        showPlugins={enableMentionPanel !== false}
      />
    </span>
  ) : null;

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className={cn("relative", className)}>
      {triggerPanelContainer ? null : (
        <div
          ref={setInternalTriggerPanelContainer}
          className="absolute inset-x-0 bottom-full z-20"
        />
      )}
      <div
        data-composer-layout={layout}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused",
          isInline && "flex-row flex-wrap items-end gap-2 p-2",
          (isWorkspaceFileDropActive || isExternalFileDropActive) &&
            "border-brand bg-input-focused ring-1 ring-brand/30",
          shellClassName,
        )}
      >
        {draggingOverlayHint ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>{draggingOverlayHint}</span>
            </div>
          </div>
        ) : null}

        {topContent ? (
          // 单行布局下附件等内容单独占输入行上方一整行。
          <div className={isInline ? "basis-full" : "contents"}>{topContent}</div>
        ) : null}
        {/* 单行布局把「+」放到输入区左侧；只有菜单按钮换位置重新挂载，编辑器位置不变。 */}
        {isInline ? actionMenuNode : null}
        {inputLeadingContent ? (
          <div className={cn("flex min-w-0 items-start gap-2", isInline && "flex-1")}>
            <div className="shrink-0">{inputLeadingContent}</div>
            <div className="min-w-0 flex-1">{editorNode}</div>
          </div>
        ) : (
          editorNode
        )}
        <div
          ref={toolbarRef}
          className={cn("group/toolbar flex items-end gap-3", isInline && "shrink-0 gap-1.5")}
        >
          <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
            <div className="flex shrink-0 items-center gap-1" data-composer-leading-content>
              {isInline ? null : actionMenuNode}
              {/* Bugfix：权限/模式选择曾作为 leadingActions 先于动作菜单渲染，导致常驻顺序与产品规范相反。 */}
              {leadingActions}
              {onModeSwitchContainerChange ? (
                <span ref={onModeSwitchContainerChange} className="flex shrink-0 items-center" />
              ) : null}
            </div>
          </div>
          <div
            className="ml-auto flex shrink-0 items-center justify-end gap-1.5"
            data-composer-trailing-actions
          >
            {onCancel && cancelLabel ? (
              <ControlHintTooltip title={cancelLabel} shortcut="Esc">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onCancel}
                  disabled={submitting}
                  data-testid={cancelTestId}
                  aria-label={cancelLabel}
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">{cancelLabel}</span>
                </Button>
              </ControlHintTooltip>
            ) : null}
            {betweenCancelAndSubmitAction}
            {submitControl ?? (
              <ControlHintTooltip title={submitLabel} shortcut={enterSubmits ? "Enter" : undefined}>
                <Button
                  type="submit"
                  size="icon-md"
                  disabled={submitDisabled}
                  data-testid={submitTestId ?? TID_CHAT_SEND_BUTTON}
                  aria-label={submitLabel}
                  className="gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
                >
                  {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
                  <span className="sr-only">{submitLabel}</span>
                </Button>
              </ControlHintTooltip>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
