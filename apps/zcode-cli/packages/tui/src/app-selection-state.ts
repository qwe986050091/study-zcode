// 协议选区到 TUI 选区态的转换。
// 职责：浅拷贝 TuiSelection，补全过滤串并夹取选中下标。
// 边界：只做数据整形，不持有交互状态、不渲染。
// 副作用：无，纯函数，不读全局、不写缓存。
// 降级：入参 undefined 返回 undefined；空列表由 clampIndex 给出安全下标。

import { clampIndex } from "./app-input.js";
import type { SelectionState } from "./app-model.js";
import type { TuiSelection } from "./types.js";

// 把协议侧 TuiSelection 转换为 TUI 内部 SelectionState：浅拷贝原始字段，
// 补全 filter 为空串，并把 selectedIndex 收敛到 [0, items.length) 区间。
// 输入 undefined 时返回 undefined，调用方据此判定不渲染选择面板。
// selectedIndex 缺省按 0 处理；空列表由 clampIndex 给出不可选中的索引，不会抛错。
// 无副作用：不读全局、不写缓存，纯数据转换。
export function createSelectionState(
  selection: TuiSelection | undefined,
): SelectionState | undefined {
  if (!selection) return undefined;
  return {
    ...selection,
    filter: "",
    selectedIndex: clampIndex(selection.selectedIndex ?? 0, selection.items.length),
  };
}
