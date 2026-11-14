// INV-01 [契约] 触发符集合固定为 / @ $ #，¥ 与 ￥ 只作为 $ 的输入别名；守住位置：PromptInputTrigger 联合类型与 normalizePromptInputTriggerAlias 的两个判断；改错故障：新触发符未进正则，面板无法唤起该类候选。
// INV-02 [边界] 普通触发必须落在行首或空白之后；守住位置：ACTIVE_TRIGGER_RE 首段 (^|\s)；改错故障：普通正文里的 a/b 被当成 slash 命令，输入路径时弹出命令面板。
// INV-03 [边界] @ 额外接受汉字与中文标点紧邻；守住位置：ACTIVE_MENTION_TRIGGER_RE 的首段字符类与 u 标志；改错故障：中文里“看看@文件”不再触发，mention 在中文输入下失效。
// INV-04 [失败路径] 汉字紧邻 @ 且 query 呈域名形态时必须拒绝；守住位置：extractActivePromptInputTrigger 中 HAN_PREFIX_RE 与 DOMAIN_LIKE_QUERY_RE 的联合判断；改错故障：联系邮箱@example.com 被识别为 mention，弹出无关文件候选。
// INV-05 [顺序] 先试放宽的 mention 正则再退回通用正则；守住位置：extractActivePromptInputTrigger 里两个 exec 的空值合并次序；改错故障：次序颠倒后中文紧邻 @ 永远走不到放宽分支。
// INV-06 [契约] query 是紧跟触发符、且不含空白与其它触发符的最长片段；守住位置：两个正则第三捕获组与 match[3] 的空值兜底；改错故障：query 吞进后续正文，候选被无谓过滤成空。
// INV-07 [权衡] 只放宽 @ 的边界，slash、skill 与 session 面板维持严格；守住位置：两套正则并存而非合并成一套；改错故障：合并后中文句中的 / 误触发命令面板，打断正常打字。
// INV-08 [状态] query 为 null 与空串是两种状态；守住位置：filterPromptInputSuggestions 开头 null 返回空数组、空串返回全部候选；改错故障：两者混同后，面板要么常驻要么刚打开即空白。
// INV-09 [契约] 模糊评分分四档：空文本无分、空前缀零分、前缀按长度差、子串自 100 起、子序列自 200 起；守住位置：scoreFuzzyMatch 的顺序判断；改错故障：档位重叠后子串压过前缀，首选候选错位。
// INV-10 [契约] 字段权重固定为名称 +50、描述 +250、关键词 +450，value 不加权；守住位置：scorePromptInputSuggestion 的 bestScore 取最小值；改错故障：权重倒挂后描述命中压过名称命中，用户回车选到无关项。
// INV-11 [失败路径] 所有字段都不命中时必须返回 null 而不是大分；守住位置：scorePromptInputSuggestion 末尾的 Number.isFinite 判断与正无穷初值；改错故障：null 被当作 0 分，过滤结果混入完全不相关候选。
// INV-12 [契约] 匹配前统一去首尾空白并转小写；守住位置：scoreFuzzyMatch 开头两次对 text 与 query 的规范化；改错故障：大小写敏感让 @Read 匹配不到 read，候选顺序整体失真。
// INV-13 [边界] 光标后的 tail 只在能与候选剩余后缀对齐时才回收；守住位置：getActivePromptInputTokenTailLength 中 expectedTail 与 typedTail 的前缀比较；改错故障：完整 /goal 后紧贴的正文被整段删除。
// INV-14 [权衡] 多候选时 tail 取各候选可对齐长度的最大值；守住位置：matchedTailLength 的 Math.max 与 comparableLength 取两者较短；改错故障：按首个候选长度截断，短候选后面残留半截尾巴。
// INV-15 [契约] 排序是分数升序、原始下标升序、label 字典序三级；守住位置：filterPromptInputSuggestions 末尾 sort 的三个分支；改错故障：去掉下标兜底后同分顺序随引擎浮动，高亮项跳动。
// INV-16 [契约] 默认高亮在空查询时为 0，同分保留最早一项；守住位置：getBestPromptInputSuggestionIndex 的初始 0 与严格小于比较；改错故障：改成小于等于后同分取末位，回车选中最后一条。
// INV-17 [事务] 替换前必须重新解析并校验 trigger 与候选一致；守住位置：replaceActivePromptInputToken 开头的再次解析与 trigger 比较；改错故障：文本在选中瞬间被改动，仍按旧位置替换，删掉用户新写的内容。
// INV-18 [边界] tokenStart 假定触发符占一个字符，光标偏移再加 1 个尾随空格；守住位置：tokenStart 的减 1 与 cursorOffset 的加 2；改错故障：偏移少算或多算，替换后光标落在单词中间或空格之后。
//
// 模块职责：把光标前的输入文本解析成 slash、mention、skill、session 四类触发态，按模糊分排出候选，并算出替换区间与光标偏移。
// 状态所有权：本模块不持有任何状态，触发态与候选都由调用方传入，函数只返回纯值，替换结果也只是描述而非写回文本。
// 阅读顺序：先看触发正则与别名归一，再看两处评分，随后是解析、tail 回收、过滤排序与替换。
export type PromptInputTrigger = "/" | "@" | "$" | "#";

export interface ActivePromptInputTrigger {
  trigger: PromptInputTrigger;
  query: string;
}

export function getPromptInputTriggerSignature(
  activeTrigger: ActivePromptInputTrigger | null,
): string | null {
  return activeTrigger
    ? `${activeTrigger.trigger}:${activeTrigger.query}`
    : null;
}

export interface PromptInputSuggestionItem {
  id: string;
  trigger: PromptInputTrigger;
  value: string;
  label: string;
  description: string;
  keywords?: string[];
  data?: {
    path?: string;
    scope?: "built-in" | "workspace" | "user" | "plugin";
    source?: "built-in" | "user" | "plugin";
    model?: string;
  };
}

interface PromptInputReplacement {
  cursorOffset: number;
  text: string;
}

type PromptInputReplacementCandidates = string | readonly string[];

// [边界] ACTIVE_TRIGGER_RE 要求触发符前是行首或空白，且整段匹配到字符串末尾，才承认这是活跃 token。
// [契约] 第三捕获组排除所有触发符与空白，保证一次只解析一个 token，嵌套符号会切断 query。
// [边界] ACTIVE_MENTION_TRIGGER_RE 的前置集合加入汉字、CJK 标点与全角区段，仅为中文随手 @ 服务。
// [契约] DOMAIN_LIKE_QUERY_RE 用两侧非空白夹一个点来近似域名；HAN_PREFIX_RE 只认汉字，不含中文标点。
// [权衡] ACTIVE_TRIGGER_TAIL_RE 从光标后取到第一个空白或触发符为止，回收范围不会跨词。
const ACTIVE_TRIGGER_RE = /(^|\s)([/@$#¥￥])([^\s/@$#¥￥]*)$/;
// 中文输入通常不在句中插入空格；仅放宽 @，避免改变 slash、skill、session 面板的触发边界。
const ACTIVE_MENTION_TRIGGER_RE =
  /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s/@$#¥￥]*)$/u;
// 放宽中文紧邻 @ 后，`联系邮箱@example.com` / `用户@例子.公司` 会被当成 mention。
// 仅在汉字直接紧邻 @ 时拒绝域名形态（`x.y`）的 query；中文标点后（`看看，@foo.bar`）和
// 空格后的 `@foo.bar` 不是邮箱形态，保持触发。
const DOMAIN_LIKE_QUERY_RE = /\S\.\S/;
const HAN_PREFIX_RE = /\p{Script=Han}/u;
const ACTIVE_TRIGGER_TAIL_RE = /^[^\s/@$#¥￥]*/;

// [契约] 别名归一只改触发语义，不改写用户实际输入的 ¥ 或 ￥ 字符。
// [边界] 除两个货币符号外一律原样返回，并直接断言为 PromptInputTrigger，不再二次校验。
// [失败路径] 若把归一写进文本替换，用户输入的全角符号会被悄悄换成 $，撤销后无法还原。
function normalizePromptInputTriggerAlias(trigger: string): PromptInputTrigger {
  if (trigger === "¥" || trigger === "￥") {
    // 部分键盘/输入法输入 skill trigger 时会产生 `¥` 或全角 `￥`。
    // 这里只把触发语义归一为 `$`，让它唤起 skill 面板；不在输入层改写用户实际输入字符。
    return "$";
  }

  return trigger as PromptInputTrigger;
}

// [契约] 文本为空直接返回 null，表示这条建议没有任何可比较内容，而不是得 0 分。
// [契约] 查询为空返回 0，使所有候选同分，顺序随后由稳定排序决定。
// [契约] 前缀命中返回长度差，越短越靠前，短名称优先于长名称。
// [契约] 子串命中从 100 起并加下标偏移，整体排在所有前缀命中之后。
// [契约] 子序列命中从 200 起累加每次跳跃的间隔，再叠加长度差，作为最后的兜底。
// [权衡] 三档阈值是硬编码常量，改动档位会直接改变面板默认高亮，需同步调用方预期。
function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

// [契约] 四个字段各自评分，value 不加权，label、description、keywords 分别加 50、250、450。
// [契约] 空关键词列表用 `Number.POSITIVE_INFINITY` 兜底，缺席时不参与最小值竞争。
// [失败路径] 所有字段为 null 时返回 null，调用方据此过滤，而不是给一个可排序的大数。
// [契约] 返回的是最小值，因此任一字段命中即可入围，不要求全字段命中。
function scorePromptInputSuggestion(
  suggestion: PromptInputSuggestionItem,
  query: string,
): number | null {
  const valueScore = scoreFuzzyMatch(suggestion.value, query);
  const labelScore = scoreFuzzyMatch(suggestion.label, query);
  const descriptionScore = scoreFuzzyMatch(suggestion.description, query);
  const keywordScore = Math.min(
    ...(suggestion.keywords ?? []).map((keyword) => {
      const score = scoreFuzzyMatch(keyword, query);
      return score === null ? Number.POSITIVE_INFINITY : score + 450;
    }),
    Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    valueScore ?? Number.POSITIVE_INFINITY,
    labelScore !== null ? labelScore + 50 : Number.POSITIVE_INFINITY,
    descriptionScore !== null ? descriptionScore + 250 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

// [顺序] 先跑 mention 正则，失败才回落到通用正则；前者只多放宽了前置字符集合，其余结构一致。
// [失败路径] 汉字前缀加上域名形态 query 时直接返回 null，把邮箱地址留给普通文本。
// [边界] 判定只看 match[1] 是否为汉字，中文标点后的 @foo.bar 仍然触发。
// [契约] query 缺失时补空串，返回对象始终同时具备 trigger 与 query 两个字段。
// [契约] trigger 经别名归一后返回，调用方无需再识别 ¥ 与 ￥。
// [权衡] 这里不做候选校验，是否真的存在文件或命令由后续过滤阶段决定。
export function extractActivePromptInputTrigger(
  textBeforeCursor: string,
): ActivePromptInputTrigger | null {
  const match =
    ACTIVE_MENTION_TRIGGER_RE.exec(textBeforeCursor) ??
    ACTIVE_TRIGGER_RE.exec(textBeforeCursor);
  if (!match) {
    return null;
  }
  if (HAN_PREFIX_RE.test(match[1] ?? "") && DOMAIN_LIKE_QUERY_RE.test(match[3] ?? "")) {
    return null;
  }

  return {
    trigger: normalizePromptInputTriggerAlias(match[2] ?? ""),
    query: match[3] ?? "",
  };
}

// [边界] query 为空说明触发符是后来插入到已有文字前的，光标后正文不属于该 token，直接返回 0。
// [资源] tail 只取到第一个空白或触发符，因此不会跨越多个词误删。
// [契约] 候选先去掉首尾空白与前导触发符，再与 query 比较，兼容带前缀的候选值。
// [契约] 候选必须以 query 为前缀才算相关，否则跳过，不参与 tail 竞争。
// [边界] 只比较候选剩余后缀与已输入 tail 的公共长度，并且要求两者前缀一致。
// [权衡] 采用各候选最大可对齐长度，宁可少删也不整段吞掉后文。
export function getActivePromptInputTokenTailLength(
  activeTrigger: ActivePromptInputTrigger,
  textAfterCursor: string,
  replacementCandidates: PromptInputReplacementCandidates,
): number {
  if (activeTrigger.query.length === 0) {
    // 用户在已有文字前插入裸触发符时，光标后的正文不是当前 token 的补全部分。
    // 之前会把这些正文当 tail 一起替换，导致选中 @/#/$// 候选后清掉后面的文字。
    return 0;
  }

  const tailMatch = ACTIVE_TRIGGER_TAIL_RE.exec(textAfterCursor);
  const tailText = tailMatch?.[0] ?? "";
  if (!tailText) {
    return 0;
  }

  const normalizedQuery = activeTrigger.query.toLowerCase();
  const candidates = Array.isArray(replacementCandidates)
    ? replacementCandidates
    : [replacementCandidates];
  let matchedTailLength = 0;

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim().replace(/^[/@$#¥￥]+/, "");
    if (!candidate) {
      continue;
    }

    const normalizedCandidate = candidate.toLowerCase();
    if (!normalizedCandidate.startsWith(normalizedQuery)) {
      continue;
    }

    const expectedTail = candidate.slice(activeTrigger.query.length);
    if (!expectedTail) {
      continue;
    }

    const comparableLength = Math.min(tailText.length, expectedTail.length);
    const typedTail = tailText.slice(0, comparableLength);
    // 完整 `/goal` 后紧贴的正文若被当作同一个 token 的 tail 会整段删除。
    // 这里只删除“候选值未输入后缀”能对上的那一小段，比如 `/go|al` 里的 `al`。
    if (expectedTail.toLowerCase().startsWith(typedTail.toLowerCase())) {
      matchedTailLength = Math.max(matchedTailLength, comparableLength);
    }
  }

  return matchedTailLength;
}

// [状态] query 为 null 表示未激活，返回空数组，调用方不应展示面板。
// [状态] 空串表示面板刚打开，原样返回全部候选，保持传入顺序且不去重。
// [契约] 非空查询先逐条评分，null 分的建议在过滤阶段被剔除。
// [契约] 排序依次比较分数、原始下标、label，保证同分时顺序稳定可预测。
// [权衡] 结果映射回原对象，不复制建议，避免调用方拿到两份不一致的数据。
export function filterPromptInputSuggestions(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): PromptInputSuggestionItem[] {
  if (query === null) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return suggestions;
  }

  return suggestions
    .map((suggestion, index) => {
      const bestScore = scorePromptInputSuggestion(suggestion, normalizedQuery);
      if (bestScore === null) {
        return null;
      }

      return {
        index,
        score: bestScore,
        suggestion,
      };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        score: number;
        suggestion: PromptInputSuggestionItem;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return left.suggestion.label.localeCompare(right.suggestion.label);
    })
    .map((item) => item.suggestion);
}

// [状态] 空查询直接返回 0，把默认高亮固定在第一项。
// [契约] `getBestPromptInputSuggestionIndex` 只接受严格更小分数，同分保留先出现项。
// [失败路径] 全部候选都不命中时保持 0，不回退到 -1，调用方无需处理负下标。
export function getBestPromptInputSuggestionIndex(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): number {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  if (!normalizedQuery) {
    return 0;
  }

  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  suggestions.forEach((suggestion, index) => {
    const score = scorePromptInputSuggestion(suggestion, normalizedQuery);
    if (score === null) {
      return;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

// [事务] 进入即重新解析光标前文本，解析结果为空或 trigger 不匹配时返回 null，不改动任何文本。
// [边界] tokenStart 按触发符占一个字符回推，query 长度与触发符长度共同决定替换起点。
// [契约] 替换文本是前缀、触发符、候选值与一个尾随空格，再拼上未回收的后缀。
// [边界] cursorOffset 等于前缀长度加候选值长度加 2，分别对应触发符与尾随空格。
export function replaceActivePromptInputToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  suggestion: Pick<PromptInputSuggestionItem, "trigger" | "value">,
): PromptInputReplacement | null {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== suggestion.trigger) {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    suggestion.value,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);

  return {
    cursorOffset: prefix.length + suggestion.value.length + 2,
    text: `${prefix}${suggestion.trigger}${suggestion.value} ${suffix}`,
  };
}
