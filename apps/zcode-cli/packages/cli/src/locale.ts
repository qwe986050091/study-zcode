// CLI 语言探测与显示语言解析：只做 i18n 适配，语言优先级与持久化规则由 @zcode/i18n 统一维护。
import { detectLocale, resolveLocale, type SupportedLocale, type UiLocale } from "@zcode/i18n";
import type { CliEnv } from "./env.js";

// 探测当前环境应使用的语言。
// 输入：env（含用户显式设置的语言变量，可直接传 process.env），并叠加 Intl 默认 locale 作为兜底线索。
// 输出：命中受支持语言时返回 SupportedLocale；无法判定时返回 undefined，由调用方决定最终默认值。
// 副作用：只读环境变量与系统 Intl 能力，不写 env、不落盘、不打印。
export function detectCliLocale(env: CliEnv | NodeJS.ProcessEnv): SupportedLocale | undefined {
  return detectLocale({
    env,
    intlLocale: resolveIntlLocale(),
  });
}

// 把用户配置的界面语言解析成实际可用的 SupportedLocale。
// 输入：locale 为显式配置（undefined 表示用户未设置）；detectedLocale 为探测结果，作为回退。
// 输出：undefined 当且仅当 locale 未指定 —— 此时调用方应沿用 TUI 自身默认，不做隐式覆盖。
export function resolveDisplayLocale(
  locale: UiLocale | undefined,
  detectedLocale: SupportedLocale | undefined,
): SupportedLocale | undefined {
  if (locale === undefined) return undefined;
  return resolveLocale(locale, detectedLocale);
}

// 读取系统级默认 locale；失败时降级为 undefined 而不是中断语言探测。
function resolveIntlLocale(): string | undefined {
  // Intl 在部分精简运行时（或 ICU 缺失）会抛错，此处把它当作"无系统线索"。
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
