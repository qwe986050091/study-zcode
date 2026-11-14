// 终端列宽工具模块：提供按显示列宽截断、词换行行数估算与列宽计算。
// 边界：只做纯文本度量，不接触终端、不缓存、不做实际排版。
// 口径：宽字符（CJK/全角/兼容表意区）按 2 列、控制字符按 0 列、其余按 1 列；行数估算按词换行。
// 失败语义：不抛错；非正数宽度收敛为 1 或空串，保证调用方不会除零或越界。
// 截断后缀与列宽常量：省略号默认占 3 列（按 ASCII 计），词间空格固定 1 列，
// 换行/空白正则用于把段落拆成可计数的词序列。
const TRUNCATION_SUFFIX = "...";
const INTER_WORD_SPACE_WIDTH = 1;
const LINE_BREAK_PATTERN = /\r?\n/u;
const WHITESPACE_PATTERN = /\s+/u;

// 按显示列宽截断并追加省略号；宽度不足时直接切到 maxCells（不追加后缀），
// maxCells <= 0 时返回空串语义（slice(0,0)）。输入含宽字符时按 2 列计，避免截出半宽乱码。
// 未超宽时原样返回，调用方可据此做零拷贝比较；不会修改换行或空白。
export function truncateDisplay(value: string, maxCells: number): string {
  if (displayWidth(value) <= maxCells) return value;
  if (maxCells <= TRUNCATION_SUFFIX.length) return value.slice(0, Math.max(0, maxCells));

  let cells = 0;
  let output = "";
  for (const char of value) {
    const width = terminalCharWidth(char);
    if (cells + width > maxCells - TRUNCATION_SUFFIX.length) break;
    output += char;
    cells += width;
  }
  return `${output}${TRUNCATION_SUFFIX}`;
}

// 估算按词换行后的总行数（用于给 transcript 预留高度，不参与实际排版）。
// 口径：先按段落（\n）拆分，空段落计 1 行；每个词自身若超过宽度限制也按字符折行，
// 词间空格计入列宽；maxCells 非正数时收敛为 1，避免除零。
// 无副作用：纯计算，返回 >= 1 的整数（空字符串按 1 行）。
export function wordWrappedLineCount(value: string, maxCells: number): number {
  const widthLimit = Math.max(1, Math.floor(maxCells));
  let lineCount = 0;

  for (const paragraph of value.split(LINE_BREAK_PATTERN)) {
    const words = paragraph.trim().split(WHITESPACE_PATTERN).filter(Boolean);
    if (words.length === 0) {
      lineCount += 1;
      continue;
    }

    let currentLineWidth = 0;
    for (const word of words) {
      const wordWidth = displayWidth(word);
      if (currentLineWidth === 0) {
        const wrapped = wrappedTokenLineCount(wordWidth, widthLimit);
        lineCount += wrapped - 1;
        currentLineWidth = wrappedTokenRemainderWidth(wordWidth, widthLimit);
        continue;
      }

      const nextLineWidth = currentLineWidth + INTER_WORD_SPACE_WIDTH + wordWidth;
      if (nextLineWidth <= widthLimit) {
        currentLineWidth = nextLineWidth;
        continue;
      }

      lineCount += 1;
      const wrapped = wrappedTokenLineCount(wordWidth, widthLimit);
      lineCount += wrapped - 1;
      currentLineWidth = wrappedTokenRemainderWidth(wordWidth, widthLimit);
    }
    lineCount += 1;
  }

  return lineCount;
}

// 计算字符串在终端中占用的列宽：逐 code point 累加，宽字符/全角计 2 列，控制字符计 0 列。
// 不处理组合字符（emoji ZWJ 序列按各 code point 累加，可能高估），这是有意的近似以保持 O(n) 且无依赖。
// 空串返回 0；结果仅用于布局估算，不代表终端实际排版结果。
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += terminalCharWidth(char);
  return width;
}

// 单个字符的终端列宽：C0/C1 控制字符为 0；东亚宽字符（CJK、韩文、全角标点、兼容表意区）为 2；
// 其余为 1。仅覆盖常见宽字符区段，不依赖第三方 wcwidth 库。
function terminalCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

// 单个词折行后的行数：向上取整，至少 1 行（空词也按 1 行处理，由调用方决定是否过滤）。
function wrappedTokenLineCount(width: number, widthLimit: number): number {
  return Math.max(1, Math.ceil(width / widthLimit));
}

// 折行后最后一行的已用宽度：整除时取满行宽（表示该行正好填满），否则取余数；
// 宽度 <= 0 返回 0，避免对空词给出满行的错误预期。
function wrappedTokenRemainderWidth(width: number, widthLimit: number): number {
  if (width <= 0) return 0;
  const remainder = width % widthLimit;
  return remainder === 0 ? widthLimit : remainder;
}
