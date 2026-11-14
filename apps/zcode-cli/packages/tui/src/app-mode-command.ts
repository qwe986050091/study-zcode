// /mode 命令的草稿解析与建议面板控制器。
// 职责：识别草稿中的 /mode 查询、过滤模式候选、维护本地选中态。
// 边界：只处理输入文本与临时 UI 选择，不执行会话侧的模式切换。
// 副作用：hook 内仅本地 React 状态，无 IO、不写会话。
// 失败语义：非命令上下文或空候选返回空数组/undefined，面板据此关闭。

import React from "react";
import type { ModeCommandSelectionState } from "./app-model.js";
import { TUI_SWITCHABLE_MODES, type TuiSwitchableMode } from "./app-mode.js";
import { matchesText } from "./state.js";
import type { TuiModeOption } from "./types.js";

const MODE_COMMAND_NAME = "/mode";
const MODE_COMMAND_WITH_SPACE = `${MODE_COMMAND_NAME} `;

// 各模式的展示说明；键类型限定为可切换模式，新增模式时编译期即要求补齐文案。
const MODE_DESCRIPTIONS: Record<TuiSwitchableMode, string> = {
  build: "Ask before each file changes.",
  plan: "Inspect the code and present a plan before editing.",
  yolo: "Edit and run commands with fewer confirmations.",
  guarded: "Full access with single-use confirmation for explicit dangerous commands.",
};

const TUI_MODE_OPTIONS: readonly TuiModeOption[] = TUI_SWITCHABLE_MODES.map((mode) => ({
  description: MODE_DESCRIPTIONS[mode],
  id: mode,
  label: formatModeLabel(mode),
}));

// 解析草稿中的 /mode 查询串，作为建议面板的过滤条件。
// 返回：undefined = 当前草稿不属于 /mode 上下文（面板应关闭）；
// "" = 已输入 /mode 但尚未输入查询（展示全部模式）；
// 其余为待匹配的查询文本（已去掉 "/mode " 前缀）。
// 口径：仅 "/mode" 或 "/mode " 前缀有效，"/modeX" 这类紧邻字符只在构成合法模式前缀时才识别，
// 避免把普通输入误判为命令；无空白的分支用于支持 "/modebu" 这种紧凑输入。
export function modeCommandQuery(draft: string): string | undefined {
  if (draft === MODE_COMMAND_NAME) return "";
  if (draft.startsWith(MODE_COMMAND_WITH_SPACE)) {
    return draft.slice(MODE_COMMAND_WITH_SPACE.length);
  }
  if (draft.startsWith(MODE_COMMAND_NAME) && !/\s/u.test(draft)) {
    const compactQuery = draft.slice(MODE_COMMAND_NAME.length);
    return isCompactModeQuery(compactQuery) ? compactQuery : undefined;
  }
  return undefined;
}

// 按草稿查询过滤模式候选；非 /mode 上下文或无匹配时返回空数组（面板据此关闭）。
// 匹配字段含 id、展示名、说明与 "/mode <id>" 形式，支持匹配说明文字里的关键词。
// 副作用：无，纯函数；返回的是共享常量数组的过滤副本，调用方不应原地修改。
export function filterModeOptions(draft: string): readonly TuiModeOption[] {
  const query = modeCommandQuery(draft);
  // 区分“不在命令上下文”（undefined）与“空查询”（""）：前者无候选，后者展示全部。
  if (query === undefined) return [];
  return TUI_MODE_OPTIONS.filter((mode) =>
    matchesText(query, [
      mode.id,
      mode.label,
      mode.description,
      `${MODE_COMMAND_WITH_SPACE}${mode.id}`,
    ]),
  );
}

// 依据草稿重建选择态：进入 /mode 上下文时默认选中第 0 项，离开则收敛为 undefined。
// 用于草稿变化后校正选中项，避免保留已失效的索引。
function reconcileModeCommandSelection(draft: string): ModeCommandSelectionState | undefined {
  return modeCommandQuery(draft) !== undefined ? { selectedIndex: 0 } : undefined;
}

// 从提交值 + 当前选择态解析用户最终选中的模式。
// 返回 undefined 的情形：无选择态、提交值已不在 /mode 上下文、候选为空（均视为未选中）。
// 索引口径：对 selectedIndex 做双端夹取到 [0, modes.length-1]，防止过滤后候选变少导致越界。
export function selectedModeOption(
  submittedValue: string,
  modeSelection: ModeCommandSelectionState | undefined,
  modes: readonly TuiModeOption[],
): TuiModeOption | undefined {
  if (!modeSelection || modeCommandQuery(submittedValue) === undefined || modes.length === 0) {
    return undefined;
  }
  return modes[Math.max(0, Math.min(modeSelection.selectedIndex, modes.length - 1))];
}

// /mode 建议面板的控制器 hook：把无状态的过滤/解析函数绑定到 React 状态。
// 输入：当前草稿文本；输出：过滤候选、选择态及其 setter、草稿校正函数与提交时的选中项解析。
// 副作用：仅本地 useState/useMemo/useCallback，不发起 IO；filteredOptions 随 draft 变化重算。
// 口径：reconcileDraft 返回新选择态并同步写入 state，调用方可直接用返回值判断面板是否激活。
export function useModeCommandController(draft: string): {
  filteredOptions: readonly TuiModeOption[];
  reconcileDraft: (value: string) => ModeCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModeOption | undefined;
  selection: ModeCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModeCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<ModeCommandSelectionState | undefined>();
  const filteredOptions = React.useMemo(() => filterModeOptions(draft), [draft]);
  const reconcileDraft = React.useCallback((value: string) => {
    const nextSelection = reconcileModeCommandSelection(value);
    setSelection(nextSelection);
    return nextSelection;
  }, []);
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModeOption(submittedValue, selection, filteredOptions),
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

// 首字母大写展示模式名；空串原样返回，避免生成仅含 "undefined" 的错误文案。
function formatModeLabel(mode: TuiSwitchableMode): string {
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}

// 判断紧凑查询（无空格的 "/modebu"）是否为任一模式 id/展示名的前缀；
// 只有命中前缀才将其视为 /mode 命令，否则留给普通文本输入，避免误吞用户内容。
function isCompactModeQuery(query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return TUI_MODE_OPTIONS.some(
    (mode) =>
      mode.id.startsWith(normalizedQuery) || mode.label.toLowerCase().startsWith(normalizedQuery),
  );
}
