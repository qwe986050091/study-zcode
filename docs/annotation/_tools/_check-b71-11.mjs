import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b71-spec-11.json";
const targetPath = "d:/code/ZCode/packages/ui/src/v4/V4ConversationContext.tsx";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = readFileSync(targetPath, "utf8");
const lines = source.split(/\r?\n/);

const forbidden = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "await",
  "async",
  "throw",
  "new",
  "interface",
  "type",
  "enum",
];

const errors = [];
let total = 0;
let blocks = 0;
const usedIndices = new Map();

function fail(msg) {
  errors.push(msg);
}

function validateInserted(lineText, label) {
  const trimmed = lineText.trim();
  if (!trimmed.startsWith("//")) fail(`${label}: 不是整行注释: ${JSON.stringify(lineText)}`);
  if (trimmed.includes("*/")) fail(`${label}: 含 */`);
  const body = trimmed.slice(2).trim();
  if (body.length === 0) return;
  for (const word of forbidden) {
    if (body === word || body.startsWith(word + " ") || body.startsWith(word + "\u3000")) {
      fail(`${label}: 注释正文以禁用词 ${word} 开头: ${body}`);
    }
  }
  if (body.endsWith(";")) fail(`${label}: 注释正文以分号结尾: ${body}`);
  if (body.includes("=>")) fail(`${label}: 含箭头表达式: ${body}`);
  if (/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body)) {
    fail(`${label}: 含调用表达式: ${body}`);
  }
}

const fileSpec = spec.files[0];
if (fileSpec.file !== "packages/ui/src/v4/V4ConversationContext.tsx") {
  fail(`目标路径不符: ${fileSpec.file}`);
}

for (let itemIndex = 0; itemIndex < fileSpec.items.length; itemIndex += 1) {
  const item = fileSpec.items[itemIndex];
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === item.anchor) matches.push(i);
  }

  let anchorIndex;
  if (typeof item.nth === "number") {
    if (!Number.isInteger(item.nth) || item.nth < 1) fail(`item ${itemIndex}: nth 非法`);
    if (matches.length < item.nth) {
      fail(`item ${itemIndex}: nth=${item.nth} 越界，仅命中 ${matches.length} 次`);
      continue;
    }
    anchorIndex = matches[item.nth - 1];
  } else {
    if (matches.length !== 1) {
      fail(`item ${itemIndex}: 锚点命中 ${matches.length} 次，不唯一: ${JSON.stringify(item.anchor)}`);
      continue;
    }
    anchorIndex = matches[0];
  }

  if (usedIndices.has(anchorIndex)) {
    fail(`item ${itemIndex}: 与 item ${usedIndices.get(anchorIndex)} 使用同一插入下标 ${anchorIndex}`);
  }
  usedIndices.set(anchorIndex, itemIndex);

  const indent = (lines[anchorIndex].match(/^\s*/) ?? [""])[0];
  let inserted = [];
  if (Array.isArray(item.raw)) {
    if (typeof item.lines !== "undefined") fail(`item ${itemIndex}: raw 与 lines 同时存在`);
    inserted = item.raw.map((text) => (text === "" ? "//" : text));
  } else if (Array.isArray(item.lines)) {
    inserted = item.lines.map((text) => (text === "" ? `${indent}//` : `${indent}// ${text}`));
  } else {
    fail(`item ${itemIndex}: 缺少 raw 或 lines`);
    continue;
  }

  const isHeader = itemIndex === 0 && Array.isArray(item.raw);
  if (!isHeader && (inserted.length < 3 || inserted.length > 6)) {
    fail(`item ${itemIndex}: 块行数 ${inserted.length} 不在 3~6 之间`);
  }

  inserted.forEach((text, i) => validateInserted(text, `item ${itemIndex} 行 ${i}`));
  total += inserted.length;
  blocks += 1;
}

if (total !== 65) fail(`插入总行数 ${total} !== 65`);

const headerRaw = fileSpec.items[0]?.raw;
if (!Array.isArray(headerRaw)) {
  fail("文件头缺少 raw");
} else {
  if (headerRaw.length !== 22) fail(`文件头 raw 长度 ${headerRaw.length} !== 22`);
  if (!headerRaw[0].startsWith("// INV-01")) fail(`文件头首行不是 // INV-01: ${headerRaw[0]}`);
  if (headerRaw[18] !== "//") fail(`文件头第 19 行不是 //: ${JSON.stringify(headerRaw[18])}`);
}

if (errors.length > 0) {
  console.error("FAIL");
  errors.forEach((error) => console.error("- " + error));
  process.exit(1);
}

console.log(`OK blocks=${blocks} lines=${total}`);
