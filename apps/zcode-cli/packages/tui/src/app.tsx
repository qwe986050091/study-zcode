// TUI 应用根模块：持有会话级 UI 状态并编排主题、事件订阅、提交、粘贴、历史、提及与键盘等 controller。
// 边界：只保存渲染所需的临时状态；session/model/tool 等业务事实均由 options 回调与 session event 下发。
// 副作用：全部经 options 注入的回调完成（网络、持久化、剪贴板）；本组件不直接调用底层 I/O。
// 失败语义：错误以状态栏文案或 system 消息呈现，不吞掉也不在 UI 层决定退出码。
// 深度不变量清单（B45）：TUI 根组件只做状态编排，下列约束逐条对应可被改坏的线上症状。
// 边界：持有渲染所需的临时交互态（草稿文本与附件、候选选择态、审批队列、侧栏布局），不持有 session/mode/model 等业务事实。
// 不负责：发起网络、落盘、写系统剪贴板、判定权限或决定退出码；这些一律经 options 注入的回调或外壳 onExit 完成。
//
// INV-01 断言：messages 只能经 SessionEvent 投影与 applyResult 兜底写入，组件不得就地拼装业务消息 —— 守住它的位置：applySessionEvent 与 useTuiApplyResult 装配处 —— 改错故障：快照与增量各写一份，transcript 出现重复条目
// INV-02 断言：草稿真值同时存在 draft state 与 draftRef，setDraftValue 是唯一同步入口 —— 守住它的位置：setDraftValue —— 改错故障：事件闭包读到旧草稿，提交内容与屏幕显示不一致
// INV-03 断言：附件数组以 draftAttachmentsRef 为即时真值，setDraftAttachments 包装函数是唯一写入口 —— 守住它的位置：setDraftAttachments 的 useCallback —— 改错故障：连续两次粘贴互相覆盖，前一张图片丢失
// INV-04 断言：占位符文本被删除时必须连带移除对应附件 —— 守住它的位置：setDraftValue 内的 filter 分支 —— 改错故障：提交时引用已不存在的占位符，模型收到空图片引用
// INV-05 断言：模型/思考档位/模式/slash 四个候选面板同一时刻最多只有一个选中态 —— 守住它的位置：setDraftValue 中的互斥 else-if 链 —— 改错故障：多层浮层叠压，回车提交走向错误解释路径
// INV-06 断言：提交文本的解析优先级必须与面板互斥优先级完全一致 —— 守住它的位置：resolveSubmittedText —— 改错故障：面板显示模型候选，提交却按 slash 命令解释
// INV-07 断言：busy 只表达是否存在活跃 turn，不兼作排队判据 —— 守住它的位置：useSubmitValue 的 busy 入参 —— 改错故障：一次运行中提交把全部排队输入吞掉，或并发起第二个 turn
// INV-08 断言：中止句柄只经 abortControllerRef 传递，不得另建控制器 —— 守住它的位置：turnRef 注入点与粘贴/提交两处 hook 装配 —— 改错故障：中止后旧流仍在写消息，表现为停不下来
// INV-09 断言：三个共享 Map/Set 索引必须始终是同一实例 —— 守住它的位置：各 .current 传入 applyResult 与 applySessionEvent —— 改错故障：工具结果无法并回原消息，出现孤儿卡片与重复文件统计
// INV-10 断言：初始状态按 sentinel → 启动参数 → 默认值三级回退，保证首帧文案确定 —— 守住它的位置：各 useState 初始化函数 —— 改错故障：恢复会话时先渲染默认模式再跳变，界面闪烁
// INV-11 断言：loginRequired 由 sentinel 置真后只能被事件或结果投影改写 —— 守住它的位置：initialLoginRequired 与两个投影 hook —— 改错故障：首帧漏出登录提示，或误判未登录而阻断输入
// INV-12 断言：用户编辑草稿必须重置历史回溯游标与两份快照 —— 守住它的位置：setDraftValue 尾部三行 —— 改错故障：改完草稿按上键跳回旧输入，覆盖当前编辑内容
// INV-13 断言：组件内不得引入直接 I/O、console 输出或 exit 调用 —— 守住它的位置：整个函数体 —— 改错故障：stdout 被污染，TUI 错行花屏，退出码被 UI 层决定
//
// 记号说明：正文块标签含义如下。
// [契约] 跨模块接口的形状与优先级约定，改动会同时影响面板展示与提交解析两侧。
// [并发] 事件流与本组件 setState 的交错点，顺序错会留下过期投影。
// [资源] 需要成对释放或同步镜像的对象，例如中止句柄、ref、Map/Set 索引。
// [失败路径] 失败必须显式呈现给用户，不允许静默吞掉或改写成成功文案。
// [权衡] 看似多余、实则防竞态的写法，删掉后症状只在特定操作序列下出现。
//
// 本批次只新增注释，未改动任何代码行；行号以插入后的文件为准。
import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { AppView } from "./app-view.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import { selectionCopyStatus, type SelectionCopyResult } from "./app-copy.js";
import { useClipboardImagePaste } from "./app-clipboard-image.js";
import { useFileMentionController } from "./app-file-mentions.js";
import { useTuiKeyboardControls } from "./app-keyboard.js";
import { useTuiModeSwitcher } from "./app-mode.js";
import { createTuiPermissionRequester } from "./app-permission.js";
import { appendAgentResult } from "./app-submit.js";
import { useSubmitValue } from "./app-submit-controller.js";
import { filterSlashCommands, reconcileSlashSelection } from "./app-input.js";
import { useEffortCommandController } from "./app-effort-command.js";
import { useInputHistory } from "./app-input-history.js";
import { useModeCommandController } from "./app-mode-command.js";
import { useModelCommandController } from "./app-model-command.js";
import { useSidebarController } from "./app-sidebar-layout.js";
import { createSelectionState } from "./app-selection-state.js";
import { resolveComposerSubmittedText } from "./app-submit-resolver.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import { useTuiThemeSync } from "./app-theme-sync.js";
import { useSessionEventApplier } from "./app-session-event-handler.js";
import { useTuiWorkflowRuns } from "./app-workflow-controller.js";
import { useTuiApplyResult } from "./app-result.js";
import { useSubagents } from "./app-subagents.js";
import type { TuiOptions } from "./types.js";

type TuiAppProps = {
  copySelection: () => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  options: TuiOptions;
  onExit: (code: number) => void;
};

// TUI 应用根组件：持有会话级可变状态（消息、草稿、busy、审批队列、模式/模型等），
// 并编排主题同步、事件订阅、提交、剪贴板粘贴、输入历史、文件提及与键盘控制等 controller。
// options 为启动注入的依赖与初始值；onExit 由外壳传入，负责销毁 renderer 并带退出码收尾。
// 所有 SessionEvent 经 useSessionEventApplier 投影进 messages；本地流式投影在快照到达后收尾。
// 组件不直接做 IO：网络/持久化都在 options 回调中完成，失败以状态栏文案或 system 消息呈现。
export function TuiApp({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
}: TuiAppProps): React.ReactElement {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  // [契约] 启动 sentinel 是启动器下发的诊断快照，只在首帧读取一次，不参与后续状态同步。
  // [失败路径] sentinel 里的 loginRequired、mode、model 允许缺失，缺省时必须回落到 options 的启动参数。
  // [权衡] 这里刻意不做校验也不深拷贝：sentinel 由启动器构造，在此补默认值会掩盖两端字段名不一致的真实缺陷。
  // [失败路径] 若把 sentinel 当成可更新的状态源，重放会话时旧快照会覆盖事件投影，界面停在第一帧。
  const initialResult = options.initialResult;
  const initialLoginRequired = initialResult?.loginRequired ?? options.loginRequired ?? false;
  const initialLocale = options.locale ?? "en-US";
  const initialCopy = getZCodeCopy(initialLocale).tui;
  // [契约] 主题同步必须在首帧渲染前触发一次，把 options 里的主题偏好推给渲染器。
  // [资源] 该 hook 自行订阅与退订，本组件不接手清理；不要为了对称再写一个 effect 去还原颜色。
  // [权衡] 主题完全由外部持有，这里不保存 theme state，避免两处真值在切换时互相覆盖。
  // [失败路径] 若把它挪到条件分支或 useState 之后，首次渲染会先用默认配色，用户可见一次颜色回退。
  // [并发] 它与 locale 初始化互不依赖：主题失败不影响首帧文案，反之亦然，因此两者都不可被 await 串行化。
  useTuiThemeSync(options);
  // 初始消息来自启动 sentinel（重放/恢复会话），为空时从空 transcript 开始。
  const [messages, setMessages] = useState<Message[]>(() =>
    initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
  );
  const [draft, setDraftState] = useState("");
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
  // [契约] busy 只表示当前是否有活跃 turn，用于禁用提交与显示占位提示，不代表排队长度。
  // [并发] 排队输入由 queuedInputs 单独承载；若用 busy 兼作队列判据，一次占位提示会吞掉全部排队项。
  // [失败路径] 收尾路径必须把它复位为 false，否则界面永久停在运行中，回车只会不断入队。
  const [busy, setBusy] = useState(false);
  // 模式/模型/思考档位按 sentinel → 启动参数 → 默认值逐级回退，保证首帧有确定文案。
  // [契约] 首帧模式按 sentinel → 启动参数 → build 逐级回退，保证界面先有确定文案再接受事件。
  // [权衡] 初始化之后即归事件投影与结果兜底管理，组件不再自行推断模式，避免出现第三处真值。
  // [失败路径] 若改成异步取回后再渲染，首帧会先显示 build 再跳变，用户看到模式闪烁。
  // [并发] 事件投影与结果兜底可能连续两次写同一字段，后写者为准，故两者的装配顺序在下方固定。
  const [mode, setMode] = useState(initialResult?.mode ?? options.initialMode ?? "build");
  const [model, setModel] = useState(initialResult?.model ?? options.initialModel ?? "unknown");
  const [thoughtLevel, setThoughtLevel] = useState(
    initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
  );
  const [locale, setLocale] = useState(initialLocale);
  const [lastEvent, setLastEvent] = useState("idle");
  const [lastError, setLastError] = useState<string | undefined>();
  const copy = useMemo(() => getZCodeCopy(locale), [locale]);
  const [loginRequired, setLoginRequired] = useState(initialLoginRequired);
  const [status, setStatus] = useState(
    initialResult?.selection?.prompt ??
      (initialLoginRequired ? initialCopy.loginRequired.status : initialCopy.status.ready),
  );
  const [statusDetails, setStatusDetails] = useState<string[]>([]);
  const [traceId, setTraceId] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<TurnId | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>({});
  const [cacheStats, setCacheStats] = useState<CacheStats | undefined>();
  const [usage, setUsage] = useState<ModelUsageSummary | undefined>();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFileStat[]>([]);
  const [liveModelText, setLiveModelText] = useState("");
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  // [契约] 选择态用惰性初始化，把 sentinel 中的恢复选择交给 createSelectionState 归一化。
  // [资源] 归一化函数负责补齐字段与裁剪越界范围，不要在这里再手写一份修正逻辑，双份实现必然分叉。
  // [失败路径] 直接把 sentinel.selection 塞进 state 会带进越界下标，首帧渲染即抛错。
  // [权衡] 惰性初始化只在挂载时执行一次；后续选择恢复由事件投影写入，不要在此重复计算。
  const [selection, setSelection] = useState<SelectionState | undefined>(() =>
    createSelectionState(initialResult?.selection),
  );
  const [slashSelection, setSlashSelection] = useState<SlashSelectionState | undefined>();
  // [契约] 审批队列是待决权限请求的 FIFO 队列，队首由键盘控制消费，组件只负责入队与出队。
  // [失败路径] 队列非空时回车被审批面板接管；若在别处就地清空，待决请求会悬空，对应工具调用卡死。
  // [资源] 每个请求必须成对产生批准或拒绝结论，由 createTuiPermissionRequester 保证，不要在 UI 侧补默认值。
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [inputCursorToEndVersion, setInputCursorToEndVersion] = useState(0);
  // dwf 运行态镜像：共享 reducer 逐事件维护 + 冷启动一次性补种，无第二时钟。
  const workflowRuns = useTuiWorkflowRuns({ copy: copy.tui, options, setMessages });
  const sidebar = useSidebarController();
  const subagents = useSubagents(options);

  // 这些 ref 保存跨事件闭包需要的最新值（草稿/附件/中止句柄/工具映射），避免因 state 更新丢失中间态。
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const draftRef = useRef("");
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const inputEditorRef = useRef<PromptInputEditor | null>(null);
  const inputHistoryIndexRef = useRef(0);
  const inputHistoryDraftAttachmentsRef = useRef<DraftAttachment[] | undefined>(undefined);
  const inputHistoryDraftRef = useRef<string | undefined>(undefined);
  const nextAttachmentIdRef = useRef(1);
  // [资源] 这三个 ref 里的 Map/Set 是跨事件累积的索引，必须保持同一实例，换新实例等于丢弃全部历史关联。
  // [契约] assistantMessageIdsByToolCallId 记录工具调用到消息的归属，用于把工具结果并回正确的助手消息。
  // [契约] modifiedFileToolCallIds 用于修改文件统计去重，toolNamesById 用于结果到达时还原可读工具名。
  // [失败路径] 若在渲染中按值新建 Map 传入 hook，每次渲染都会清空索引，结果到达后只能新建消息，出现重复卡片。
  const assistantMessageIdsByToolCallIdRef = useRef(new Map<string, string>());
  const modifiedFileToolCallIdsRef = useRef(new Set<string>());
  const toolNamesByIdRef = useRef(new Map<string, string>());

  const slashCommands = options.slashCommands ?? [];
  const [effortOptions, setEffortOptions] = useState<NonNullable<TuiOptions["effortOptions"]>>(
    () => initialResult?.effortOptions ?? options.effortOptions ?? [],
  );
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const effortCommand = useEffortCommandController(draft, effortOptions);
  const modelCommand = useModelCommandController(draft, options);
  const modeCommand = useModeCommandController(draft);

  // [资源] 这是附件数组的唯一写入口：先写 ref 再写 state，保证事件闭包与渲染读到同一份数据。
  // [并发] 函数式更新以 ref.current 为基准而非 state，同一 tick 内的两次粘贴不会互相覆盖。
  // [失败路径] 绕开它直接调 setDraftAttachmentsState 会让 ref 与 state 分叉，提交时丢掉最新附件。
  const setDraftAttachments = useCallback((action: React.SetStateAction<DraftAttachment[]>) => {
    const nextAttachments =
      typeof action === "function" ? action(draftAttachmentsRef.current) : action;
    draftAttachmentsRef.current = nextAttachments;
    setDraftAttachmentsState(nextAttachments);
  }, []);

  const setDraftValue = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraftState(value);
      // 文本被删除后，其占位符对应的附件一并移除，防止提交时引用已不存在的图片。
      setDraftAttachments((current) =>
        current.filter((attachment) => value.includes(attachment.placeholder)),
      );
      // 编辑草稿视为退出历史回溯，避免下一次上下键跳回旧输入。
      inputHistoryIndexRef.current = 0;
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      // [契约] 候选面板互斥优先级为模型、思考档位、模式、slash，与提交时的解析优先级逐级一致。
      // [并发] 三者用 else-if 链而非各自独立判断，确保同一次草稿变更只激活一个面板。
      // [权衡] 激活新面板时显式清空其余选择态看似冗余（下次 reconcile 也会清），但能避免中间渲染闪出两层浮层。
      // [失败路径] 若让各面板自行决定互斥，输入 /model 前缀时 slash 面板会同时弹出，回车走向不确定。
      // [契约] slash 选择仅在三个面板都未激活时重算，因此命令前缀与模型候选不会争夺同一次回车。
      const nextModelSelection = modelCommand.reconcileDraft(value);
      // 候选面板互斥：模型、思考档位、模式、slash 命令同一时刻只保留一个，避免多层浮层叠压。
      const nextEffortSelection = nextModelSelection
        ? undefined
        : effortCommand.reconcileDraft(value);
      const nextModeSelection =
        nextModelSelection || nextEffortSelection ? undefined : modeCommand.reconcileDraft(value);
      if (nextModelSelection) {
        effortCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextEffortSelection) {
        modelCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextModeSelection) {
        effortCommand.setSelection(undefined);
        modelCommand.setSelection(undefined);
      }
      setSlashSelection(
        nextModelSelection || nextEffortSelection || nextModeSelection
          ? undefined
          : reconcileSlashSelection(value, slashCommands),
      );
    },
    [effortCommand, modeCommand, modelCommand, setDraftAttachments, slashCommands],
  );

  // 把 run 结果（最终快照）合并回 UI 状态；作为提交失败前的最后一道兜底投影。
  // [契约] applyResult 是提交失败前的最后兜底投影：run 返回的最终快照经它合并回全部 UI 状态。
  // [并发] 它与事件订阅共用 modifiedFileToolCallIds 实例，保证兜底投影不会重复累加文件统计。
  // [失败路径] fallback 带上 locale、loginRequired、mode、model，是因为快照可能缺字段，缺省时应沿用当前值而非清空。
  // [权衡] 这里透传二十多个 setter 看似可合并成 reducer，保留分开是为了让哪个字段被谁改在装配处一眼可读。
  const applyResult = useTuiApplyResult({
    fallback: { locale, loginRequired, mode, model },
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setEffortOptions,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setLoginRequired,
    setMessages,
    setMode,
    setModel,
    setModelOptions: modelCommand.setModelOptions,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    workspaceDirectory: options.workspaceDirectory,
  });

  // 单一会话事件入口：先转交子代理控制器，再投影到 transcript/侧边栏/工作流镜像。
  // [契约] 会话事件单一入口：先交给子代理控制器观测，再投影到 transcript、侧栏与工作流镜像。
  // [并发] 顺序不可颠倒——子代理需要先看到原始事件，才能在投影前决定是否由只读视图接管按键。
  // [资源] 三个 Map/Set 以 .current 传入而非整体 ref，让 hook 内部持有稳定引用且不感知 ref 结构。
  // [失败路径] 若改为投影后再转交，子代理视图会看到已被改写的消息，返回键可能退到错误层级。
  // [权衡] 此路径只做增量追加，历史重放不走这里，避免与快照路径双写同一条消息。
  const applySessionEvent = useSessionEventApplier({
    subscribeSessionEvents: options.subscribeSessionEvents,
    observeSessionEvent: subagents.onEvent,
    copy: copy.tui,
    getMainSessionId: options.getMainSessionId,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastError,
    setLastEvent,
    setLiveModelText,
    setMessages,
    setModel,
    setThoughtLevel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setStatus,
    setTodos,
    setUsage,
    setWorkflowMirror: workflowRuns.setMirror,
    assistantMessageIdsByToolCallId: assistantMessageIdsByToolCallIdRef.current,
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    toolNamesById: toolNamesByIdRef.current,
    workspaceDirectory: options.workspaceDirectory,
  });

  // 权限请求器把工具审批挂到队列并同步状态文案；每次启动复用同一实例。
  // [契约] 权限请求器把工具审批挂到队列并同步状态文案，供 run 与 slash 命令共用同一实例。
  // [资源] 依赖数组为空是有意的：实例在组件生命周期内复用，重建会丢失已注册请求的关联。
  // [失败路径] 若每次渲染新建实例，审批结论会回到旧实例，队列里留下永不消费的残留项。
  const requestPermission = useMemo(
    () => createTuiPermissionRequester({ setApprovalQueue, setStatus }),
    [],
  );

  // 提交文本解析优先级与候选面板一致：模型 > 思考档位 > 模式 > slash 命令 > 原始输入。
  const resolveSubmittedText = useCallback(
    (submittedValue: string) => {
      const modelOption = modelCommand.selectedOption(submittedValue);
      const effortOption = modelOption ? undefined : effortCommand.selectedOption(submittedValue);
      return resolveComposerSubmittedText({
        effortOption,
        modeOption:
          modelOption || effortOption ? undefined : modeCommand.selectedOption(submittedValue),
        modelOption,
        slashCommands: filteredSlashCommands,
        slashSelection,
        submittedValue,
      });
    },
    [effortCommand, filteredSlashCommands, modeCommand, modelCommand, slashSelection],
  );

  // 提交入口：busy 时排队、空闲时立即发 run；中止句柄与流式收尾都由该 hook 统一管理。
  // [契约] 提交入口在此一处判定排队还是直发，其他位置不得再判一次 busy。
  // [并发] messageInsertIndex 取当前消息数作为插入哨兵，先记位置再发请求，异步结果回来时按索引归并。
  // [资源] turnRef 与三个 ref 透传进去，由 hook 统一建立与释放中止句柄，本组件不自行 abort。
  // [失败路径] 失败处理全由 hook 完成；本组件只接收 setBusy 与 setLastError，若在此补一套复位，会与收尾路径重复。
  // [权衡] resolveSubmittedModel 只回传 ref 而非完整选项，避免提交层依赖模型候选面板的内部结构。
  const submitValue = useSubmitValue({
    activeTurnId,
    applyResult,
    applySessionEvent,
    busy,
    draftAttachmentsRef,
    emptyPromptStatus: copy.tui.input.typePrompt,
    messageInsertIndex: messages.length,
    options,
    requestPermission,
    resolveSubmittedText,
    resolveSubmittedModel: (value) => modelCommand.selectedOption(value)?.ref,
    setBusy,
    setDraftAttachments,
    setDraftValue,
    setLastError,
    setLiveModelText,
    setMessages,
    setQueuedInputs,
    setSelection,
    setSlashSelection,
    setStatus,
    setStatusDetails,
    turnRef: abortControllerRef,
  });

  // 剪贴板图片粘贴：仅在 busy=false 时插入附件占位符；读取失败通过状态栏提示。
  // [契约] 剪贴板图片粘贴只在空闲态插入附件占位符，运行中粘贴不生效，避免污染进行中的 turn。
  // [失败路径] 读取失败经状态栏与详情提示，不向渲染层抛出；不要吞掉错误后再补一条成功文案。
  // [资源] nextAttachmentIdRef 保证占位符编号单调递增，编号重复会导致删除占位符时误删另一张图。
  const pasteClipboardImage = useClipboardImagePaste({
    abortControllerRef,
    busy,
    getDraftValue: () => draftRef.current,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  });

  // 输入历史回溯：同时恢复草稿与附件；首次回溯前快照当前草稿，供向下键还原。
  // [契约] 历史回溯同时恢复草稿文本与附件，两者必须来自同一次快照，否则下标指向不同轮输入。
  // [权衡] 首次回溯前先快照当前草稿，向下键靠它还原；去掉这层快照，用户会永久失去正在编辑的内容。
  // [失败路径] 回溯写入复用 setDraftValue 的附件清理与游标复位语义，hook 必须在写入后恢复索引，顺序不可交换。
  const { recallNextInput, recallPreviousInput } = useInputHistory({
    copy: copy.tui,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftState,
    setDraftValue,
    setInputCursorToEndVersion,
    setSlashSelection,
    setStatus,
    setStatusDetails,
  });

  // 文件提及补全：@ 触发路径候选，选中后回填占位符并登记附件。
  // [契约] 提及补全由 @ 触发路径候选，选中后回填占位符并登记附件，占位符是附件与文本的唯一纽带。
  // [并发] busy 期间禁用候选，防止在活跃 turn 中改草稿导致提交解析读到半成品输入。
  // [失败路径] 路径列表来自 options 注入，失败时只更新状态栏，不在补全面板里渲染错误详情。
  const fileMentions = useFileMentionController({
    busy,
    draft,
    editorRef: inputEditorRef,
    listWorkspacePathSuggestions: options.listWorkspacePathSuggestions,
    nextAttachmentIdRef,
    setDraftAttachments,
    setDraftValue,
    setSlashSelection,
    setStatus,
  });

  // 复制当前选择：无可复制文本时返回 false 且不调用系统剪贴板；成功/失败仅更新状态栏。
  // [契约] 同步返回布尔值供键位处理判断是否已消费按键，实际复制异步进行，结果只影响状态栏。
  // [失败路径] 无可复制文本时直接返回 false 且不触碰系统剪贴板，避免把空串写进用户剪贴板。
  // [权衡] 这里不能 await：键盘事件不能等剪贴板，否则连按会堆积；代价是状态栏提示异步到达。
  // [资源] 用 void 丢弃 promise 句柄是刻意的：结果已由 selectionCopyStatus 归一化为文案，无需再挂 catch。
  const copyCurrentSelection = useCallback((): boolean => {
    if (!hasCopyableSelection()) return false;
    void copySelection().then((result) => {
      const copyStatus = selectionCopyStatus(result, copy.tui.copy);
      if (copyStatus.status) setStatus(copyStatus.status);
      if (copyStatus.details) setStatusDetails(copyStatus.details);
    });
    return true;
  }, [copy, copySelection, hasCopyableSelection]);
  const switchMode = useTuiModeSwitcher({
    mode,
    setMode,
    setModeHandler: options.setMode,
    setStatus,
  });

  // 键盘控制统一注册：只读子代理视图优先接管返回键，其余快捷键按当前选择态分派。
  // [契约] 键盘分发的唯一注册点：只读子代理视图优先接管返回键，其余按键按当前选择态分派。
  // [并发] 传入的 selection 是本轮渲染快照，若键盘回调缓存旧闭包，会按上一个面板的解释处理按键。
  // [失败路径] inputHistoryActive 用 ref.current 判断而非 state，因为历史快照可能在本轮渲染之后才被清理。
  // [资源] 监听器的注册与卸载由该 hook 负责，不要再在组件里挂一套全局 keypress，两套监听会重复消费同一按键。
  useTuiKeyboardControls({
    readOnlyView: subagents.selected ? { back: subagents.back } : undefined,
    abortControllerRef,
    approvalQueue,
    busy,
    copyCurrentSelection,
    effortSelection: effortCommand.selection,
    filteredEffortOptions: effortCommand.filteredOptions,
    filteredSlashCommands,
    filteredModeOptions: modeCommand.filteredOptions,
    filteredModelOptions: modelCommand.filteredOptions,
    handleFileMentionKey: fileMentions.handleKey,
    onExit,
    pasteClipboardImage,
    recallNextInput,
    recallPreviousInput,
    draftValue: draft,
    inputHistoryActive: inputHistoryDraftRef.current !== undefined,
    messages,
    modelSelection: modelCommand.selection,
    modeSelection: modeCommand.selection,
    selection,
    setApprovalQueue,
    setDraftAttachments,
    setDraftValue,
    setEffortSelection: effortCommand.setSelection,
    setModelSelection: modelCommand.setSelection,
    setModeSelection: modeCommand.setSelection,
    setSelection,
    setSlashSelection,
    setStatus,
    slashSelection,
    submitValue,
    switchMode,
    workflowExpansion: workflowRuns.expansion,
    toggleSidebar: sidebar.toggleSidebar,
    toggleSidebarSection: sidebar.toggleSidebarSection,
  });

  // [契约] 渲染出口只做投影：把状态与 controller 暴露的派生值一次性交给 AppView，本文件不出现 JSX 结构。
  // [权衡] 用 createElement 而非 JSX 是刻意的，视图改动集中在 app-view；不要在此顺手内联布局。
  // [失败路径] 这里漏传某个状态会让对应面板静默失效（例如审批队列不显示），排查时先核对两侧属性清单。
  // [契约] options 是启动依赖原样透传，视图只读，不得在其内部回写。
  return React.createElement(AppView, {
    subagents,
    toggleSidebar: sidebar.toggleSidebar,
    activeTurnId,
    approvalQueue,
    busy,
    cacheStats,
    contextUsage,
    copy: copy.tui,
    copyCurrentSelection,
    draft,
    editorRef: inputEditorRef,
    inputCursorToEndVersion,
    lastError,
    lastEvent,
    loginRequired,
    liveModelText,
    mode,
    model,
    messages,
    modifiedFiles,
    networkRequests,
    options,
    queuedInputs,
    selection,
    fileMention: fileMentions.state,
    setDraftValue,
    sidebarLayout: sidebar.layout,
    sidebarSections: sidebar.sections,
    effortOptions: effortCommand.filteredOptions,
    effortSelection: effortCommand.selection,
    modelOptions: modelCommand.filteredOptions,
    modelSelection: modelCommand.selection,
    modeOptions: modeCommand.filteredOptions,
    modeSelection: modeCommand.selection,
    slashCommands: filteredSlashCommands,
    slashSelection,
    status,
    statusDetails,
    submitValue,
    thoughtLevel,
    todos,
    toggleSidebarSection: sidebar.toggleSidebarSection,
    traceId,
    terminalWidth: sidebar.terminalWidth,
    usage,
    workflowCardsByToolCallId: workflowRuns.cardsByToolCallId,
    expandedWorkflowRunIds: workflowRuns.expandedRunIds,
  });
}
