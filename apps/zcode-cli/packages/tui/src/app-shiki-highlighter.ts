// shiki 语法高亮适配器。
// 职责：按文件路径推断语言，懒建 highlighter 并缓存分词结果。
// 边界：仅装饰性高亮，不参与内容判断或安全校验。
// 副作用：进程内缓存与按需加载语言；不联网、不写文件。
// 失败语义：超时或分词异常一律返回 undefined，调用方按纯文本降级。

import path from "node:path";
import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme } from "shiki";
import type { TuiThemeMode } from "./theme/index.js";

// 高亮主题与超时配置：亮/暗模式固定映射到 github-light / github-dark；
// 2.5s 内未完成即视为降级（返回 undefined），避免语法高亮拖住 diff 首屏。
const SHIKI_DARK_THEME = "github-dark";
const SHIKI_LIGHT_THEME = "github-light";
const SHIKI_THEMES = [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME] as const;
const HIGHLIGHT_TIMEOUT_MS = 2_500;

// 无扩展名文件的兜底映射：按小写文件名（含扩展名之前的部分）直接命中语言。
const LANGUAGE_BY_FILENAME: Record<string, BundledLanguage> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

// 扩展名到 shiki 内置语言 id 的别称表：仅登记与扩展名同名但实际语言 id 不同的情况，
// 未登记扩展名直接当作语言 id 交给 isBundledLanguage 校验。
const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  cjs: "javascript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  htm: "html",
  mjs: "javascript",
  mts: "typescript",
  psm1: "powershell",
  tsx: "tsx",
  jsx: "jsx",
  swift: "swift",
};

// 单行高亮片段：text 为原文（按 token 切分后按序拼接可还原整行），
// color 为十六进制色值（可能缺失，缺失时由渲染侧回退主题正文色）；
// fontStyle 为 shiki 位掩码，undefined 表示无修饰。
export type ShikiHighlightSegment = {
  color?: string;
  fontStyle?: number;
  text: string;
};

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

// 进程内单例 highlighter 与语言/结果缓存：加载语言与建实例成本高，跨 diff 复用；
// highlightCache 的 key 由主题+语言+整段文本组成，未命中才真正分词。
let highlighterPromise: Promise<ShikiHighlighter> | undefined;
const loadedLanguages = new Set<BundledLanguage>();
const highlightCache = new Map<string, ShikiHighlightSegment[][] | undefined>();

// 由文件路径推断 shiki 语言：先按完整文件名匹配（Dockerfile/Makefile 等），
// 再按扩展名查别称表并校验是否为内置语言；filePath 为 undefined 或无法识别时返回
// undefined，调用方据此跳过高亮、按纯文本渲染（这是正常降级，不是错误）。
export function inferShikiLanguage(filePath: string | undefined): BundledLanguage | undefined {
  if (!filePath) return undefined;
  const basename = path.basename(filePath).toLowerCase();
  const filenameMatch = LANGUAGE_BY_FILENAME[basename];
  if (filenameMatch) return filenameMatch;

  const extension = path.extname(basename).replace(/^\./u, "");
  if (!extension) return undefined;
  const mapped = LANGUAGE_BY_EXTENSION[extension] ?? extension;
  return isBundledLanguage(mapped) ? mapped : undefined;
}

// 对整段代码做语法高亮，返回与输入行等长的片段数组。
// 输入 lines 为空时仍走完流程并返回空数组；语言不可识别时返回 undefined（降级为纯文本）。
// 副作用：首次调用会创建 highlighter 单例并加载语言，结果写入进程内缓存；不写文件、不联网。
// 失败语义：分词异常、加载超时一律返回 undefined 并写入缓存，避免同一内容反复重试。
export async function highlightShikiCodeLines(input: {
  filePath: string | undefined;
  lines: string[];
  mode: TuiThemeMode;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  const language = inferShikiLanguage(input.filePath);
  if (!language) return undefined;

  const theme = shikiThemeForMode(input.mode);
  const cacheKey = `${theme}\0${language}\0${input.lines.join("\n")}`;
  if (highlightCache.has(cacheKey)) return highlightCache.get(cacheKey);

  const highlighted = await withTimeout(
    tokenizeLines({
      language,
      lines: input.lines,
      theme,
    }),
    HIGHLIGHT_TIMEOUT_MS,
  );
  highlightCache.set(cacheKey, highlighted);
  return highlighted;
}

// 清空不影响在飞的高亮 Promise：它们完成时仍可能向同一个缓存写回结果，测试应自行等待稳定或改用独立断言。
// 只重置 highlighter 单例、已加载语言与结果缓存三项，不改主题映射、超时配置或其它模块状态。
// 仅供测试：清空单例、已加载语言集合与结果缓存，保证用例之间不串扰。
// 生产路径不调用；清空后下一次高亮会重新创建 highlighter 并重新加载语言。
export function resetShikiHighlighterForTest(): void {
  highlighterPromise = undefined;
  loadedLanguages.clear();
  highlightCache.clear();
}

// 实际分词：确保语言已加载后按行切 token，并把结果补齐到输入行数。
// 任何异常（未知语言、shiki 内部错误）都被吞掉并返回 undefined，
// 因为高亮是纯装饰能力，失败不应影响 diff 主体内容展示。
async function tokenizeLines(input: {
  language: BundledLanguage;
  lines: string[];
  theme: BundledTheme;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  try {
    const highlighter = await getHighlighter();
    if (!loadedLanguages.has(input.language)) {
      await highlighter.loadLanguage(input.language);
      loadedLanguages.add(input.language);
    }

    const result = highlighter.codeToTokens(input.lines.join("\n"), {
      lang: input.language,
      theme: input.theme,
    });
    return padTokenLines(
      result.tokens.map((line) =>
        line.map((token) => ({
          color: token.color,
          fontStyle: token.fontStyle,
          text: token.content,
        })),
      ),
      input.lines.length,
    );
  } catch {
    return undefined;
  }
}

// 懒建单例：初始不加载任何语言，按需在 tokenizeLines 中逐个 loadLanguage，
// 避免启动时把所有内置语法都装进内存；并发调用共享同一个 Promise。
function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= createHighlighter({
    langs: [],
    themes: [...SHIKI_THEMES],
  });
  return highlighterPromise;
}

// 运行时判定扩展名是否为 shiki 真正内置的语言 id，防止把 "vue"/"txt" 之类
// 非语言名传给 loadLanguage 触发异常。
function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, language);
}

// 主题模式映射：仅 light 走亮色主题，其余（dark/undefined 语义）默认暗色，
// 与 TUI 主题解析保持同一默认值。
function shikiThemeForMode(mode: TuiThemeMode): BundledTheme {
  return mode === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

// 高亮结果与渲染行数对齐：shiki 可能少返回末尾空行（或多返回），
// 少则补空数组、多则截断，保证调用方可以按行下标安全取值。
function padTokenLines(
  lines: ShikiHighlightSegment[][],
  expectedLength: number,
): ShikiHighlightSegment[][] {
  if (lines.length >= expectedLength) return lines.slice(0, expectedLength);
  return [...lines, ...Array.from({ length: expectedLength - lines.length }, () => [])];
}

// 超时竞速：超时后 resolve undefined 而非 reject，使调用方统一按"无高亮"降级；
// finally 清理计时器，避免 Promise 已完成后仍持有 socket/定时器句柄。
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
