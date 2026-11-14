/**
 * locale 的识别、归一化与回落策略。
 *
 * 职责：把用户配置（UiLocale）、环境变量（LC_ALL/LC_MESSAGES/LANG/LANGUAGE）和 Intl
 * 探测结果统一收敛成受支持的 SupportedLocale。
 * 输出：`en-US` / `zh-CN`，或识别失败时返回 undefined（由调用方决定回落）。
 * 副作用：无。全部为纯函数，不读取 process.env，环境必须由调用方显式传入，
 * 便于测试和在同一进程内模拟不同环境。
 * 失败语义：不抛错；无法识别一律返回 undefined，由 resolveLocale 兜底成默认语言。
 * 不变量：返回值必定属于 SUPPORTED_LOCALES，"auto" 永远不会被当作有效结果返回。
 */
import type { SupportedLocale, UiLocale } from "@zcode/contracts";

// 默认语言固定为 en-US：未配置且系统语言无法识别时，保证 CLI 至少有一份完整文案。
export const DEFAULT_LOCALE: SupportedLocale = "en-US";
export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const satisfies readonly SupportedLocale[];
const LOCALE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] as const;
const LANGUAGE_LIST_SEPARATOR = ":";
const LOCALE_ENCODING_SEPARATOR = ".";
const LOCALE_MODIFIER_SEPARATOR = "@";
const NON_LANGUAGE_LOCALES = new Set(["c", "posix"]);

export interface LocaleDetectionInput {
  env?: Record<string, string | undefined>;
  intlLocale?: string | null;
}

/**
 * 判断是否属于受支持的完整语言标签（严格相等，不做前缀归一化）。
 *
 * 同时充当类型守卫，调用方据此把宽泛的 string 收窄成 SupportedLocale，
 * 后续即可安全地拿它索引文案表。
 */
export function isSupportedLocale(value: string | undefined): value is SupportedLocale {
  return value === "en-US" || value === "zh-CN";
}

/**
 * 判断用户可配置的语言取值是否合法，即 "auto" 或受支持的语言。
 *
 * 配置校验必须用它而不是 isSupportedLocale，否则 "auto" 会被误判为非法并让
 * 用户无法启用自动探测。
 */
export function isUiLocale(value: string | undefined): value is UiLocale {
  return value === "auto" || isSupportedLocale(value);
}

/**
 * 把任意请求值收敛成必定合法的 SupportedLocale。
 *
 * 只有请求值为 "auto" 时才采信 `detected`，避免探测结果覆盖用户的显式选择。
 * 永不抛错也永不返回 undefined，因此可以直接索引文案表。
 */
export function resolveLocale(
  requested: UiLocale | string | undefined,
  detected?: string | null,
): SupportedLocale {
  const candidate = requested === "auto" ? detected : requested;
  return normalizeLocale(candidate) ?? DEFAULT_LOCALE;
}

/**
 * 从环境变量与 Intl 结果中探测语言，按优先级返回第一个可识别者。
 *
 * 环境变量顺序固定为 LC_ALL > LC_MESSAGES > LANG > LANGUAGE，符合 POSIX 的
 * 优先级约定；Intl 结果仅作最后兜底。识别不到时返回 undefined 而不是默认值，
 * 以便把回落决策留给 resolveLocale 一处集中处理。
 */
export function detectLocale(input: LocaleDetectionInput = {}): SupportedLocale | undefined {
  for (const candidate of localeCandidates(input)) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return undefined;
}

// 把单个别名归一化：先剥离 POSIX 的编码与修饰符（如 zh_CN.UTF-8@euro），
// 再把下划线统一成 BCP-47 的连字符，只保留「语言」这一层语义。
function normalizeLocale(value: string | null | undefined): SupportedLocale | undefined {
  if (!value) return undefined;
  const tag = stripLocaleDecorators(value.trim()).replaceAll("_", "-");
  // C/POSIX 在部分系统上是默认值，它们表示「不指定语言」而不是某种自然语言，
  // 若当成有效结果会掩盖真实的系统语言设置。
  if (!tag || NON_LANGUAGE_LOCALES.has(tag.toLowerCase())) return undefined;
  if (isSupportedLocale(tag)) return tag;
  const lower = tag.toLowerCase();
  // 只按语言前缀归并（en-* → en-US、zh-* → zh-CN），因此 zh-Hant 也会落到简体文案；
  // 目前只有单一中文文案，接受这一取舍以换取行为可预测。
  if (lower === "en" || lower.startsWith("en-")) return "en-US";
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  return undefined;
}

// 生成候选序列：环境变量优先（按固定键序），Intl 探测结果最后作为兜底。
function* localeCandidates(input: LocaleDetectionInput): Iterable<string> {
  if (input.env) {
    for (const key of LOCALE_ENV_KEYS) {
      const value = input.env[key];
      if (!value) continue;
      yield* splitLocaleEnvValue(key, value);
    }
  }

  if (input.intlLocale) {
    yield input.intlLocale;
  }
}

// LANGUAGE 是多值时以冒号分隔的优先级列表，需要逐个尝试；
// 其余变量按 POSIX 语义只承载单个 locale，不能按冒号拆分。
function splitLocaleEnvValue(key: (typeof LOCALE_ENV_KEYS)[number], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (key === "LANGUAGE") {
    return trimmed
      .split(LANGUAGE_LIST_SEPARATOR)
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0);
  }
  return [trimmed];
}

// 按 POSIX 语法截断 `.` 之后的编码与 `@` 之后的修饰符；使用 split 的 limit=1
// 保证只取前缀段，避免对含多个分隔符的异常值产生多余候选。
function stripLocaleDecorators(value: string): string {
  const withoutEncoding = value.split(LOCALE_ENCODING_SEPARATOR, 1)[0] ?? "";
  return withoutEncoding.split(LOCALE_MODIFIER_SEPARATOR, 1)[0] ?? "";
}
