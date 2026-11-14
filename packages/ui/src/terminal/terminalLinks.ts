// INV-01 URL 不跨越空白：守住位置 HTTP_URL_PATTERN；改错故障 链接吞掉后文参数。
// INV-02 尾部标点先裁剪：守住位置 TRAILING_PUNCTUATION_PATTERN；改错故障 句末标点进入可点击地址。
// INV-03 闭合括号需配对：守住位置 CLOSING_BRACKET_PAIRS；改错故障 带括号的链接丢失右括号。
// INV-04 括号数不配时才裁：守住位置 countChar 比较；改错故障 合法路径被截断。
// INV-05 裁剪循环到稳定为止：守住位置 无界循环退出条件；改错故障 尾标点只裁一层。
// INV-06 空候选直接跳过：守住位置 trimmed 判断；改错故障 生成空文本链接区间。
// INV-07 区间按原始下标回填：守住位置 startIndex 与长度；改错故障 高亮范围整体错位。
// INV-08 单元格按字符落位：守住位置 positions 逐字符追加；改错故障 双宽字符映射偏移。
// INV-09 零宽单元格跳过：守住位置 宽度判断；改错故障 代理对位置重复计数。
// INV-10 单元格对象复用：守住位置 reusableCell；改错故障 大缓冲区逐格分配内存。
// INV-11 折行从首行起算：守住位置 向前回溯折行标志；改错故障 长链接被截成半段。
// INV-12 折行到尾行结束：守住位置 向后推进折行标志；改错故障 跨行链接丢尾部。
// INV-13 缺失缓冲行返回空：守住位置 行对象判断；改错故障 越界读取直接崩溃。
// INV-14 空快照不生成链接：守住位置 文本判断；改错故障 空行也进入匹配流程。
// INV-15 坐标转为一基索引：守住位置 两处加一；改错故障 链接整体左移一格。
// INV-16 跨行链接按当前行裁剪：守住位置 起止行包含判断；改错故障 相邻行重复高亮。
// INV-17 无命中返回未定义：守住位置 结果长度判断；改错故障 调用方把空数组当命中。
// INV-18 本模块不持有终端实例：守住位置 纯函数与缓冲入参；改错故障 生命周期与终端耦合。
//
// 模块职责：从终端缓冲区文本中识别并定位 HTTP 链接。
// 状态所有权：无状态；缓冲区与行列数均由调用方传入。
// 阅读顺序：先看正则与裁剪，再读快照构建，最后看链接定位。
import type { IBuffer, IBufferLine, ILink } from "@xterm/xterm";

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
const CLOSING_BRACKET_PAIRS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

interface BufferCellPosition {
  cellX: number;
  bufferLine: number;
}

interface TerminalLineSnapshot {
  text: string;
  positions: BufferCellPosition[];
}

interface TerminalHttpLinkMatch {
  text: string;
  startIndex: number;
  endIndex: number;
}

type TerminalHttpLink = Pick<ILink, "range" | "text" | "decorations">;

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
}

function trimTerminalUrlCandidate(value: string): string {
  let trimmed = value.replace(TRAILING_PUNCTUATION_PATTERN, "");

  for (;;) {
    const last = trimmed.at(-1);
    const opening = last ? CLOSING_BRACKET_PAIRS[last] : undefined;
    if (!last || !opening) {
      return trimmed;
    }

    if (countChar(trimmed, last) <= countChar(trimmed, opening)) {
      return trimmed;
    }

    trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION_PATTERN, "");
  }
}

// findHttpLinksInTerminalText 逐个匹配全部地址。
// startIndex 保留匹配在原文里的原始下标。
// trimTerminalUrlCandidate 先裁掉尾部标点。
// 空候选直接 continue，不进入结果集。
// endIndex 按裁剪后 trimmed.length 计算。
// 结果为原始文本区间，text 是裁剪后的串。
export function findHttpLinksInTerminalText(text: string): TerminalHttpLinkMatch[] {
  const links: TerminalHttpLinkMatch[] = [];

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const raw = match[0];
    const startIndex = match.index ?? 0;
    const trimmed = trimTerminalUrlCandidate(raw);
    if (!trimmed) {
      continue;
    }

    links.push({
      text: trimmed,
      startIndex,
      endIndex: startIndex + trimmed.length - 1,
    });
  }

  return links;
}

// appendCellText 遇到空字符按空格占位。
// 文本追加到 snapshot.text 快照。
// 每个字符都重复推入同一 position 坐标。
// snapshot.positions 与 text 等长，索引一一对应。
// appendCellText 不裁剪宽度，列数由调用方保证。
// 该函数供 readWrappedLineSnapshot 折行拼装复用。
function appendCellText(
  snapshot: TerminalLineSnapshot,
  chars: string,
  position: BufferCellPosition,
) {
  const text = chars || " ";
  snapshot.text += text;
  for (let index = 0; index < text.length; index += 1) {
    snapshot.positions.push(position);
  }
}

function appendBufferLine(
  snapshot: TerminalLineSnapshot,
  line: IBufferLine,
  bufferLine: number,
  cols: number,
) {
  const reusableCell = line.getCell(0);

  for (let cellX = 0; cellX < cols; cellX += 1) {
    const current = line.getCell(cellX, reusableCell);
    if (!current || current.getWidth() === 0) {
      continue;
    }

    appendCellText(snapshot, current.getChars(), { bufferLine, cellX });
  }
}

// getWrappedLineRange 先向前找到折行首行。
// 再向后找到折行末行，遇到 isWrapped 为假即停。
// 返回范围包含当前 bufferLineNumber 本身。
// 首行不再继续回溯，start 停在第一个非折行处。
// 返回值供 readWrappedLineSnapshot 整段读取。
function getWrappedLineRange(buffer: IBuffer, bufferLineNumber: number) {
  let start = bufferLineNumber - 1;
  while (start > 0 && buffer.getLine(start)?.isWrapped) {
    start -= 1;
  }

  let end = bufferLineNumber - 1;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) {
    end += 1;
  }

  return { start, end };
}

function readWrappedLineSnapshot(
  buffer: IBuffer,
  bufferLineNumber: number,
  cols: number,
): TerminalLineSnapshot | null {
  const { start, end } = getWrappedLineRange(buffer, bufferLineNumber);
  const snapshot: TerminalLineSnapshot = { text: "", positions: [] };

  for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      return null;
    }

    appendBufferLine(snapshot, line, lineIndex + 1, cols);
  }

  return snapshot;
}

// getHttpLinksForTerminalBufferLine 先拼出折行快照。
// snapshot 为空直接返回 undefined。
// 起止坐标加一后转成 1 基 buffer 行号。
// 只保留覆盖当前行的 TerminalHttpLinkMatch，其余丢弃。
// 无命中返回 undefined，调用方按无链接处理。
export function getHttpLinksForTerminalBufferLine(
  buffer: IBuffer,
  bufferLineNumber: number,
  cols: number,
): TerminalHttpLink[] | undefined {
  const snapshot = readWrappedLineSnapshot(buffer, bufferLineNumber, cols);
  if (!snapshot || !snapshot.text) {
    return undefined;
  }

  const links: TerminalHttpLink[] = [];
  for (const match of findHttpLinksInTerminalText(snapshot.text)) {
    const start = snapshot.positions[match.startIndex];
    const end = snapshot.positions[match.endIndex];
    if (!start || !end) {
      continue;
    }

    const link = {
      text: match.text,
      range: {
        start: { x: start.cellX + 1, y: start.bufferLine },
        end: { x: end.cellX + 1, y: end.bufferLine },
      },
      decorations: {
        // 交互说明：xterm 的 link provider 只在 hover 时绘制装饰。
        // 这里显式打开下划线和手型，避免 http 链接看起来只是普通终端文本。
        underline: true,
        pointerCursor: true,
      },
    } satisfies TerminalHttpLink;

    if (link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber) {
      links.push(link);
    }
  }

  return links.length > 0 ? links : undefined;
}
