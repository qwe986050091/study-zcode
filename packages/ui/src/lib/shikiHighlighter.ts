// INV-01 纯文本语言不启动高亮：守住位置 PLAIN_TEXT_CODE_LANGUAGES；改错故障 日志块进入异步状态机。
// INV-02 语言名统一小写去空白：守住位置 trim 与 toLowerCase；改错故障 大小写不同判定不一致。
// INV-03 别名归一到官方 id：守住位置 bundledLanguageAliases；改错故障 同一语言分裂两份缓存。
// INV-04 未知语言回退兜底：守住位置 FALLBACK_CODE_LANGUAGE；改错故障 高亮器加载失败。
// INV-05 高亮器按 主题加语言 缓存：守住位置 cacheKey；改错故障 重复创建实例泄漏。
// INV-06 并发创建只留一个 Promise：守住位置 先读缓存；改错故障 同时发起多次加载。
// INV-07 token 缓存键含长度与首尾：守住位置 getCodeTokensCacheKey；改错故障 长文碰撞串色。
// INV-08 缓存命中走微任务回调：守住位置 queueMicrotask；改错故障 同步 setState 触发告警。
// INV-09 未命中先登记订阅者：守住位置 subscribers.set；改错故障 高亮完成无人接收。
// INV-10 加载完成后按订阅者广播：守住位置 for 循环；改错故障 同一代码块重复高亮。
// INV-11 广播后立刻清空订阅：守住位置 subscribers.delete；改错故障 回调被重复调用。
// INV-12 失败只记日志不抛：守住位置 catch 分支；改错故障 未捕获异常打断渲染。
// INV-13 主题缺省跟随文档深色：守住位置 documentElement；改错故障 深浅主题错配。
// INV-14 背景统一透明：守住位置 bg 字段；改错故障 代码块出现突兀底色。
// INV-15 缺省前景继承父级：守住位置 fg 字段；改错故障 文本对比度不足。
// INV-16 raw tokens 每行独立：守住位置 按换行切分；改错故障 空行被合并。
// INV-17 诊断只读不写缓存：守住位置 registry 回调；改错故障 统计本身引入淘汰。
// INV-18 同步返回命中值或空：守住位置 两处 return；改错故障 调用方误以为已有结果。
//
// 模块职责：把代码块按语言与主题分片高亮，并维护高亮器与 token 两级缓存。
// 状态所有权：缓存与订阅者均为模块级单例，React 侧只订阅结果。
// 阅读顺序：先看语言判定，再看缓存键，最后看订阅与失败路径。
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

// 高亮结果固定三段。
// 行内 token 保持二维结构。
// foreground 与 background 各取主题默认色，缺失时分别兜底
export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

// bundledLanguageIds 取 bundledLanguages 的键集合
// bundledLanguageAliases 由 bundledLanguagesInfo.flatMap 展开
// 两个集合建好后只读，不随调用修改
const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

// codeLanguage 命中 PLAIN_TEXT_CODE_LANGUAGES 时直接返回 false
// 其余语言需命中 bundledLanguageIds 或 aliases，否则不启用高亮
// 判定与归一化共用 bundledLanguageAliases 一套表
export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

// 空串直接返回 FALLBACK_CODE_LANGUAGE
// 先查 bundledLanguageAliases，命中后仍校验官方 id
// 别名与 id 都未命中时返回 FALLBACK_CODE_LANGUAGE
function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

// 按 主题 加 语言 缓存 Promise。
// 缓存的是创建过程而非实例。
// highlighterCache 存 Promise，并发调用共享同一次 createHighlighter
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
// 内存诊断计数器：tokensCache 目前无淘汰，是审计里
// renderer 最可疑的增长点，先把条数落到日志里。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  highlighters: highlighterCache.size,
}));

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const getCodeTokensCacheKey = (
  code: string,
  language: BundledLanguage,
  theme: BundledTheme,
) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};
const getHighlighter = (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cacheKey = `${theme}:${language}`;
  const cached = highlighterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: [theme],
  });

  highlighterCache.set(cacheKey, highlighterPromise);
  return highlighterPromise;
};

export const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      tokensCache.set(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
      subscribers.delete(tokensCacheKey);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
    });

  return null;
};
