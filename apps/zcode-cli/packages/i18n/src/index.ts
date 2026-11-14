/**
 * `@zcode/i18n` 的公共入口。
 *
 * 职责：汇总 locale 解析工具与各语言的文案目录，对外只暴露 `getZCodeCopy` 和
 * locale 相关的纯函数/常量。
 * 输入：调用方传入的 locale（可能是 "auto"、SupportedLocale 或任意字符串）以及
 * 环境探测得到的 locale 候选值。
 * 输出：只读的 `ZCodeCopy` 文案对象，缺失或无法识别时回落到 DEFAULT_LOCALE。
 * 副作用：纯查表，无 IO、无缓存写入；文案对象本身不应被调用方修改。
 * 失败语义：不抛错。任何非法 locale 都静默回落到默认语言，避免因为语言配置写错
 * 而阻断 CLI 启动。
 * 边界：不负责文案内容的完整性校验，新增语言必须同时补充 locales 目录与 CATALOGS。
 */
import type { UiLocale, SupportedLocale } from "@zcode/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { ZCodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, ZCodeCopy } from "./types.js";

// 语言到文案目录的唯一映射表。键必须与 SUPPORTED_LOCALES 一一对应，
// 否则 resolveLocale 的结果会在查表时得到 undefined 并导致访问文案时崩溃。
const CATALOGS: Record<SupportedLocale, ZCodeCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

/**
 * 按请求语言与探测语言选出文案目录。
 *
 * `locale` 为 "auto" 时才使用 `detected`，否则以显式请求为准；两者都不合法时
 * 回落到 DEFAULT_LOCALE。返回值是共享的只读对象，调用方不得原地修改，
 * 否则会污染同进程内其他会话的文案。
 */
export function getZCodeCopy(locale?: UiLocale | string, detected?: string | null): ZCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
