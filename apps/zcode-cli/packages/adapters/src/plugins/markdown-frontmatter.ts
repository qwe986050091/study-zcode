import { readFileSync } from "node:fs";

/*
 * ============================================================
 * plugins / markdown-frontmatter.ts —— 技能/命令 Markdown frontmatter 轻量解析
 *
 * 定位：只提取 name/description 两个标量（含 YAML 块标量），供插件详情展示；不做完整
 * YAML 解析，也不执行任何模板。
 *
 * 输入输出：输入文件路径或文本，输出 {name?, description?}；缺失/空白一律省略该键。
 *
 * 副作用：readMarkdownFrontmatter 读取文件（只读）；parseMarkdownFrontmatter 纯函数。
 *
 * 失败语义：文件不可读→{}；无 frontmatter/无结束分隔线→{}；块标量缩进异常按尽可能
 * 正确折叠，不抛错。
 *
 * 不变量：不会伪造空串或把 YAML 指示符（>/|）当成正文；同名键只取第一次出现。
 * ============================================================
 */

/**
 * 轻量 Markdown frontmatter 抽取，支持 YAML 块标量（`>` 折叠 / `|` 字面，及 `+`/`-` chomping 变体）。
 *
 * 插件市场详情 (plugins/describe) 用一行正则读 `name`/`description` 时，遇到
 * `description: >` 这类块标量时会把指示符 `>` 当成描述本体，导致技能列表里每项描述只剩一个 `>`。
 * 这里复用与 skills adapter 同款的块标量解析规则（见 skills/index.ts），把后续缩进行
 * 正确折叠/拼接成完整描述；缺失 frontmatter 或无对应键时按「省略」优雅降级，绝不伪造。
 *
 * 仅提取 name / description 两个标量键（与 skills/commands 详情展示所需一致），不做完整 YAML 解析。
 */
/**
 * 读取文件并抽取 frontmatter 的 name/description。
 * 文件读取失败视为“没有元数据”，返回 {}（不向上抛）。
 */
export function readMarkdownFrontmatter(filePath: string): {
  name?: string;
  description?: string;
} {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  return parseMarkdownFrontmatter(content);
}

/** 纯函数版：直接解析 Markdown 文本的 frontmatter，便于单测覆盖块标量分支。 */
export function parseMarkdownFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  const values = parseFlatYamlScalars(frontmatter);
  const result: { name?: string; description?: string } = {};
  const name = parseScalar(values.name);
  if (name) result.name = name;
  const description = parseScalar(values.description);
  if (description) result.description = description;
  return result;
}

/** 提取 `---` 包裹的 frontmatter 文本；BOM 会被去掉，首行必须正好是 ---，否则返回 null。 */
function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** 解析顶层 `key: value`，块标量（`>`/`|`）会把后续缩进行收进同一个键。只保留标量字符串值。 */
function parseFlatYamlScalars(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    // 缩进行属于上一个块标量的内容，顶层扫描跳过。
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in values) continue;
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
}

/** 识别块标量指示符：`>`=折叠、`|`=字面；带 +/− chomping 变体同样识别。 */
function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

/**
 * 读取块标量：收集后续缩进/空行直到下一个顶层键，按最小缩进统一去除。
 * nextIndex 返回块结束位置，供外层循环跳过已消费行。
 */
function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    // 非空且非缩进的行表示块标量结束（回到顶层键）。
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }
  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value:
      style === "folded"
        ? foldBlockScalarLines(contentLines)
        : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

/** 统计行首空白长度；用于计算块标量公共缩进。 */
function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

/** 折叠样式（`>`）：同段内换行折成空格，空行分段。 */
function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

/**
 * 归一化标量：去空白、去成对引号；空值返回 undefined（表示“省略”）。
 * 只处理单行值，块标量已在上层折叠完毕。
 */
function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
