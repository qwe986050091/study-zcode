import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b67-spec-03.json";
const ROOT = "d:/code/ZCode/";
const TARGET = "packages/ui/src/lib/markdownFileLink.ts";
const EXPECTED_TOTAL = 66;

const BAN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const errors = [];

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  errors.push("spec.files 必须且只能包含一个文件");
}
const entry = spec.files[0];
if (!entry || entry.file !== TARGET) {
  errors.push(`目标文件不符: ${entry && entry.file}`);
}

const srcLines = readFileSync(ROOT + TARGET, "utf8").split(/\r?\n/);
const items = entry.items;

// 第一项 anchor 必须等于文件首行
const firstSrcLine = srcLines[0].trim();
if (items[0].anchor !== firstSrcLine) {
  errors.push(`首项 anchor 与文件首行不一致: ${JSON.stringify(items[0].anchor)} vs ${JSON.stringify(firstSrcLine)}`);
}
if (!items[0].raw) errors.push("首项必须使用 raw");
if (items[0].raw && items[0].raw.length !== 22) {
  errors.push(`首项 raw 行数 ${items[0].raw.length} !== 22`);
}
if (items[0].raw) {
  const invCount = items[0].raw.filter((l) => l.startsWith("// INV-")).length;
  if (invCount !== 18) errors.push(`INV 条数 ${invCount} !== 18`);
  const separatorIdx = items[0].raw.indexOf("//");
  if (separatorIdx !== 18) errors.push(`分隔注释行位置 ${separatorIdx} !== 18`);
}

let total = 0;
for (const [idx, item] of items.entries()) {
  const tag = `item#${idx + 1}`;
  const body = item.raw ? item.raw : item.lines;
  if (!Array.isArray(body) || body.length === 0) {
    errors.push(`${tag} 缺少 raw/lines`);
    continue;
  }
  total += body.length;

  if (item.raw && idx !== 0) errors.push(`${tag} raw 仅允许用于文件头`);

  const anchor = item.anchor;
  if (typeof anchor !== "string" || anchor !== anchor.trim()) {
    errors.push(`${tag} anchor 未 trim 或非字符串`);
    continue;
  }

  let occurrences = 0;
  for (const line of srcLines) if (line.trim() === anchor) occurrences += 1;
  if (occurrences === 0) {
    errors.push(`${tag} anchor 不存在: ${JSON.stringify(anchor)}`);
  } else if (occurrences > 1) {
    if (typeof item.nth !== "number") {
      errors.push(`${tag} anchor 重复 ${occurrences} 次却缺 nth`);
    } else if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > occurrences) {
      errors.push(`${tag} nth=${item.nth} 越界（共 ${occurrences}）`);
    }
  } else if (item.nth !== undefined && item.nth !== 1) {
    errors.push(`${tag} anchor 唯一却给了 nth=${item.nth}`);
  }

  for (const [li, line] of body.entries()) {
    const where = `${tag} L${li + 1}`;
    if (typeof line !== "string") {
      errors.push(`${where} 非字符串`);
      continue;
    }
    let content;
    if (item.raw) {
      if (line === "//") content = "";
      else if (line.startsWith("// ")) content = line.slice(3);
      else {
        errors.push(`${where} raw 行格式非法: ${JSON.stringify(line)}`);
        continue;
      }
    } else {
      if (line.startsWith("//")) errors.push(`${where} lines 不应自带 //: ${line.slice(0, 40)}`);
      content = line;
    }

    if (line.includes("*/")) errors.push(`${where} 含 */`);
    if (content.endsWith(";")) errors.push(`${where} 以 ; 结尾: ${content}`);
    if (content.includes("=>")) errors.push(`${where} 含 =>`);
    if (CALL_RE.test(content)) errors.push(`${where} 含标识符点调用: ${content}`);
    if (content.trim() !== "") {
      const first = content.trim().split(/[\s，。；：、]/)[0];
      if (BAN_START.includes(first)) errors.push(`${where} 以禁词开头(${first}): ${content}`);
    }
  }
}

if (total !== EXPECTED_TOTAL) errors.push(`总行数 ${total} !== ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.log(JSON.stringify({ items: items.length, total, errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`OK items=${items.length} total=${total}`);
}
