// CLI 帮助文本出口：文案统一取自 @zcode/i18n，保证各语言版本的帮助信息不会分叉。
import { getZCodeCopy, type SupportedLocale, type UiLocale } from "@zcode/i18n";

// 格式化 `--help` 输出。
// 输入：version 注入版本号占位；locale 是用户显式选择的界面语言（undefined 表示未指定），
//       detectedLocale 是系统探测结果（undefined 表示探测失败）；两者都缺省时由 i18n 回落到默认语言。
// 输出：完整帮助文本，已含结尾换行，可直接写入 stdout。
// 副作用：无 IO、无全局状态；纯函数，同一入参恒返回同一文本。
export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getZCodeCopy(locale, detectedLocale).cli.help(version);
}
