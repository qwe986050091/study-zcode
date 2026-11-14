import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b60-spec-10.json";
const SRC = "d:/code/ZCode/packages/ui/src/lib/fileDisplay.tsx";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(SRC, "utf8").split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "error", "enum",
];

let total = 0;
let items = 0;
const problems = [];

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  problems.push("files 结构应为单元素数组");
}
const entry = spec.files[0];
if (entry.file !== "packages/ui/src/lib/fileDisplay.tsx") {
  problems.push(`file 路径不符: ${entry.file}`);
}
if (!Array.isArray(entry.items)) {
  problems.push("items 不是数组");
}

entry.items.forEach((item, idx) => {
  items += 1;
  const isRaw = Array.isArray(item.raw);
  const body = isRaw ? item.raw : item.lines;
  if (!Array.isArray(body)) {
    problems.push(`#${idx} 缺少 raw/lines`);
    return;
  }
  total += body.length;

  if (isRaw && idx !== 0) problems.push(`#${idx} raw 只允许用于文件头`);
  if (idx === 0 && !isRaw) problems.push("#0 必须是 raw 文件头");

  // anchor 匹配
  const anchor = item.anchor;
  const matches = [];
  trimmed.forEach((line, i) => {
    if (line === anchor) matches.push(i + 1);
  });
  const nth = item.nth ?? 1;
  if (matches.length === 0) {
    problems.push(`#${idx} anchor 未命中: ${JSON.stringify(anchor)}`);
  } else if (item.nth === undefined && matches.length !== 1) {
    problems.push(`#${idx} anchor 重复(${matches.length}) 需 nth: ${JSON.stringify(anchor)}`);
  } else if (nth < 1 || nth > matches.length) {
    problems.push(`#${idx} nth=${nth} 超出范围(命中 ${matches.length})`);
  }

  // 文本约束
  body.forEach((line, j) => {
    if (typeof line !== "string") {
      problems.push(`#${idx}[${j}] 非字符串`);
      return;
    }
    if (line.includes("*/")) problems.push(`#${idx}[${j}] 含 */`);
    if (line.includes("=>")) problems.push(`#${idx}[${j}] 含 =>`);
    if (line.trimEnd().endsWith(";")) problems.push(`#${idx}[${j}] 以 ; 结尾`);

    let text = line;
    if (isRaw) {
      if (!text.startsWith("//")) problems.push(`#${idx}[${j}] raw 行不以 // 开头`);
      text = text.slice(2);
      if (text.startsWith(" ")) text = text.slice(1);
    } else if (line.startsWith("//")) {
      problems.push(`#${idx}[${j}] 非 raw 行不应自带 // 前缀`);
    }
    const first = text.trim().split(/\s+/)[0]?.replace(/[：:].*$/, "") ?? "";
    if (banned.includes(first)) {
      problems.push(`#${idx}[${j}] 以禁用词开头: ${first}`);
    }
    if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(text.trim())) {
      problems.push(`#${idx}[${j}] 疑似 标识符.标识符( 调用形态`);
    }
  });
});

if (items !== 14) problems.push(`items 数量=${items}（期望 14：1 文件头 + 13）`);
if (total !== 70) problems.push(`总行数=${total}（期望 70）`);

const inv = (entry.items[0].raw ?? []).filter((l) => /\/\/ INV-\d\d /.test(l));
if (inv.length < 18 || inv.length > 20) problems.push(`INV 条数=${inv.length}（期望 18~20）`);
if (entry.items[0].raw.at(-1) !== "//") problems.push("文件头未以 // 空行收尾");

console.log(`items=${items} total=${total} inv=${inv.length}`);
if (problems.length) {
  console.log("FAIL");
  problems.forEach((p) => console.log(" - " + p));
  process.exit(1);
}
console.log("ALL PASS");
