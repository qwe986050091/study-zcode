import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b69-spec-08.json";
const TARGET_PATH = "d:/code/ZCode/apps/zcode-cli/packages/adapters/src/browser/page-command.ts";
const EXPECTED_LINES = 64;

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const fileLines = readFileSync(TARGET_PATH, "utf8").split(/\r?\n/);

const FORBIDDEN_WORDS = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);

const problems = [];
const fail = (msg) => problems.push(msg);

const entry = spec.files?.[0];
if (!entry) fail("spec.files[0] 缺失");
if (entry.file !== "apps/zcode-cli/packages/adapters/src/browser/page-command.ts") {
  fail(`file 路径不符: ${entry.file}`);
}
const items = entry.items ?? [];
if (items.length === 0) fail("items 为空");

let totalInserted = 0;
const insertionMap = new Map();

const insertedLinesOf = (item) => {
  if (Array.isArray(item.raw)) return item.raw;
  if (Array.isArray(item.lines)) return item.lines;
  return null;
};

items.forEach((item, itemIndex) => {
  const anchor = String(item.anchor ?? "");
  if (!anchor.trim()) {
    fail(`item#${itemIndex} anchor 为空`);
    return;
  }
  const matches = [];
  fileLines.forEach((line, idx) => {
    if (line.trim() === anchor.trim()) matches.push(idx);
  });
  if (matches.length === 0) {
    fail(`item#${itemIndex} anchor 未命中: ${JSON.stringify(anchor)}`);
    return;
  }
  const nth = item.nth ?? 1;
  if (!Number.isInteger(nth) || nth < 1 || nth > matches.length) {
    fail(`item#${itemIndex} nth=${nth} 超出命中数 ${matches.length}`);
    return;
  }
  if (nth === 1 && matches.length > 1 && item.nth === undefined) {
    fail(`item#${itemIndex} anchor 不唯一(${matches.length} 次)且未声明 nth`);
    return;
  }
  const insertIndex = matches[nth - 1];

  const lines = insertedLinesOf(item);
  if (!lines) {
    fail(`item#${itemIndex} 缺少 raw/lines`);
    return;
  }
  if (itemIndex === 0) {
    if (!Array.isArray(item.raw)) fail("文件头 item 必须使用 raw");
    if (lines.length !== 22) fail(`文件头 raw 长度 ${lines.length} !== 22`);
    if (!lines[0]?.startsWith("// INV-01")) fail(`文件头首行未以 // INV-01 开头: ${lines[0]}`);
    if (lines[18] !== "//") fail(`文件头第 19 行不是 //: ${JSON.stringify(lines[18])}`);
    if (!lines[21]?.startsWith("// 阅读顺序：")) fail("文件头末行不是 阅读顺序");
  } else {
    if (!Array.isArray(item.lines)) fail(`item#${itemIndex} 应使用 lines`);
    if (lines.length < 3 || lines.length > 6) fail(`item#${itemIndex} 行数 ${lines.length} 不在 3~6`);
  }

  totalInserted += lines.length;

  if (insertionMap.has(insertIndex)) {
    fail(`插入下标重复: ${insertIndex} (item#${itemIndex} 与 item#${insertionMap.get(insertIndex).itemIndex})`);
  } else {
    insertionMap.set(insertIndex, { itemIndex, lines });
  }

  lines.forEach((raw, lineIndex) => {
    const source = String(raw);
    // lines 项由插入器统一加 "// " 前缀；raw 项自带整行注释
    const line = itemIndex === 0 ? source : source.trim() === "" ? "//" : "// " + source;
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) {
      fail(`item#${itemIndex}[${lineIndex}] 未以 // 开头: ${JSON.stringify(line)}`);
      return;
    }
    if (trimmed.includes("*/")) fail(`item#${itemIndex}[${lineIndex}] 含 */`);
    const text = trimmed.slice(2).trim();
    if (text.endsWith(";")) fail(`item#${itemIndex}[${lineIndex}] 以分号结尾: ${text}`);
    if (text.includes("=>")) fail(`item#${itemIndex}[${lineIndex}] 含箭头: ${text}`);
    const head = text.match(/^([A-Za-z_$][\w$]*)/);
    if (head && FORBIDDEN_WORDS.has(head[1])) {
      fail(`item#${itemIndex}[${lineIndex}] 以禁止词 ${head[1]} 开头: ${text}`);
    }
    if (/[A-Za-z_$][\w$]*(\.[\w$]+)+\s*\(/.test(text)) {
      fail(`item#${itemIndex}[${lineIndex}] 含调用表达式: ${text}`);
    }
  });
});

if (totalInserted !== EXPECTED_LINES) {
  fail(`插入总行数 ${totalInserted} !== ${EXPECTED_LINES}`);
}

if (problems.length > 0) {
  console.error("FAIL");
  problems.forEach((p) => console.error(" - " + p));
  process.exit(1);
}

console.log(`OK blocks=${items.length} lines=${totalInserted}`);
