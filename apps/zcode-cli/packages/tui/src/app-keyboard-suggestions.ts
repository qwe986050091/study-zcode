// 建议列表方向键导航（L2）：统一处理模型/力度/模式/斜杠四类候选面板的 up/down 移动。
// 只更新 TUI 临时选中态并通过 consumeKey 消费按键，不发起提交、不读写业务状态。
// 面板优先级固定为 model → effort → mode → slash，同一时刻最多一个生效。
import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, SetStateAction } from "react";
import { clampIndex } from "./app-input.js";
import type {
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

type SelectionWithIndex = {
  selectedIndex: number;
};

type NavigationDelta = -1 | 1;

type SuggestionNavigationInput = {
  consumeKey: (key: KeyEvent) => void;
  effortSelection: EffortCommandSelectionState | undefined;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  key: KeyEvent;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  slashSelection: SlashSelectionState | undefined;
};

// 统一处理建议列表（模型/力度/模式/斜杠命令）的上下方向键导航。
// 输入：当前按键与四类选择态及对应的已过滤选项集合；选项集合为空视为该类不可导航。
// 输出：true 表示本函数已消费该按键并阻止其继续向输入框冒泡，false 表示交给后续处理器。
// 优先级固定为 model → effort → mode → slash：同一时刻最多只有一个面板处于激活态，
// 因此按固定顺序探测即可，不依赖额外的“当前面板”标记。
// 副作用：仅通过 setXxxSelection 更新选中下标（React 状态），不发起任何 IO 或事件。
// 不变量：selectedIndex 始终由 clampIndex 约束在 [0, optionCount-1]，越界回绕由 clampIndex 决定。
export function handleSuggestionNavigationKey(input: SuggestionNavigationInput): boolean {
  const delta = suggestionNavigationDelta(input.key);
  if (delta === undefined) return false;

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredModelOptions.length,
      selection: input.modelSelection,
      setSelection: input.setModelSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredEffortOptions.length,
      selection: input.effortSelection,
      setSelection: input.setEffortSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredModeOptions.length,
      selection: input.modeSelection,
      setSelection: input.setModeSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredSlashCommands.length,
      selection: input.slashSelection,
      setSelection: input.setSlashSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  return false;
}

// 把方向键翻译成索引增量；非上下键返回 undefined，表示本处理器不关心该按键。
function suggestionNavigationDelta(key: KeyEvent): NavigationDelta | undefined {
  if (key.name === "up") return -1;
  if (key.name === "down") return 1;
  return undefined;
}

// 对单个选择态执行一次移动：无可移动对象（选择态缺失或选项数为 0）时返回 false，
// 让调用方继续尝试下一个面板；移动成功返回 true 并交由上层消费按键。
function moveSuggestion<TSelection extends SelectionWithIndex>({
  delta,
  optionCount,
  selection,
  setSelection,
}: {
  delta: NavigationDelta;
  optionCount: number;
  selection: TSelection | undefined;
  setSelection: Dispatch<SetStateAction<TSelection | undefined>>;
}): boolean {
  if (!selection || optionCount <= 0) return false;
  setSelection({
    ...selection,
    selectedIndex: clampIndex(selection.selectedIndex + delta, optionCount),
  });
  return true;
}
