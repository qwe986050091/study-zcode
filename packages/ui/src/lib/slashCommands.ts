// INV-01 只认行首斜杠：守住位置 extractActiveSlashQuery 的 lineStart；改错故障 句中斜杠也弹出命令面板。
// INV-02 查询词一旦含空白即失活：守住位置 WHITESPACE_RE；改错故障 输入参数时面板一直挂着。
// INV-03 空查询返回全部命令：守住位置 空串分支；改错故障 刚输入斜杠看到空列表。
// INV-04 null 查询返回空数组：守住位置 首个判断；改错故障 未激活时也渲染命令。
// INV-05 评分分层而不是连续：前缀 0 起、子串 100 起、散点 200 起；改错故障 字段权重被散点分淹没。
// INV-06 描述与提示有固定加分基数：守住位置 加 300 与加 500；改错故障 描述命中排在名称命中之前。
// INV-07 前缀分含长度差：守住位置 startsWith 分支；改错故障 短名与长名同分导致排序不稳。
// INV-08 散点匹配按顺序推进且失败即淘汰：守住位置 searchStart；改错故障 乱序命中被当成匹配。
// INV-09 排序先分数后名称长度再字典序：守住位置 三级比较；改错故障 每次输入面板顺序跳变。
// INV-10 替换必须包含前置行内容：守住位置 slice 到 lineStart；改错故障 上一行被截断。
// INV-11 光标偏移按命令名加空格再加一计：守住位置 cursorOffset；改错故障 光标落在斜杠前。
// INV-12 同行后续参数整体保留：守住位置 textAfterCursor.search；改错故障 命令后的参数被吞。
// INV-13 替换失败返回 null 由调用方放弃：守住位置 查询失活分支；改错故障 在非命令位置插入命令名。
//
// 模块职责：斜杠命令的查询提取、模糊过滤排序与文本替换。
// 阅读顺序：先看评分函数的分层，再看查询提取与过滤，最后看替换与光标计算。
import type { ZCodeSlashCommand } from "@zcode/shared";

const WHITESPACE_RE = /\s/;

// 空查询得 0 分：调用方已单独处理「全部展示」，这里只兜底。
// 前缀命中在 `scoreFuzzyMatch` 里拿最低档分值，同分时名称更短者靠前。
// 子串命中加 100 再加下标，越靠前越优。
// 散点匹配从 200 起，逐字符推进，任一字符缺失即淘汰。
function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
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

export function extractActiveSlashQuery(textBeforeCursor: string): string | null {
  // 只看光标所在行，行首之前的斜杠不算命令。
  // 查询词含空白说明已进入参数输入，面板应当收起。
  // 末尾不做 trim：用户正在输入的空格也要让面板失活。
  const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
  const lineText = textBeforeCursor.slice(lineStart);

  if (!lineText.startsWith("/")) {
    return null;
  }

  const query = lineText.slice(1);
  if (WHITESPACE_RE.test(query)) {
    return null;
  }

  return query;
}

export function filterSlashCommands(
  commands: ZCodeSlashCommand[],
  query: string | null,
): ZCodeSlashCommand[] {
  if (query === null) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return commands;
  }

  // 名称命中不加权，描述加 300，提示加 500。
  // 三个分数取最小，任一项为 null 视为无穷大。
  // 不可匹配的条目返回 null，在下一步统一剔除。
  return commands
    .map((command) => {
      const nameScore = scoreFuzzyMatch(command.name, normalizedQuery);
      const descriptionScore = scoreFuzzyMatch(command.description, normalizedQuery);
      const hintScore = scoreFuzzyMatch(command.inputHint ?? "", normalizedQuery);
      const bestScore = Math.min(
        nameScore ?? Number.POSITIVE_INFINITY,
        descriptionScore !== null ? descriptionScore + 300 : Number.POSITIVE_INFINITY,
        hintScore !== null ? hintScore + 500 : Number.POSITIVE_INFINITY,
      );

      if (!Number.isFinite(bestScore)) {
        return null;
      }

      return { command, score: bestScore };
    })
    .filter((item): item is { command: ZCodeSlashCommand; score: number } => item !== null)
    // `score` 相同先比 `command.name.length`，短命令更可能是用户想要的。
    // 再按 `localeCompare` 兜底，保证渲染顺序稳定可预期。
    // 不要改成按注册顺序：这套 `sort` 比较器是历史行为的一部分。
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.command.name.length !== right.command.name.length) {
        return left.command.name.length - right.command.name.length;
      }

      return left.command.name.localeCompare(right.command.name);
    })
    .map((item) => item.command);
}

interface SlashCommandReplacement {
  cursorOffset: number;
  text: string;
}

export function replaceActiveSlashCommand(
  textBeforeCursor: string,
  textAfterCursor: string,
  commandName: string,
): SlashCommandReplacement | null {
  const query = extractActiveSlashQuery(textBeforeCursor);
  if (query === null) {
    return null;
  }

  const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
  const suffixBoundary = textAfterCursor.search(WHITESPACE_RE);
  const trailingText = suffixBoundary === -1 ? "" : textAfterCursor.slice(suffixBoundary);
  const text = `${textBeforeCursor.slice(0, lineStart)}/${commandName} ${trailingText}`;
  const cursorOffset = lineStart + commandName.length + 2;

  // 新文本保留行首之前的内容，只替换命令片段。
  // 光标停在命令名加空格之后，紧接参数输入位置。
  return {
    cursorOffset,
    text,
  };
}
