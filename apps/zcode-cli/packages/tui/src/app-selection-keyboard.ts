// INV-01 三态分发自上而下且互斥：守住位置 handleSelectionKey 的两次早退；改错故障 等待态按键被列表逻辑吞掉。
// INV-02 等待态只认 Escape：守住位置 handlePendingSelectionKey 的早退；改错故障 请求飞行中还能翻列表。
// INV-03 输入态抢占全部按键：守住位置 selection.input 分支；改错故障 输入参数时退格删掉过滤串。
// INV-04 Escape 语义分级：列表态整体关闭，输入/等待态只退一级；守住位置 三处 escape 分支；改错故障 一次误按丢掉整轮输入。
// INV-05 过滤串变更必须把 selectedIndex 归零：守住位置 三处 selectedIndex: 0；改错故障 旧下标指向新集合里的错误条目。
// INV-06 下标统一走 clampIndex：守住位置 上下移动与提交取值；改错故障 过滤后越界取到 undefined。
// INV-07 不可过滤集合不消费字符与退格：守住位置 filterable === false 判断；改错故障 字符被吞，用户无法输入。
// INV-08 空候选只提示不提交：守住位置 submitSelectedItem 的 !item 分支；改错故障 提交空命令。
// INV-09 禁用项只展示原因：守住位置 disabledReason 分支；改错故障 禁用命令被执行。
// INV-10 提交三路径互斥：输入态、等待态、普通命令；守住位置 submitSelectedItem 的三个分支；改错故障 两种流程叠加。
// INV-11 空白输入不提交且保留输入态：守住位置 value.trim() 判定；改错故障 提交空参数并关闭选区。
// INV-12 提交即发即忘：守住位置 void submitValue；改错故障 失败无人观察且阻塞渲染。
// INV-13 可见窗口跟随选中项：守住位置 visibleSelectionItemWindow 的 startIndex；改错故障 翻页后高亮停在首屏。
// INV-14 脱敏只影响展示：守住位置 selectionInputDisplayValue；改错故障 星号被当成提交内容。
// INV-15 删字符按码点：守住位置 Array.from；改错故障 emoji 被拆成半个代理对。
//
// 模块职责：按 pending / input / 列表三态分发按键，完成过滤、选中推进与提交。
// 阅读顺序：先看三态早退，再看列表移动与过滤，最后看提交三分支与展示辅助。
// 通用选区弹层的键盘处理。
// 职责：按 pending / input / 列表三态分发按键，完成过滤、选中推进与提交。
// 边界：只维护临时选择态，不执行命令本身，提交统一交给 submitValue。
// 副作用：写 React 状态，并可能触发提交/取消回调（即发即忘）。
// 降级：空候选只提示不提交；禁用项仅展示原因；不可过滤集合不消费字符键。

import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { SelectionState, SubmitValueOptions } from "./app-model.js";
import { matchesText } from "./state.js";
import type { TuiSelectionItem } from "./types.js";

const DEFAULT_INPUT_CANCEL_STATUS = "Input cancelled.";
const DEFAULT_INPUT_EMPTY_STATUS = "Input is required.";
const DEFAULT_INPUT_CLEAR_STATUS = "Input cleared.";
const DEFAULT_PENDING_CANCEL_STATUS = "Selection cancelled.";
const DEFAULT_FILTER_CLEAR_STATUS = "Selection filter cleared.";
const INPUT_COMMAND_SEPARATOR = " ";
const MASK_CHAR = "*";
const MAX_MASK_WIDTH = 24;
const CONTROL_KEY_NAMES = new Set([
  "backspace",
  "delete",
  "down",
  "end",
  "escape",
  "home",
  "left",
  "pagedown",
  "pageup",
  "return",
  "right",
  "tab",
  "up",
]);

// 按当前过滤串过滤选区委条目，决定面板实际展示与可导航的集合。
// 输入：selection.filterable === false 时不做过滤，直接返回 items 的浅拷贝（保证调用方拿到的
// 是独立数组，但仍不能原地修改条目对象）；filter 为空串时 matchesText 视为全匹配。
// 输出：过滤后的条目数组；无匹配时为空数组（空集合不是 undefined）。
// 匹配字段：主副标题、meta、命令名、输入态标题与 keywords；input 缺失时这些字段忽略。
// 副作用：无，纯函数，不修改入参。
// 不可过滤时返回浅拷贝，调用方不会意外改动 selection.items 本身。
// 匹配字段覆盖主副标题、meta、命令名与 keywords，input 缺失项自动跳过。
export function filterSelectionItems(selection: SelectionState): TuiSelectionItem[] {
  if (selection.filterable === false) return [...selection.items];
  return selection.items.filter((item) =>
    matchesText(selection.filter, [
      item.primary,
      item.secondary,
      item.meta,
      item.command,
      item.input?.primary,
      item.input?.secondary,
      ...(item.keywords ?? []),
    ]),
  );
}

// 入参 index 不做取整：负数、越界值与小数都按 Math.min/Math.max 原样夹取，调用方需自行保证整数。
// 输出可直接作为数组下标（length > 0 时恒落在 [0, len-1]）；本函数无副作用，不改任何选中态。
// 把任意下标夹到 [0, length-1]；length <= 0 时返回 0（调用方必须自行判断空集合）。
// 用于所有“选中下标”读写，是防止过滤后候选变少导致越界的唯一入口。
// length<=0 返回 0 只是空集合的占位，调用方仍须自己判断是否有候选。
// 上下移动与提交取值都走这里，避免过滤后长度变化造成越界。
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

// selectedIndex is global within the filtered rows, so the rendered
// slice must follow it instead of always drawing the first page.
// 输出语义：selectedIndex 为相对可见窗口的下标（0-based），startIndex 为窗口起点；
// 空集合或 maxVisible<=0 时返回空窗口（selectedIndex/startIndex 均为 0），调用方无需特判 null。
// 先夹选中项再算起点，maxStartIndex 保证窗口不会越过尾部。
// 返回的 selectedIndex 是相对窗口的下标，渲染层可直接使用。
// 空集合与 maxVisible<=0 都返回空窗口，调用方无需判 null。
export function visibleSelectionItemWindow(
  items: readonly TuiSelectionItem[],
  selectedIndex: number,
  maxVisible: number,
): {
  items: readonly TuiSelectionItem[];
  selectedIndex: number;
  startIndex: number;
} {
  if (items.length === 0 || maxVisible <= 0) {
    return {
      items: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, items.length);
  const visibleCount = Math.min(maxVisible, items.length);
  const maxStartIndex = items.length - visibleCount;
  const startIndex = Math.min(
    Math.max(0, clampedSelectedIndex - visibleCount + 1),
    maxStartIndex,
  );

  return {
    items: items.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// 选区委的键盘分发：等待异步候选 → 输入参数 → 正常列表浏览三种态，优先级自上而下。
// 输入：selection 必须存在（由上层保证）；cancelPendingSelection 可选，用于通知后端取消请求。
// 输出：无返回值；通过 setSelection/setStatus 反馈，提交类动作调用 submitValue（即发即忘）。
// 副作用：写 React 状态；提交/取消可能触发业务请求；本函数不持久化、不写日志。
// 口径：Escape 在列表态直接关闭整个选区，在输入/等待态只退回上一态，逐级退出而不误关。
// 不变量：过滤串变化时 selectedIndex 必须重置为 0，避免旧下标指向新集合中的错误条目。
export function handleSelectionKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
  cancelPendingSelection?: () => void,
): void {
  if (selection.pending) {
    // 等待后端候选期间只接受 Escape 取消，其余按键不排队，避免请求回来前的输入行为不确定。
    handlePendingSelectionKey(key, selection, setSelection, setStatus, cancelPendingSelection);
    return;
  }

  if (selection.input) {
    // 进入参数输入态后所有按键归输入框，不能再触发列表导航或重新过滤。
    handleSelectionInputKey(key, selection, setSelection, setStatus, submitValue);
    return;
  }

  if (key.name === "escape") {
    // 列表态 Escape = 整体取消选区（不是清空过滤串），与输入/等待态的逐级退出语义不同。
    setSelection(undefined);
    setStatus("Selection cancelled.");
    return;
  }

  const visible = filterSelectionItems(selection);
  if (key.name === "up") {
    setSelection((current) =>
      current
        ? { ...current, selectedIndex: clampIndex(current.selectedIndex - 1, visible.length) }
        : current,
    );
    return;
  }
  if (key.name === "down") {
    setSelection((current) =>
      current
        ? { ...current, selectedIndex: clampIndex(current.selectedIndex + 1, visible.length) }
        : current,
    );
    return;
  }
  if (key.name === "backspace") {
    // 不可过滤的选区委不消费退格，避免用户以为可以删除过滤串却无效。
    if (selection.filterable === false) return;
    setSelection((current) =>
      // 过滤串缩短后候选集合变化，选中下标必须归零，不能沿用旧位置。
      current ? { ...current, filter: current.filter.slice(0, -1), selectedIndex: 0 } : current,
    );
    return;
  }
  if (key.name === "u" && key.ctrl) {
    if (selection.filterable === false) return;
    setSelection((current) => (current ? { ...current, filter: "", selectedIndex: 0 } : current));
    setStatus(DEFAULT_FILTER_CLEAR_STATUS);
    return;
  }
  if (key.name === "return") {
    submitSelectedItem(selection, visible, setSelection, setStatus, submitValue);
    return;
  }

  const character = printableKey(key);
  // 仅可过滤的选区委把字符追加到过滤串；不可过滤时字符按键交回下层（例如输入框）。
  if (character && selection.filterable !== false) {
    setSelection((current) =>
      current ? { ...current, filter: `${current.filter}${character}`, selectedIndex: 0 } : current,
    );
  }
}

// 从按键提取可打印字符，用于过滤串与“其他”答案输入。
// 返回 undefined 的情形：带 ctrl/meta 修饰、控制键名、空序列或序列中含不可打印字符。
// 口径：space 统一映射为 " "；单字符键名优先，shift 时转大写；否则回落到 sequence 的单字符。
// ctrl/meta 一律拒绝，避免 Ctrl-U 之类被当成字符追加。
// 单字符键名优先于 sequence，shift 时转大写，其余回落到 sequence。
export function printableKey(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (key.name === "space") return " ";
  if (key.name.length === 1 && key.name >= " ") {
    return key.shift ? key.name.toUpperCase() : key.name;
  }
  if (key.sequence.length === 1 && key.sequence >= " ") return key.sequence;
  return undefined;
}

// 输入：placeholder 缺失时回退空串，保证返回值恒为 string，调用方无需再做 null/undefined 判断。
// 注意：mask 宽度按字符数而非终端显示列宽计算，CJK/emoji 与真实占宽不一致，仅作视觉遮蔽。
// 计算输入态展示值：空值显示 placeholder；mask 为真时把内容替换为等长（最多 24 个）星号。
// 输出为纯展示字符串，不参与提交；超过 24 字符时用 "..." 后缀提示仍有隐藏内容。
// mask 宽度按字符数而非终端显示列宽，CJK 与 emoji 的真实占宽并不一致。
// 超过 24 字符追加省略号，只作提示，不参与提交。
export function selectionInputDisplayValue(input: NonNullable<SelectionState["input"]>): string {
  if (!input.value) return input.placeholder ?? "";
  if (!input.mask) return input.value;
  const maskWidth = Math.min(input.value.length, MAX_MASK_WIDTH);
  const suffix = input.value.length > MAX_MASK_WIDTH ? "..." : "";
  return `${MASK_CHAR.repeat(maskWidth)}${suffix}`;
}

// 等待候选态：仅 Escape 生效，先通知取消（可选回调）再清 pending 并提示；
// 其它按键被忽略而不是下传，避免与仍在飞行中的请求产生竞争。
function handlePendingSelectionKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  cancelPendingSelection?: () => void,
): void {
  if (key.name !== "escape") return;
  cancelPendingSelection?.();
  const cancelStatus = selection.pending?.cancelStatus ?? DEFAULT_PENDING_CANCEL_STATUS;
  setSelection((current) => (current ? { ...current, pending: undefined } : current));
  setStatus(cancelStatus);
}

// 参数输入态：字符追加、退格删除、Ctrl-U 清空、Enter 提交、Escape 退回。
// 副作用：写 selection.input.value；提交时清空选区委并调用 submitValue（不 await）。
// Enter 提交格式为「命令 + 空格 + 值」，与普通命令文本同构。
// 退格与 Ctrl-U 只改 input.value，不动过滤串与选中项。
function handleSelectionInputKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
): void {
  const input = selection.input;
  if (!input) return;

  if (key.name === "escape") {
    // 输入态 Escape 只退回列表（清空 input），保留选区委本身，符合“逐级退出”。
    setSelection((current) => (current ? { ...current, input: undefined } : current));
    setStatus(input.cancelStatus ?? DEFAULT_INPUT_CANCEL_STATUS);
    return;
  }
  if (key.name === "return") {
    const value = input.value.trim();
    // 空白输入不允许提交；提示后保留输入态，让用户继续编辑而不是丢失已输入内容。
    if (!value) {
      setStatus(input.emptyStatus ?? DEFAULT_INPUT_EMPTY_STATUS);
      return;
    }
    setSelection(undefined);
    setStatus(input.submitStatus ?? `Selected ${input.primary}.`);
    // 提交值格式为 "<command> <value>"，与普通命令文本同构，交由统一 submitValue 处理。
    void submitValue(`${input.command}${INPUT_COMMAND_SEPARATOR}${value}`);
    return;
  }
  if (key.name === "backspace") {
    setSelection((current) =>
      current
        ? { ...current, input: { ...input, value: removeLastCharacter(input.value) } }
        : current,
    );
    return;
  }
  if (key.name === "u" && key.ctrl) {
    setSelection((current) => (current ? { ...current, input: { ...input, value: "" } } : current));
    setStatus(input.clearStatus ?? DEFAULT_INPUT_CLEAR_STATUS);
    return;
  }

  const text = printableInputText(key);
  if (!text) return;
  setSelection((current) =>
    current ? { ...current, input: { ...input, value: `${input.value}${text}` } } : current,
  );
}

// 提交当前高亮条目：按条目类型分三条路径（需参数 → 进入输入态；需异步候选 → 进入等待态；
// 普通命令 → 立即提交并关闭选区）。
// 返回空集合时提示“无匹配项”，disabled 条目只提示原因而不提交，避免用户误以为按键无效。
// 需参数的条目把 command/itemId 固化进 input，过滤串清空但选区委保留。
// 需异步候选的条目先进入等待态再发命令，preserveSelection 防止选区被清掉。
function submitSelectedItem(
  selection: SelectionState,
  visible: TuiSelectionItem[],
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
): void {
  const item = visible[clampIndex(selection.selectedIndex, visible.length)];
  // 过滤后可能没有任何候选，此时不调用 submitValue，只给出明确提示。
  if (!item) {
    setStatus("No matching item to select.");
    return;
  }
  if (item.disabledReason) {
    // 禁用项展示原因而不提交；这是唯一会把 disabledReason 暴露给用户的路径。
    setStatus(item.disabledReason);
    return;
  }
  const itemInput = item.input;
  if (itemInput) {
    // 需要额外参数：清空过滤串并切换到输入态，命令与条目 id 固化在 input 中供提交使用。
    const selectedIndex = clampIndex(selection.selectedIndex, visible.length);
    setSelection((current) =>
      current
        ? {
            ...current,
            filter: "",
            input: {
              ...itemInput,
              command: item.command,
              itemId: item.id,
              primary: itemInput.primary,
              value: "",
            },
            selectedIndex,
          }
        : current,
    );
    setStatus(itemInput.status ?? `Enter ${item.primary}.`);
    return;
  }
  const pending = item.pending;
  if (pending) {
    // 需异步候选（如后端列表）：先进入等待态并保留选区，提交后由回调填充 items；
    // preserveSelection 保证等待期间选区不被提交动作清掉。
    const selectedIndex = clampIndex(selection.selectedIndex, visible.length);
    setSelection((current) =>
      current
        ? {
            ...current,
            filter: "",
            pending: {
              ...pending,
              command: item.command,
              itemId: item.id,
            },
            selectedIndex,
          }
        : current,
    );
    setStatus(pending.status ?? `Selected ${item.primary}.`);
    void submitValue(item.command, {
      abortStatus: pending.cancelStatus,
      preserveSelection: true,
    });
    return;
  }
  setSelection(undefined);
  setStatus(`Selected ${item.primary}.`);
  // 普通条目：即发即忘提交；失败由 submitValue 自身经状态栏反馈，这里不处理 Promise。
  void submitValue(item.command);
}

// 输入态可打印文本：先走 printableKey；若按键名是控制键或带修饰则返回 undefined，
// 否则接受 sequence 中全部为可打印字符的多字节序列（如输入法一次提交的字符串）；
// 含 DEL(\x7f) 等控制字符时整体丢弃，避免把控制码写进输入值。
function printableInputText(key: KeyEvent): string | undefined {
  const character = printableKey(key);
  if (character) return character;
  if (key.ctrl || key.meta || CONTROL_KEY_NAMES.has(key.name)) return undefined;
  if (key.sequence.length === 0) return undefined;
  return [...key.sequence].every((char) => char >= " " && char !== "\x7f")
    ? key.sequence
    : undefined;
}

// 按 Unicode 码点删除最后一个字符（Array.from 而非 slice），避免拆坏代理对/组合字符。
function removeLastCharacter(value: string): string {
  const characters = Array.from(value);
  characters.pop();
  return characters.join("");
}
