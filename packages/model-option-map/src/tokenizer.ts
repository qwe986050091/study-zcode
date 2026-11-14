// INV-01 空白跳过不产词：守住位置 空白判断；改错故障 解析器收到空白。
// INV-02 字符串分支优先：守住位置 引号判断；改错故障 引号被当运算符。
// INV-03 数字只接受规范写法：守住位置 正则；改错故障 前导零被接受。
// INV-04 标识符首字符限字母下划线：守住位置 判断；改错故障 数字开头名字被拆开。
// INV-05 双字符运算符优先：守住位置 先查两字符；改错故障 大于号被拆成两个。
// INV-06 单字符运算符兜底：守住位置 集合；改错故障 合法运算符被拒。
// INV-07 标点独立分类：守住位置 集合；改错故障 括号混进运算符。
// INV-08 未知字符即报错：守住位置 末尾抛错；改错故障 静默吞掉输入。
// INV-09 末尾必有结束标记：守住位置 收尾推入；改错故障 解析器越界。
// INV-10 词表冻结：守住位置 冻结调用；改错故障 下游改写词法结果。
// INV-11 偏移为起点终点：守住位置 字段；改错故障 报错位置错位。
// INV-12 字符串不允许换行：守住位置 换行判断；改错故障 跨行字符串被接受。
// INV-13 转义缺失即报错：守住位置 未定义判断；改错故障 截断处静默结束。
// INV-14 简单转义查表：守住位置 映射；改错故障 反斜杠丢失。
// INV-15 Unicode 转义限四位：守住位置 长度与格式；改错故障 非法码点通过。
// INV-16 数字不吞前导零：守住位置 正则；改错故障 零被吃掉。
// INV-17 标识符允许数字续写：守住位置 续写判断；改错故障 名字被截断。
// INV-18 全部函数无外部状态：守住位置 纯函数；改错故障 并发解析互相污染。
//
// 模块职责：受限 CEL 子集的词法分析。
// 状态所有权：无状态，全部输入来自源字符串。
// 阅读顺序：先看主循环，再看字符串与数字读取，最后看续读工具。
import { RestrictedCelError } from "./types.js";

export type RestrictedCelTokenKind =
  | "identifier"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "eof";

export interface RestrictedCelToken {
  readonly kind: RestrictedCelTokenKind;
  readonly value: string;
  readonly offset: number;
  readonly end: number;
}

const DOUBLE_OPERATORS = new Set(["&&", "||", "==", "!=", "<=", ">="]);
const SINGLE_OPERATORS = new Set(["+", "-", "*", "/", "%", "!", "<", ">"]);
const PUNCTUATION = new Set(["{", "}", "[", "]", "(", ")", ",", ":", "?", "."]);

// 空白直接跳过。
// 依次尝试字符串数字标识符。
// 双字符运算符优先。
// 未知字符立即报错。
// 末尾补结束标记。
export function tokenizeRestrictedCel(source: string): readonly RestrictedCelToken[] {
  const tokens: RestrictedCelToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset]!;
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      const token = readString(source, offset, character);
      tokens.push(token);
      offset = token.end;
      continue;
    }

    if (/[0-9]/u.test(character)) {
      const token = readNumber(source, offset);
      tokens.push(token);
      offset = token.end;
      continue;
    }

    if (/[A-Za-z_]/u.test(character)) {
      const end = readWhile(source, offset + 1, /[A-Za-z0-9_]/u);
      tokens.push({ kind: "identifier", value: source.slice(offset, end), offset, end });
      offset = end;
      continue;
    }

    const pair = source.slice(offset, offset + 2);
    if (DOUBLE_OPERATORS.has(pair)) {
      tokens.push({ kind: "operator", value: pair, offset, end: offset + 2 });
      offset += 2;
      continue;
    }
    if (SINGLE_OPERATORS.has(character)) {
      tokens.push({ kind: "operator", value: character, offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    if (PUNCTUATION.has(character)) {
      tokens.push({ kind: "punctuation", value: character, offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    throw new RestrictedCelError(`unsupported token ${JSON.stringify(character)}`, offset);
  }
  tokens.push({ kind: "eof", value: "", offset: source.length, end: source.length });
  return Object.freeze(tokens);
}

// 匹配规范数字。
// 不匹配即报错。
// 记录起止偏移。
// 不转换数值类型。
function readNumber(source: string, offset: number): RestrictedCelToken {
  const match = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
  if (!match) throw new RestrictedCelError("invalid number literal", offset);
  const value = match[0];
  const end = offset + value.length;
  return { kind: "number", value, offset, end };
}

// 逐字符累积。
// 遇到同引号结束。
// 换行视为未终止。
// 反斜杠进入转义。
// 结束偏移含右引号。
function readString(source: string, offset: number, quote: "'" | '"'): RestrictedCelToken {
  let cursor = offset + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === quote) {
      return { kind: "string", value, offset, end: cursor + 1 };
    }
    if (character === "\n" || character === "\r") {
      throw new RestrictedCelError("unterminated string literal", offset);
    }
    if (character !== "\\") {
      value += character;
      cursor += 1;
      continue;
    }

    const escapeOffset = cursor;
    cursor += 1;
    const escaped = source[cursor];
    if (escaped === undefined) {
      throw new RestrictedCelError("unterminated string escape", escapeOffset);
    }
    const simpleEscape = SIMPLE_ESCAPES[escaped];
    if (simpleEscape !== undefined) {
      value += simpleEscape;
      cursor += 1;
      continue;
    }
    if (escaped === "u") {
      const digits = source.slice(cursor + 1, cursor + 5);
      if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
        throw new RestrictedCelError("invalid unicode escape", escapeOffset);
      }
      value += String.fromCharCode(Number.parseInt(digits, 16));
      cursor += 5;
      continue;
    }
    throw new RestrictedCelError(`unsupported string escape \\${escaped}`, escapeOffset);
  }
  throw new RestrictedCelError("unterminated string literal", offset);
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "'": "'",
  '"': '"',
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

// 逐字符匹配。
// 停止于首个不匹配。
// 返回结束偏移。
// 不修改源串。
function readWhile(source: string, offset: number, pattern: RegExp): number {
  let cursor = offset;
  while (cursor < source.length && pattern.test(source[cursor]!)) cursor += 1;
  return cursor;
}
