// 输入区键盘辅助纯函数（L2）：命令补全、历史导航闸门、模式切换、workflow 展收、Ctrl-C 二次确认。
// 全部无 IO：补全通过注入的 setDraftValue 写草稿，Ctrl-C 守卫通过可变对象携带"上次按键时间"。
// 返回 boolean 的判定函数语义统一：true = 按键已被消费（调用方不要再处理），false = 放行。
import type { KeyEvent } from "@mbears/opentui-core";
import { clampIndex } from "./app-input.js";
import { modelOptionValue } from "./app-model-ref.js";
import type {
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

// 返回 true 表示草稿已被改写，调用方应停止后续按键处理，避免 Tab 又被用于模式切换。
// 写入的尾空格是命令参数入口约定，删掉会导致后续输入与命令名粘连。
// Tab 补全斜杠命令：把草稿替换为 "/name "（带尾空格），返回是否消费了按键。
// 无选择态或候选为空时不消费，让 Tab 保持默认行为（模式切换）。
export function completeSlashCommand(
  commands: readonly SlashCommand[],
  slashSelection: SlashSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!slashSelection || commands.length === 0) return false;
  const command = commands[clampIndex(slashSelection.selectedIndex, commands.length)];
  if (!command) return false;
  setDraftValue(`/${command.name} `);
  return true;
}

// 与斜杠补全不同，这里刻意不带尾空格：模型值后可直接回车提交。
// 写入值使用 modelOptionValue（provider/model），与命令解析口径一致。
// Tab 补全模型命令：写入 "/model <optionValue>"（不带尾空格，便于直接回车提交）。
// 无选择态或候选为空时返回 false（不消费）。
export function completeModelCommand(
  models: readonly TuiModelOption[],
  modelSelection: ModelCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!modelSelection || models.length === 0) return false;
  const model = models[clampIndex(modelSelection.selectedIndex, models.length)];
  if (!model) return false;
  setDraftValue(`/model ${modelOptionValue(model)}`);
  return true;
}

// 只有真正写入草稿时才返回 true；候选缺失时不写内容，也不改状态栏。
// /variant 输入被归一化为 /effort，保证提交侧只认一种命令名。
// Tab 补全 effort：统一写成 "/effort <id>"（即使用户从 /variant 进入，也归一化到主命令）。
// 无选择态或候选为空时返回 false。
export function completeEffortCommand(
  efforts: readonly TuiEffortOption[],
  effortSelection: EffortCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!effortSelection || efforts.length === 0) return false;
  const effort = efforts[clampIndex(effortSelection.selectedIndex, efforts.length)];
  if (!effort) return false;
  setDraftValue(`/effort ${effort.id}`);
  return true;
}

// 与模型/effort 一致，写入 "/mode <id>"，id 来自 TuiModeOption 而非展示 label。
// 空候选时不消费按键，交由默认 Tab 行为处理。
// Tab 补全模式命令：写入 "/mode <id>"；无选择态或候选为空时返回 false。
export function completeModeCommand(
  modes: readonly TuiModeOption[],
  modeSelection: ModeCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!modeSelection || modes.length === 0) return false;
  const mode = modes[clampIndex(modeSelection.selectedIndex, modes.length)];
  if (!mode) return false;
  setDraftValue(`/mode ${mode.id}`);
  return true;
}

// 只看草稿是否为空与是否处于回溯态，不关心历史源是否存在（无源时由 recall 写状态栏）。
// 返回 true 只表示 up/down 应交给历史 hook，最终是否消费由 hook 自身决定。
// up/down 是否用于历史回溯：正在回溯中，或草稿为空。
// 草稿非空且不在回溯态时不拦截，保证多行编辑里上下键仍能移动光标。
export function shouldHandleInputHistoryNavigation({
  draftValue,
  inputHistoryActive,
}: {
  draftValue: string;
  inputHistoryActive: boolean;
}): boolean {
  // model streaming output still leaves the composer editable; blocking
  // on busy made history recall unavailable exactly when users queue followups.
  return inputHistoryActive || draftValue.length === 0;
}

// 只认 name=tab 且 shift=true，ctrl/meta 组合不在此列。
// 调用方需在 Tab 补全之前判断，否则补全消费按键后模式切换永远不可达。
// 模式切换键：Shift+Tab（tab 且 shift 为真）；单独 Tab 归补全逻辑处理。
export function isModeSwitchKey(key: KeyEvent): boolean {
  return key.name === "tab" && key.shift;
}

/**
 * `+` / `-` 展开/收起全部 workflow 卡的**完整**判定（键位 + 两层闸门），导出为纯函数以便直接测试。
 * 键位：无修饰键的裸 `+` / `-`；Ctrl/Meta 组合另有归属，一律不认。
 * 闸门：草稿必须为空，且至少有一张 workflow 卡——否则这两个键必须照常打进草稿
 * （粘一段 diff 时第一个字符就是 +/-，吃掉它就是把输入弄坏）。
 * 返回值：undefined 表示不消费按键，交由 textarea 正常输入；否则返回对应动作。
 */
export function workflowExpansionActionFor({
  key,
  draftValue,
  hasCards,
}: {
  key: KeyEvent;
  draftValue: string;
  hasCards: boolean;
}): "expand" | "collapse" | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (draftValue.length > 0 || !hasCards) return undefined;
  const char = key.name ?? key.raw;
  // 只认字面 +/-；其余字符（以及被修饰键占用的组合）放行。
  if (char === "+") return "expand";
  if (char === "-") return "collapse";
  return undefined;
}

// Ctrl-C 后输入区复位用的状态栏文案：草稿被清空时回落到 "Ready."。
export const PROMPT_DRAFT_CLEARED_STATUS = "Ready.";
// 第一次 Ctrl-C 的提示语，以及第二次按键必须落在该时间窗内才真正退出（单位：毫秒）。
export const CTRL_C_EXIT_PROMPT = "Press Ctrl-C again to exit.";
// 单位毫秒；窗口内再次按 Ctrl-C 才退出，超窗则重新提示并把时间戳刷新为本次按键。
// 调大窗口更容易误触退出，调小则二次确认形同虚设，默认 2s 是交互平衡点。
export const CTRL_C_EXIT_CONFIRMATION_WINDOW_MS = 2_000;

// 纯函数，仅比较长度；非空即视为有可丢弃草稿，不判断内容是否是命令。
// 返回 false 时调用方进入退出确认流程，而不是直接退出。
// Ctrl-C 是否应先清空草稿而不是退出：草稿非空就清空（返回 true），空草稿才进入退出确认流程。
export function shouldClearPromptDraftOnCtrlC(draftValue: string): boolean {
  return draftValue.length > 0;
}

// Ctrl-C 二次确认状态：只保存上一次按键的单调时间；undefined 表示"当前没有待确认的退出"。
// 该对象由调用方持有并原地修改，guard 的写入是 resolve/reset 的副作用。
export type CtrlCExitGuard = {
  // 上一次 Ctrl-C 的时间戳（毫秒，单调时钟）；undefined = 无待确认退出。
  lastPressAtMs: number | undefined;
};

// 退出意图：confirm_exit 表示应真正退出；show_prompt 表示只提示"再按一次"。
type CtrlCExitIntent = "confirm_exit" | "show_prompt";

// 每次创建都是全新对象，不复用模块级状态，便于测试注入独立 guard。
// 调用方负责持有该对象，并在非 Ctrl-C 按键时调用 reset。
// 创建初始守卫（无待确认退出）。
export function createCtrlCExitGuard(): CtrlCExitGuard {
  return { lastPressAtMs: undefined };
}

// 判定一次 Ctrl-C 的意图，并原地更新守卫：
// - 距上次按键在 (0, windowMs] 内 → 返回 confirm_exit 并清空守卫（一次性）；
// - 否则（首次 / 超窗 / 时钟回拨 elapsed<0）→ 记录本次时间并返回 show_prompt。
// 时钟回拨被归入"重新提示"，避免负差值误判为确认退出。
export function resolveCtrlCExitIntent(
  guard: CtrlCExitGuard,
  nowMs: number,
  windowMs = CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
): CtrlCExitIntent {
  const lastPressAtMs = guard.lastPressAtMs;
  const elapsedMs = lastPressAtMs === undefined ? undefined : nowMs - lastPressAtMs;
  // 确认退出后立即清空，防止第三次按键被当作再次确认（守卫是一次性的）。
  if (elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs <= windowMs) {
    guard.lastPressAtMs = undefined;
    return "confirm_exit";
  }

  guard.lastPressAtMs = nowMs;
  return "show_prompt";
}

// 幂等操作：重复调用不报错，也不会产生额外副作用。
// 复位后下一次 Ctrl-C 总是先显示提示，不会直接退出。
// 复位守卫：任何其他按键/状态变化都应调用，撤销待确认的退出提示。
export function resetCtrlCExitGuard(guard: CtrlCExitGuard): void {
  guard.lastPressAtMs = undefined;
}
