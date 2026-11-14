// INV-01 守住位置：findEditMatch 的 exact 层先于所有规范化层执行；改错故障：exact 后移会让本来精确的 old_string 先被规范化改形，写回内容与模型意图不一致。
// INV-02 守住位置：策略循环中任意一层产生候选就立即返回；改错故障：继续下探更宽松的层，会用更模糊的片段覆盖用户明确指出的位置。
// INV-03 守住位置：ambiguous 是终态，不再降级重试；改错故障：多候选时继续下探会随机选中一处，静默改错文件。
// INV-04 守住位置：replaceAll 为 true 时跳过 BROAD_MATCHERS 中的策略；改错故障：批量替换叠加模糊匹配，会把同形代码块一起改写。
// INV-05 守住位置：toMatchResult 按候选 value 去重后再判唯一性；改错故障：按出现下标判重会把同一文本的多处位置误判为歧义，正常编辑被拒。
// INV-06 守住位置：matched 的 actualString 取自文件真实切片；改错故障：返回规范化后的 search，替换会写回文件里不存在的字符串。
// INV-07 守住位置：collectLineNumberPrefixCandidates 在剥除结果为 null 或与 search 等价时返回空；改错故障：把正文里合法的行号样式误当行号剥掉，命中错误位置。
// INV-08 守住位置：stripReadLineNumberPrefixes 全有或全无，任一行无前缀即返回 null；改错故障：部分剥除产生半截文本，命中率上升但语义错乱。
// INV-09 守住位置：escape 与 unicode 两个解转义策略在内容无变化时返回空；改错故障：空转策略反复命中，遮蔽后续真正需要的宽松层。
// INV-10 守住位置：collectNormalizedCandidates 返回原 content 的真实切片；改错故障：返回规范化文本的片段，长度不等时替换落点整体偏移。
// INV-11 守住位置：collectSubstringCandidates 的游标每次至少前进一位；改错故障：零进度导致死循环，Edit 调用永不返回。
// INV-12 守住位置：line_trimmed 按行窗口逐位比较 trim 结果；改错故障：改成无序行集合匹配会丢掉行序，替换跨越不相邻区域。
// INV-13 守住位置：indentation_flexible 要求搜索文本至少 2 行；改错故障：单行搜索忽略缩进后到处命中，歧义率暴涨。
// INV-14 守住位置：block_anchor 要求至少 3 行且中间行相似度不低于常量下限；改错故障：阈值调低会把结构相似但语义不同的块当成同一块。
// INV-15 守住位置：offsetForLine 给每行额外计入 1 个换行符；改错故障：偏移少算，替换落点在文件里错位并破坏语法。
// INV-16 守住位置：trimTrailingEmptyLine 只削掉一个尾空行；改错故障：多削会吃掉模型有意保留的末尾空行，块边界判定偏移。
// INV-17 守住位置：averageMiddleSimilarity 跳过首尾行只比对中间行；改错故障：把已被锚点校验的首尾行再计入均值，相似度被稀释导致漏匹配。
// INV-18 守住位置：normalizeReplacementForMatch 只在 escape_normalized 下解转义 newString；改错故障：其它策略也解转义，会把合法的反斜杠序列改坏。
//
// 模块职责：把模型给出的 old_string 在多套等价改写与宽松匹配策略下定位到文件中唯一的真实片段，并把命中策略回报给上层。
// 状态所有权：本模块是无状态的纯函数集合，不持有缓存、不读写文件、不感知 session；落盘由 Edit 工具上层负责。
// 阅读顺序：先看 EditMatchStrategy 与 EditMatchResult 的契约，再看 findEditMatch 的阶梯，最后看各 collect 函数与相似度工具的实现细节。
// ============================================================================
// tool/edit-matchers.ts —— Edit 工具的 old_string 匹配阶梯
// ============================================================================
//
// 【职责】模型给的 old_string 常被 Read 输出的行号前缀、转义、弯引号、缩进等污染。
//   本文件按"从严格到宽松"的顺序逐级尝试匹配，返回命中的真实片段与所用策略；
//   Edit 随后用真实片段替换，保证"模型写意、落盘写实"。
//
// 【匹配阶梯】exact → quote_normalized → line_number_prefix_stripped →
//   escape_normalized → unicode_escape_normalized → line_trimmed →
//   indentation_flexible → block_anchor。
//   前四层是等价改写（内容不变），后三层是宽松匹配（line_trimmed/indentation_flexible/
//   block_anchor），只在 replaceAll=false 时启用——否则模糊匹配可能批量改掉相似块。
//
// 【失败语义】not_found 表示所有策略都无候选；ambiguous 表示某层出现多个不同候选，
//   此时立即停下并回报，绝不"再往下试一个更宽松的策略"来猜用户意图。
//
// 【不变量】matched 的 actualString 必须是文件中的真实片段（不是 search 的规范化形），
//   否则替换会写回一个文件里不存在的字符串。
// ============================================================================

// 对外契约：策略枚举只允许这八种，枚举顺序即匹配阶梯的语义排序。
// 新增策略必须同步 BROAD_MATCHERS 与 collectCandidates 的 switch，否则该层永远拿不到候选。
// EditMatchResult 的 matched 与 ambiguous 都带 strategy 和 candidateCount，便于上层日志定位是哪一层命中。
// not_found 不带策略：它表示所有层都无候选，而不是某一层匹配失败。
// 改错提示：给 matched 增加可选字段而不同步调用方，会让替换路径漏判状态。
type EditMatchStrategy =
  | "exact"
  | "quote_normalized"
  | "line_number_prefix_stripped"
  | "escape_normalized"
  | "unicode_escape_normalized"
  | "line_trimmed"
  | "indentation_flexible"
  | "block_anchor";

type EditMatchResult =
  | {
      status: "matched";
      actualString: string;
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | {
      status: "ambiguous";
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | { status: "not_found" };

// 三个宽松策略集中登记在这里，findEditMatch 只在 replaceAll 时据此跳过。
// 新增宽松策略若忘记登记，批量替换下会被当作精确定位策略执行，造成批量误改。
// 0.8 是块锚点中间行相似度的下限：调低会放宽到结构相似但语义不同的代码块。
// 四个弯引号常量抽出为命名常量，供 normalizeQuotes 与 preserveQuoteStyle 共用同一份字符集。
// 改错提示：这些常量是只读语义，不要在任何路径上被重新赋值，也不要引入 locale 相关处理。
const BROAD_MATCHERS = new Set<EditMatchStrategy>([
  "line_trimmed",
  "indentation_flexible",
  "block_anchor",
]);
const BLOCK_ANCHOR_MIN_SIMILARITY = 0.8;
const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

interface Candidate {
  value: string;
  index: number;
}

/**
 * 在 content 中为 search 找出唯一可替换的真实片段。
 *
 * @param input.replaceAll true 时禁用宽松策略，避免模糊匹配被批量替换。
 * @returns matched 带 actualString（真实文件片段）与命中的策略；ambiguous 带候选数；
 *   都没有则为 not_found。注意：某层一旦有候选就立即返回，不会再尝试更宽松的层。
 * @sideEffect 无；纯函数，不读写文件。
 */
// 公开入口：先单独做一次 exact，再按固定阶梯逐层试探，任何一层有候选就立即定案。
// 为什么 exact 单独提前：绝大多数调用本来就精确，提前返回可省掉后面七轮全量扫描。
// replaceAll 为 true 时跳过宽松层是安全边界，宁可 not_found 让模型重读文件，也不批量猜。
// 循环体只做三件事：过滤宽松层、收集候选、命中即返回，不在这里做任何写盘决策。
// 歧义是结果而不是中间态：多候选交给上层提示模型缩小范围，不能靠继续下探消解。
// 改错提示：在这里加缓存或改写 input 会破坏纯函数约定，并发调用方会互相污染。
export function findEditMatch(input: {
  content: string;
  search: string;
  replaceAll: boolean;
}): EditMatchResult {
  // 精确匹配优先：一旦命中就不再走任何规范化，避免把"本来精确"的内容改形。
  const exact = collectExactCandidates(input.content, input.search);
  if (exact.length > 0) {
    return toMatchResult("exact", exact);
  }

  // 阶梯顺序是有意排列的：等价改写层在前，模糊层在后，越往后误伤风险越高。
  // 这个数组与类型联合、collectCandidates 的 switch 必须保持同一份顺序认知。
  // 顺序调整后同一份 old_string 可能命中不同策略，替换结果随之改变。
  // 不要在这里做去重或条件分支，宽松层的过滤统一由 BROAD_MATCHERS 承担。
  // 改错提示：调换相邻两层会让同一输入在不同层命中，回报的 strategy 字段随之漂移。
  const strategies: EditMatchStrategy[] = [
    "quote_normalized",
    "line_number_prefix_stripped",
    "escape_normalized",
    "unicode_escape_normalized",
    "line_trimmed",
    "indentation_flexible",
    "block_anchor",
  ];

  for (const strategy of strategies) {
    // 宽松策略在 replaceAll 下会放大误伤面：宁可 not_found 让模型重读，也不批量猜。
    if (input.replaceAll && BROAD_MATCHERS.has(strategy)) continue;
    const candidates = collectCandidates(strategy, input.content, input.search);
    if (candidates.length === 0) continue;
    // 第一个有候选的层直接定案；歧义是结果，不是继续下探的理由。
    return toMatchResult(strategy, candidates);
  }

  return { status: "not_found" };
}

/**
 * 统一换行为 LF。仅用于比较/写入前的规范化，不负责保留原文件的行尾风格；
 * CRLF 文件经 Edit 写回时由上层按原样处理写盘策略。
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

/**
 * 让替换文本与命中策略保持同一"编码口径"：只有 escape_normalized 命中时，模型写的
 * newString 里也带有 \n/\t 这类可见转义，必须同样解转义后再写入，否则会把字面反斜杠
 * 落进文件。其它策略下 newString 原样使用，避免误伤合法的转义序列。
 */
// newString 的编码口径必须跟随命中策略，否则 search 与 replacement 的转义假设不一致。
// 只有 escape_normalized 命中才解转义：此时模型写的 newString 同样带可见转义。
// 其它策略原样返回：无条件解转义会把用户想写进文件的反斜杠字面量吃掉。
// 这里不处理行尾与引号，职责单一，才便于单独测试两种分支。
// 改错提示：把条件扩大到 quote_normalized 会破坏后续的弯引号保留逻辑。
export function normalizeReplacementForMatch(
  strategy: EditMatchStrategy,
  newString: string,
): string {
  return strategy === "escape_normalized" ? unescapeVisibleCharacters(newString) : newString;
}

/**
 * 当 old_string 是"弯引号规范化后"才命中时，把 newString 里的直引号还原成文件使用的
 * 弯引号风格，避免同一段文本里混用两种引号。oldString 与真实片段一致时不改写——
 * 此时模型本来就写对了风格，任何替换都可能弄巧成拙。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }

  let result = newString;
  if (
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  ) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  ) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

function collectCandidates(
  strategy: EditMatchStrategy,
  content: string,
  search: string,
): Candidate[] {
  switch (strategy) {
    case "exact":
      return collectExactCandidates(content, search);
    case "quote_normalized":
      return collectQuoteNormalizedCandidates(content, search);
    case "line_number_prefix_stripped":
      return collectLineNumberPrefixCandidates(content, search);
    case "escape_normalized":
      return collectEscapeNormalizedCandidates(content, search);
    case "unicode_escape_normalized":
      return collectUnicodeEscapeNormalizedCandidates(content, search);
    case "line_trimmed":
      return collectLineTrimmedCandidates(content, search);
    case "indentation_flexible":
      return collectIndentationFlexibleCandidates(content, search);
    case "block_anchor":
      return collectBlockAnchorCandidates(content, search);
  }
}

// 唯一性按候选文本 value 去重后再判断，而不是按出现下标：同一片段出现多次才算歧义。
// candidateCount 回报原始数组长度，让上层知道文件里命中了多少处。
// 空候选由调用方提前返回，这里的空值兜底只服务于类型收窄。
// actualString 必须取真实切片，绝不能回填规范化后的 search。
// 改错提示：把唯一性改成按下标判断，会拒绝同一片段多处出现的正常定位场景。
function toMatchResult(strategy: EditMatchStrategy, candidates: Candidate[]): EditMatchResult {
  const uniqueValues = [...new Set(candidates.map((candidate) => candidate.value))];
  if (uniqueValues.length !== 1) {
    return { status: "ambiguous", strategy, candidateCount: candidates.length };
  }

  return {
    status: "matched",
    actualString: uniqueValues[0] ?? "",
    strategy,
    candidateCount: candidates.length,
  };
}

function collectExactCandidates(content: string, search: string): Candidate[] {
  return collectSubstringCandidates(content, search);
}

function collectQuoteNormalizedCandidates(content: string, search: string): Candidate[] {
  return collectNormalizedCandidates(content, search, normalizeQuotes);
}

function collectLineNumberPrefixCandidates(content: string, search: string): Candidate[] {
  const stripped = stripReadLineNumberPrefixes(search);
  if (stripped === null || stripped === search) return [];
  return collectSubstringCandidates(content, stripped);
}

function collectEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeVisibleCharacters(search);
  if (unescaped === search) return [];
  return collectSubstringCandidates(content, unescaped);
}

function collectUnicodeEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeUnicodeCharacters(search);
  if (unescaped === search) return [];

  // Unicode 转义回退允许 old_string 里的 \uXXXX 匹配文件中的真实字符。
  // 这里直接返回文件中的真实片段，后续 replacement 会按真实片段写入。
  return collectSubstringCandidates(content, unescaped);
}

function collectLineTrimmedCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length === 0) return [];

  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (!block.every((line, offset) => line.trim() === searchLines[offset]!.trim())) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectIndentationFlexibleCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 2) return [];

  const normalizedSearch = removeCommonIndent(searchLines);
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (removeCommonIndent(block) !== normalizedSearch) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectBlockAnchorCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 3) return [];

  const first = searchLines[0]!.trim();
  const last = searchLines[searchLines.length - 1]!.trim();
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (block[0]!.trim() !== first) continue;
    if (block[block.length - 1]!.trim() !== last) continue;
    if (averageMiddleSimilarity(block, searchLines) < BLOCK_ANCHOR_MIN_SIMILARITY) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectSubstringCandidates(content: string, search: string): Candidate[] {
  if (search.length === 0) return [];
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(search, position);
    if (index === -1) break;
    candidates.push({ value: search, index });
    position = index + Math.max(search.length, 1);
  }
  return candidates;
}

// 规范化只用于定位：返回的 value 必须取原 content 的切片，保证替换写的是文件真实内容。
// 规范化后长度可能变化，index 仍按 normalizedContent 计算，切片长度用原始 search 长度。
// 游标推进取规范化长度与原长度的较大值并保底为 1，避免空模式或零进度导致无限循环。
// normalize 由调用方注入，引号与其它等价改写层共用这一份扫描骨架。
// 改错提示：直接返回规范化文本的片段，会把文件里不存在的字符写回磁盘。
function collectNormalizedCandidates(
  content: string,
  search: string,
  normalize: (value: string) => string,
): Candidate[] {
  const normalizedContent = normalize(content);
  const normalizedSearch = normalize(search);
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedSearch, position);
    if (index === -1) break;
    candidates.push({ value: content.slice(index, index + search.length), index });
    position = index + Math.max(normalizedSearch.length, 1);
  }
  return candidates;
}

/**
 * 剥掉 Read 输出风格的行号前缀（`12: ` 或 `12\t`）。
 * 全有或全无：只要有一行不带前缀就返回 null，避免把正文里合法的 "1: " 误当行号剥掉。
 * 返回 null 或与输入等价时，上层策略会跳过这一层。
 */
export function stripReadLineNumberPrefixes(search: string): string | null {
  const lines = search.split("\n");
  const stripped = lines.map((line) => {
    const colonMatch = line.match(/^\d+: (.*)$/);
    if (colonMatch) return colonMatch[1] ?? "";
    const tabMatch = line.match(/^\d+\t(.*)$/);
    if (tabMatch) return tabMatch[1] ?? "";
    return null;
  });
  return stripped.every((line): line is string => line !== null) ? stripped.join("\n") : null;
}

function unescapeVisibleCharacters(search: string): string {
  return search.replace(/\\([ntr"'`\\$])/g, (match, token: string) => {
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
      case "'":
      case "`":
      case "\\":
      case "$":
        return token;
      default:
        return match;
    }
  });
}

function unescapeUnicodeCharacters(search: string): string {
  return search.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedBackslash, hex: string) => {
    if (escapedBackslash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

function blockCandidate(lines: string[], startLine: number, lineCount: number): Candidate {
  const index = offsetForLine(lines, startLine);
  return {
    value: lines.slice(startLine, startLine + lineCount).join("\n"),
    index,
  };
}

function offsetForLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index]!.length + 1;
  }
  return offset;
}

function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function removeCommonIndent(lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join("\n");
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0));
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
}

// 块锚点只比中间行：首尾行已由 trim 相等预筛，不参与打分。
// 行数不超过 2 时直接返回 1，避免中间行计数为 0 时的除零。
// 单行相似度用 1 减编辑距离除以最长长度，取值落在 0 到 1 之间。
// 阈值比较发生在 collectBlockAnchorCandidates，这里只负责算术，不决定通过与否。
// 改错提示：把首尾行计入均值会稀释真实差异，导致锚点块漏命中。
function averageMiddleSimilarity(actual: string[], expected: string[]): number {
  if (actual.length <= 2) return 1;
  let total = 0;
  let count = 0;
  for (let index = 1; index < actual.length - 1; index += 1) {
    total += lineSimilarity(actual[index]!.trim(), expected[index]!.trim());
    count += 1;
  }
  return count === 0 ? 1 : total / count;
}

function lineSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(left, right) / maxLength;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function applyCurlyDoubleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== '"') return char;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_DOUBLE_CURLY_QUOTE
        : RIGHT_DOUBLE_CURLY_QUOTE;
    })
    .join("");
}

function applyCurlySingleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== "'") return char;
      const previous = chars[index - 1];
      const next = chars[index + 1];
      if (isLetter(previous) && isLetter(next)) {
        return RIGHT_SINGLE_CURLY_QUOTE;
      }
      return isOpeningQuoteContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

function isOpeningQuoteContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "—" ||
    previous === "–"
  );
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /\p{L}/u.test(value);
}
