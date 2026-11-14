// TUI 国际化兜底文案模块。
// 边界：只读取 @zcode/i18n 的 en-US 语言包，不发起运行时语言切换，也不维护第二份文案真源。
// 使用方按字段访问，缺键由各组件自行兜底；本模块不感知 session/主题等运行时状态。
import { getZCodeCopy } from "@zcode/i18n";

// 维护约束：DEFAULT_TUI_COPY 是只读快照，调用方不得修改其字段（文案对象由语言包共享）。
// 失败语义：取词结果为空对象时仍按原样导出，本文件不补默认键，缺键由各组件自行兜底。
// TUI 的英文兜底文案集合，来源为 @zcode/i18n 的 en-US 语言包。
// 用途：locale 未初始化、缺失键或语言包加载失败时提供稳定的默认文案，避免界面出现空白。
// 口径：非空对象常量（取 .tui 子树），不含 null/undefined 值；本文件不承担运行时切换语言职责。
// 副作用：模块加载时即完成一次同步取词，之后作为只读快照复用。
export const DEFAULT_TUI_COPY = getZCodeCopy("en-US").tui;
