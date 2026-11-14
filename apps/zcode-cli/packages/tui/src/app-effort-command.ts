// effort（推理强度）命令控制器（L2）：维护 /effort 选择态，并从草稿派生过滤后的候选。
// selection 只是 TUI 局部交互态（光标/当前弹窗选择），不属于业务状态；提交值由父层通过 selectedOption 取。
// 无 IO / 无持久化；过滤与对账全部复用 app-input.ts 的纯函数。
import React from "react";
import {
  filterEffortOptions,
  reconcileEffortCommandSelection,
  selectedEffortOption,
} from "./app-input.js";
import type { EffortCommandSelectionState } from "./app-model.js";
import type { TuiEffortOption } from "./types.js";

// manifest 返回各字段口径：
// - filteredOptions：按 draft 过滤后的候选；draft 不是 /effort|/variant 前缀时为空数组；
// - reconcileDraft：用新草稿重算选择态，返回 undefined 表示面板应关闭；
// - selectedOption：提交时按选择态取候选，草稿已不匹配命令前缀时返回 undefined；
// - selection/setSelection：供键盘上下移动的本地状态。
// selection 不会随 draft 自动重置，调用方需在提交/清空时自行 setSelection(undefined)。
export function useEffortCommandController(
  draft: string,
  effortOptions: readonly TuiEffortOption[],
): {
  filteredOptions: readonly TuiEffortOption[];
  reconcileDraft: (value: string) => EffortCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiEffortOption | undefined;
  selection: EffortCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<EffortCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<EffortCommandSelectionState | undefined>();
  // 过滤结果按 draft/候选列表缓存，避免每次按键都重算全量匹配。
  const filteredOptions = React.useMemo(
    () => filterEffortOptions(draft, effortOptions),
    [draft, effortOptions],
  );
  const reconcileDraft = React.useCallback(
    (value: string) => {
      const nextSelection = reconcileEffortCommandSelection(value, effortOptions);
      setSelection(nextSelection);
      return nextSelection;
    },
    [effortOptions],
  );
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedEffortOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
  };
}
