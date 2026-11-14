// INV-01 分发优先级固定为只读视图→审批→选区→侧栏→Ctrl-C→全局组合键→草稿编辑；守住条件分支的先后位置，改错会让低优先级处理器抢走高优先级按键。
// INV-02 readOnlyView 存在即独占键盘，只放行侧栏、escape、复制与滚动键；守住该分支的早返回，改错会在预览态误触输入或弹出建议面板。
// INV-03 审批队列非空时先消费按键再交给审批处理器；守住消费与处理的先后，改错会让普通输入被静默丢弃。
// INV-04 文本选区激活时按键只属于选区；守住该分支先于侧栏与 Ctrl-C 的位置，改错会让方向键同时移动选区和召回历史。
// INV-05 侧栏快捷键先于 Ctrl-C 判断且命中后重置退出守卫；守住命中即 return 的写法，改错会让侧栏键顺带累计退出确认。
// INV-06 Ctrl-C 三级语义为复制、清草稿、两次确认退出；守住这个顺序，改错会让一次复制被当成一次退出确认。
// INV-07 退出守卫与侧栏守卫都放在 ref 里；守住 ref 而非 state 的选择，改错会让按键读到过期快照或引发多余重渲染。
// INV-08 release 事件必须在函数最前返回；守住这个早返回，改错会让一次敲击执行两遍并提前推进确认窗口。
// INV-09 每个分支要么消费并 return、要么完全放行；守住这个二分语义，改错会出现部分消费后继续下传导致的双动作。
// INV-10 Tab 补全优先级为模型→力度→模式→斜杠；守住每层命中即 return，改错会让多类补全叠加改写同一份草稿。
// INV-11 Escape 一次只关一个建议面板；守住逐层 return 的顺序，改错会一次误按丢光全部候选。
// INV-12 方向键先给建议面板导航、再给历史召回；守住这个先后，改错会让有面板时上下键去翻历史。
// INV-13 Ctrl-R 仅在最近时间线事件可重试 compact 时才拦截；守住这个前提，改错会抢走输入框的默认行为。
// INV-14 模式切换键先于 @ 文件提及处理；守住这个顺序，改错会让文件补全抢走 composer 的模式切换。
// INV-15 异步动作一律以 void 触发、不阻塞等待；守住不等待的写法，改错会让按键回调返回 Promise 并破坏事件时序。
// INV-16 Ctrl-U 无条件清空草稿与附件，不与 Ctrl-C 共用确认；守住这个区别，改错会让清空动作被误当成退出。
// INV-17 Ctrl-V 需兼容 raw 控制字符 \x16；守住这个兜底判断，改错会让部分终端下粘贴图片完全失效。
// INV-18 useCallback 依赖表必须覆盖全部闭包字段；守住依赖完整性，改错会让处理器长期读到过期的 props 与选择态。
//
// 模块职责：把全局按键按固定优先级路由到各交互处理器，本文件只做分发，不做业务决策与持久化。
// 状态所有权：草稿、选择态与审批队列由上层持有并通过参数注入，本 hook 仅持有两个守卫 ref。
// 阅读顺序：先看 UseTuiKeyboardControlsOptions 了解注入面，再沿 useKeyboard 回调自上而下读分支。
// 全局键盘分发（L2）：按优先级把按键路由到只读视图/审批/选区/侧栏/输入区各处理器。
// 只读写 TUI 临时交互态并调用注入回调；退出、提交、粘贴等业务动作全部交给上层。
// 每个按键要么被消费并 return，要么完全放行，不允许部分消费后继续下传。
import type { KeyEvent } from "@mbears/opentui-core";
import type { TuiWorkflowExpansionControls } from "./app-workflow-controller.js";
import { useKeyboard } from "@mbears/opentui-react";
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { handleApprovalKey } from "./app-approval.js";
import { handleSelectionKey } from "./app-input.js";
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  type CtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldClearPromptDraftOnCtrlC,
  shouldHandleInputHistoryNavigation,
  workflowExpansionActionFor,
} from "./app-keyboard-helpers.js";
import { handleSuggestionNavigationKey } from "./app-keyboard-suggestions.js";
import { createSidebarShortcutState, type SidebarShortcutState } from "./app-sidebar-shortcut.js";
import { handleSidebarShortcutKey } from "./app-sidebar-keyboard.js";
import type {
  ApprovalPrompt,
  DraftAttachment,
  EffortCommandSelectionState,
  Message,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SelectionState,
  SubmitValueOptions,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";
import { latestRetryableCompactCommand } from "./app-compact-timeline.js";

export {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldHandleInputHistoryNavigation,
} from "./app-keyboard-helpers.js";

// 键盘控制的完整依赖注入表：TUI 不做业务决策，所有状态与动作都由上层传入。
// 口径：除标注 ? 的字段外均为必需；表示“当前没有该交互态”一律用 undefined，不用 null。
// 时序：handleFileMentionKey 为同步布尔返回值，返回 true 表示已消费按键（含 @ 文件建议）。
// 约束：本 hook 只读写 TUI 临时交互态（草稿、选中项、选择态），session/权限等业务状态
// 必须经 submitValue / switchMode 等回调交由上层处理，不得在 TUI 内落库。
type UseTuiKeyboardControlsOptions = {
  // 只读视图（如翻页预览/详情）时的返回栈入口；存在即进入只读模式，优先级高于其他按键处理。
  readOnlyView?: { back(): void };
  // 当前会话的取消句柄；Escape/Ctrl-C 通过 abort() 暂停输出，不直接销毁会话。
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  // 待审批队列，队头为当前审批；空数组表示无审批，非空时独占键盘。
  approvalQueue: ApprovalPrompt[];
  // 模型是否仍在输出；决定 Escape 是暂停输出还是提示无输出。
  busy: boolean;
  // 复制当前终端选区；返回 false 表示无选区可复制。
  copyCurrentSelection: () => boolean;
  // 输入框草稿；空串是 Ctrl-C 清空/退出判断与上下键历史导航的前置条件。
  draftValue: string;
  // workflow 卡片展开控制；undefined 表示当前无 workflow UI，`+`/`-` 不生效。
  workflowExpansion?: TuiWorkflowExpansionControls;
  // 以下四个 filtered* 为已按输入过滤并排序的候选，空数组表示对应面板无候选、不可导航。
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  // 处理 @ 文件提及补全；同步返回是否已消费按键，消费后本层不再继续。
  handleFileMentionKey: (key: KeyEvent) => boolean;
  // 输入历史是否可用（例如已进入历史浏览态或存在历史记录）。
  inputHistoryActive: boolean;
  // 当前消息列表；Ctrl-R 重试最近可重试的 compact 命令时按此查找。
  messages: readonly Message[];
  // 四类建议面板的选中态；undefined 表示该面板未打开。
  effortSelection: EffortCommandSelectionState | undefined;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  // 进程退出回调；由入口层决定退出码，本层只表达“用户确认退出”的意图。
  onExit: (code: number) => void;
  // 粘贴剪贴板图片为附件；异步、可能失败，失败由实现方经 setStatus 反馈。
  pasteClipboardImage: () => Promise<void>;
  // 输入历史向前/向后召回；异步，调用方不等待（void）。
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
  // 终端文本选区；存在时键盘优先交给选区处理（复制/取消），屏蔽普通输入。
  selection: SelectionState | undefined;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalPrompt[]>>;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  // 提交输入；options 可保留选择态（如 compact 重试），Promise 拒绝由实现方处理。
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>;
  switchMode: () => void;
  // 侧栏/分组切换；返回 false 表示快捷键未命中（例如侧栏已收起），交回后续处理器。
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
};

// 注册全局 TUI 键盘处理器，按固定优先级分发按键：只读视图 → 审批 → 文本选区 →
// 侧栏快捷键 → Ctrl-C 退出/复制 → 全局组合键（Ctrl-R/Y/Tab/Escape/上下键）→ 草稿编辑键。
// 输入：见 UseTuiKeyboardControlsOptions；所有状态由上层注入，hook 自身只持有两个守卫 ref。
// 输出：无返回值；通过 useKeyboard 订阅，按键命中后调用 consumeKey 阻止冒泡。
// 副作用：调用 setStatus/setDraftValue 等状态更新，可能触发 abort()、onExit、异步提交/粘贴；
// 不直接持久化、不直接写日志。
// 失败语义：Ctrl-C 采用“两次确认”守卫，首次仅提示，窗口外再次按下会重置为首次；
// 异步动作（粘贴、历史召回）以 void 触发，错误由各自实现反馈到状态栏。
// 不变量：每个分支要么消费按键并 return，要么完全不碰按键；不允许“部分消费后继续下传”。
// 维护点：新增快捷键务必插到合适优先级位置，避免抢走输入框字符或建议导航。
export function useTuiKeyboardControls({
  readOnlyView,
  abortControllerRef,
  approvalQueue,
  busy,
  copyCurrentSelection,
  draftValue,
  workflowExpansion,
  filteredEffortOptions,
  filteredModeOptions,
  filteredModelOptions,
  filteredSlashCommands,
  handleFileMentionKey,
  inputHistoryActive,
  messages,
  effortSelection,
  modelSelection,
  modeSelection,
  onExit,
  pasteClipboardImage,
  recallNextInput,
  recallPreviousInput,
  selection,
  setApprovalQueue,
  setDraftAttachments,
  setDraftValue,
  setEffortSelection,
  setModelSelection,
  setModeSelection,
  setSelection,
  setSlashSelection,
  setStatus,
  slashSelection,
  submitValue,
  switchMode,
  toggleSidebar,
  toggleSidebarSection,
}: UseTuiKeyboardControlsOptions): void {
  // 两个守卫都用 ref 而非 state：按键处理需要读最新值，且更新它们不应触发重渲染。
  const ctrlCExitGuardRef = useRef<CtrlCExitGuard>(createCtrlCExitGuard());
  const sidebarShortcutRef = useRef<SidebarShortcutState>(createSidebarShortcutState());

  // 订阅层只做一件事：把 useCallback 包装的分发器交给 useKeyboard，本层不注册其他监听，避免重复绑定导致一次按键双触发
  // 分发器用 useCallback 包裹，依赖表列出全部闭包字段；漏列会让处理器读到过期 state，多列会频繁重绑
  // 依赖表不包含 ref：两个守卫 ref 是稳定引用，放进依赖只会制造噪音并让人误以为需要重建
  // 回调内不做条件注册，所有优先级判断都收敛在函数体里，保证按键处理顺序可静态阅读、可单测覆盖
  // 卸载时由 useKeyboard 自行解绑；本层不保存订阅句柄，也不要改成手动监听，否则会出现多份处理器并存
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        // release 事件只表示松键，不承载动作；若处理会导致一次按键触发两遍。
        // release 事件只表示松键，不承载任何动作；必须在最前面返回，不能先做状态重置再判断
        // 若把 release 也当按下处理，同一次敲击会执行两遍，Ctrl-C 确认窗口会被自己提前推进
        // 这里直接裸 return 而不消费按键：松键放行给其他层，才能保证终端复位的默认行为不被影响
        // 判断依据是 eventType 而非按键名，事件类型才是区分按下与松键的稳定字段
        // 顺序要求：release 判断必须在只读视图与审批分支之前，否则独占态会把松键也一并吞掉
        if (key.eventType === "release") return;

        // 只读视图独占键盘：仅放行侧栏快捷键、返回、复制与滚动键，其余按键一律吞掉，
        // 防止在预览态误触输入框或弹出建议面板。
        // 只读视图存在即以独占方式接管键盘，这是全文件最高的业务优先级，先于审批与输入
        // 放行清单只有三类：侧栏快捷键、escape 返回、复制与滚动键；其余按键一律消费后 return
        // 滚动键白名单用数组判断，改错会让预览态无法翻页，或反过来漏掉对输入框的屏蔽
        // 进入分支先重置 Ctrl-C 退出守卫：只读态里按 Ctrl-C 不应累计退出确认次数
        // 该分支末尾必须 return，否则按键会继续落入审批与草稿逻辑，造成一次按键两个动作
        if (readOnlyView) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          if (
            handleSidebarShortcutKey({
              consumeKey,
              key,
              nowMs: Date.now(),
              setStatus,
              shortcutState: sidebarShortcutRef.current,
              toggleSidebar,
              toggleSidebarSection,
            })
          )
            return;
          if (key.name === "escape") {
            consumeKey(key);
            readOnlyView.back();
          } else if ((key.name === "c" || key.name === "y") && key.ctrl) {
            consumeKey(key);
            copyCurrentSelection();
          } else if (
            !["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)
          ) {
            consumeKey(key);
          }
          return;
        }

        // 审批是强独占：队列非空时任何按键都先消费，再交给审批处理器判定动作
        // 先消费再处理是刻意顺序：即使审批处理器不认这个键，也不能让它下传去编辑草稿
        // 队头即当前审批，只取第一个元素；不要遍历队列，多个审批由上层逐个出队推动
        // 进入分支重置退出守卫，避免用户在审批中连按 Ctrl-C 被计成退出确认
        // 审批处理完必须 return，让下一轮按键重新走完整优先级，而不是在本轮继续向下分发
        const approval = approvalQueue[0];
        if (approval) {
          // 审批态优先于一切普通输入：队列非空时必须先处理审批，避免用户输入被静默丢弃。
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleApprovalKey(key, approval, setApprovalQueue, setStatus);
          return;
        }

        // 文本选区激活时键盘属于选区，复制与取消都由选区处理器统一处理，不做二次分发
        // 分支内先消费再调用，避免选区处理器未覆盖的键漏到草稿层，出现边选边输入
        // 回调里只暴露中断输出的能力：选区处理需要能取消输出，但不掌握会话生命周期
        // 进入分支同样重置 Ctrl-C 守卫，保证选区态的 Ctrl-C 是取消而非累计退出
        // 处理完必须 return；漏掉会让方向键既移动选区又召回历史，两套状态互相打架
        if (selection) {
          // 文本选区激活时按键属于选区操作（复制/取消），不能同时进入输入框编辑。
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleSelectionKey(key, selection, setSelection, setStatus, submitValue, () => {
            abortControllerRef.current?.abort();
          });
          return;
        }

        if (
          handleSidebarShortcutKey({
            consumeKey,
            key,
            nowMs: Date.now(),
            setStatus,
            shortcutState: sidebarShortcutRef.current,
            toggleSidebar,
            toggleSidebarSection,
          })
        ) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          return;
        }

        // Ctrl-C 是三级语义链：先尝试复制选区，再判断是否清空草稿，最后才走两次确认退出
        // 复制成功要重置守卫并 return，否则用户复制一次就被计成一次退出确认，长会话容易误退
        // 有草稿时只清草稿与附件并给出状态提示，不退出：这是防误触丢内容的核心保护
        // 守卫判断放在最后，且只有意图解析返回确认值才真正中断输出并触发退出回调
        // 窗口外的再次按下由守卫自行重置为首次，本层不再重复计时，避免两套时间源打架
        if (key.name === "c" && key.ctrl) {
          consumeKey(key);
          // 有选区时 Ctrl-C 语义为“复制”，不进入清空草稿/退出流程。
          if (copyCurrentSelection()) {
            resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            return;
          }

          if (shouldClearPromptDraftOnCtrlC(draftValue)) {
            // 有草稿时 Ctrl-C 先清空草稿，避免误触直接退出丢失未提交内容。
            resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            setDraftValue("");
            setDraftAttachments([]);
            setStatus(PROMPT_DRAFT_CLEARED_STATUS);
            return;
          }

          // A single Ctrl-C used to exit immediately, which made long sessions easy to lose.
          if (resolveCtrlCExitIntent(ctrlCExitGuardRef.current, Date.now()) === "confirm_exit") {
            abortControllerRef.current?.abort();
            onExit(0);
            return;
          }

          setStatus(CTRL_C_EXIT_PROMPT);
          return;
        }

        resetCtrlCExitGuard(ctrlCExitGuardRef.current);

        if (key.name === "y" && key.ctrl) {
          consumeKey(key);
          if (!copyCurrentSelection()) setStatus("No selected text to copy.");
          return;
        }

        // Ctrl-R 只对 compact 重试有意义，因此先用时间线工具判断最近一条事件是否可重试
        // 不是可重试 compact 时完全不消费按键，让它继续下传，避免抢走输入框的默认行为
        // 命中后先消费再判 busy：忙时只提示不提交，防止同一会话并发出现两次提交
        // 提交时带保留选择态选项，保留原选择态才能让用户对同一条命令反复重试
        // 异步提交不阻塞等待，结果与错误由提交实现的提供方反馈到状态栏，本层不兜底
        if (key.name === "r" && key.ctrl) {
          // 仅当最近一条时间线事件是可重试的 compact 命令时才拦截 Ctrl-R，
          // 否则按键继续下传，避免占用输入框的默认行为。
          const compactRetryCommand = latestRetryableCompactCommand(messages);
          if (compactRetryCommand) {
            consumeKey(key);
            if (busy) {
              setStatus("Agent is still responding.");
              return;
            }
            void submitValue(compactRetryCommand, { preserveSelection: true });
            return;
          }
        }

        // Mode switching belongs to the composer, including while @ suggestions
        // are open; file completion must only receive the remaining Tab keys.
        if (isModeSwitchKey(key)) {
          consumeKey(key);
          void switchMode();
          return;
        }

        if (handleFileMentionKey(key)) {
          consumeKey(key);
          return;
        }

        // Tab 补全有严格唯一优先级：模型→力度→模式→斜杠，命中即关闭该面板并 return
        // 一次 Tab 只允许改写一次草稿；若去掉早返回，多层补全会把草稿叠加成非法命令
        // 每层补全成功后都要清空对应选择态，否则面板残留会让下一次 Escape 关错对象
        // 斜杠补全放在最后作为兜底层，它命中后不再单独 return，而是走到分支末尾统一返回
        // 进入 Tab 分支先消费按键：Tab 不能继续传给终端做焦点切换，否则会直接跳出 TUI
        if (key.name === "tab") {
          consumeKey(key);
          // Tab 补全有唯一优先级：模型 → 力度 → 模式 → 斜杠命令，命中即关闭对应选择态，
          // 保证一次 Tab 只改写一次草稿，不会叠加多类补全。
          if (completeModelCommand(filteredModelOptions, modelSelection, setDraftValue)) {
            setModelSelection(undefined);
            return;
          }
          if (completeEffortCommand(filteredEffortOptions, effortSelection, setDraftValue)) {
            setEffortSelection(undefined);
            return;
          }
          if (completeModeCommand(filteredModeOptions, modeSelection, setDraftValue)) {
            setModeSelection(undefined);
            return;
          }
          if (completeSlashCommand(filteredSlashCommands, slashSelection, setDraftValue)) {
            setSlashSelection(undefined);
          }
          return;
        }

        if (key.name === "escape") {
          consumeKey(key);
          // 依次关闭最外层可见的建议面板：一次 Escape 只关一个，避免误按一次丢失全部候选；
          // 无面板时才把 Escape 当作“暂停输出”。
          if (modelSelection) {
            setModelSelection(undefined);
            setStatus("Model suggestions dismissed.");
            return;
          }
          if (effortSelection) {
            setEffortSelection(undefined);
            setStatus("Effort suggestions dismissed.");
            return;
          }
          if (modeSelection) {
            setModeSelection(undefined);
            setStatus("Mode suggestions dismissed.");
            return;
          }
          if (slashSelection) {
            setSlashSelection(undefined);
            setStatus("Slash suggestions dismissed.");
            return;
          }
          if (busy) {
            abortControllerRef.current?.abort();
            setStatus("Pausing current output...");
            return;
          }
          // 空闲时按 Escape 给出可操作提示，而不是静默消费，用户才知道退出方式。
          setStatus("No active output to pause. Press Ctrl-C twice to exit.");
          return;
        }

        // 方向键优先用于建议面板导航；无面板可移动时才落到输入历史召回。
        if (
          handleSuggestionNavigationKey({
            consumeKey,
            effortSelection,
            filteredEffortOptions,
            filteredModeOptions,
            filteredModelOptions,
            filteredSlashCommands,
            key,
            modelSelection,
            modeSelection,
            setEffortSelection,
            setModeSelection,
            setModelSelection,
            setSlashSelection,
            slashSelection,
          })
        ) {
          return;
        }

        if (
          key.name === "up" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          // 上下键在无建议面板时用于历史召回；草稿非空时不触发，避免覆盖用户正在输入的内容。
          consumeKey(key);
          void recallPreviousInput();
          return;
        }

        if (
          key.name === "down" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallNextInput();
          return;
        }

        // `+` / `-` 展开/收起全部 workflow 卡（spec 无卡片选择机制，只能作用于全体）。
        // 键位与两层闸门（草稿为空 + 至少一张卡）全部收在纯函数里，直接可测。
        const workflowExpansionKey = workflowExpansionActionFor({
          key,
          draftValue,
          hasCards: workflowExpansion?.hasCards ?? false,
        });
        if (workflowExpansionKey && workflowExpansion) {
          consumeKey(key);
          if (workflowExpansionKey === "expand") workflowExpansion.expandAll();
          else workflowExpansion.collapseAll();
          return;
        }

        if (key.name === "u" && key.ctrl) {
          consumeKey(key);
          // Ctrl-U 无条件清空草稿与附件，不需要二次确认（与 Ctrl-C 的退出语义区分）。
          setDraftValue("");
          setDraftAttachments([]);
          setStatus(PROMPT_DRAFT_CLEARED_STATUS);
          return;
        }

        if ((key.name === "v" && (key.ctrl || key.meta)) || key.raw === "\x16") {
          // 兼容 raw 控制字符：部分终端/系统下 Ctrl-V 只上报 \x16 而不带 ctrl 修饰位。
          consumeKey(key);
          void pasteClipboardImage();
        }
      },
      [
        readOnlyView,
        abortControllerRef,
        approvalQueue,
        workflowExpansion,
        busy,
        copyCurrentSelection,
        draftValue,
        effortSelection,
        filteredEffortOptions,
        filteredModeOptions,
        filteredModelOptions,
        filteredSlashCommands,
        handleFileMentionKey,
        inputHistoryActive,
        messages,
        modelSelection,
        modeSelection,
        onExit,
        pasteClipboardImage,
        recallNextInput,
        recallPreviousInput,
        selection,
        setApprovalQueue,
        setDraftAttachments,
        setDraftValue,
        setEffortSelection,
        setModelSelection,
        setModeSelection,
        setSelection,
        setSlashSelection,
        setStatus,
        slashSelection,
        submitValue,
        switchMode,
        toggleSidebar,
        toggleSidebarSection,
      ],
    ),
  );
}

// 统一的按键消费口：同时阻止默认行为与事件冒泡，保证一次按键只触发一个动作。
function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}
