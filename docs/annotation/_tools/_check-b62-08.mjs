import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b62-spec-08.json";
const TARGET = "d:/code/ZCode/packages/ui/src/settings/MigrationSection.tsx";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split(/\r?\n/);
const file = spec.files[0];

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errors = [];
const warns = [];
let total = 0;

const bodyLines = (item) => (item.raw ? item.raw : item.lines || []);

if (file.file !== "packages/ui/src/settings/MigrationSection.tsx") {
  errors.push(`文件路径不符: ${file.file}`);
}

file.items.forEach((item, idx) => {
  const lines = bodyLines(item);
  total += lines.length;

  if (item.raw && idx !== 0) errors.push(`item#${idx + 1} raw 只允许用于文件头`);

  const anchors = srcLines
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((entry) => entry.line === item.anchor.trim());

  if (anchors.length === 0) {
    errors.push(`item#${idx + 1} anchor 未匹配: ${JSON.stringify(item.anchor)}`);
  }
  if (anchors.length > 1 && !item.nth) {
    errors.push(`item#${idx + 1} anchor 重复 ${anchors.length} 次但缺少 nth: ${JSON.stringify(item.anchor)}`);
  }
  if (item.nth) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > anchors.length) {
      errors.push(`item#${idx + 1} nth 越界: nth=${item.nth} 实际=${anchors.length}`);
    }
    if (anchors.length === 1) warns.push(`item#${idx + 1} 写了 nth 但 anchor 实际唯一`);
  }
  if (anchors.length === 1 && !item.nth) {
    // 唯一性检查通过
  }

  lines.forEach((line, li) => {
    const where = `item#${idx + 1} line#${li + 1}`;
    if (typeof line !== "string") {
      errors.push(`${where} 不是字符串`);
      return;
    }
    if (item.raw) {
      if (!line.startsWith("//")) errors.push(`${where} raw 行未以 // 开头: ${line}`);
    } else if (line !== "" && line.trim().length === 0) {
      errors.push(`${where} 普通行应为空字符串或有效文本`);
    }

    const text = line.startsWith("//") ? line.slice(2).trimStart() : line;
    if (line.startsWith("//") && text.length === 0 && !item.raw) {
      errors.push(`${where} 普通 item 不应出现纯空注释行`);
    }
    if (line.includes("*/")) errors.push(`${where} 含 */`);
    if (line.includes("=>")) errors.push(`${where} 含 =>`);
    if (text.trimEnd().endsWith(";")) errors.push(`${where} 以 ; 结尾`);
    if (text.trimEnd().endsWith("；")) errors.push(`${where} 以全角；结尾`);
    const first = text.split(/\s+/)[0] || "";
    if (FORBIDDEN_START.includes(first)) {
      errors.push(`${where} 以禁词开头: ${first}`);
    }
    if (/[\w$]+\.[\w$]+\(/.test(text)) {
      errors.push(`${where} 出现 标识符.标识符( 调用形态`);
    }
    if (text.length > 0 && !/[\u4e00-\u9fa5]/.test(text)) {
      warns.push(`${where} 无中文: ${text}`);
    }
  });
});

// 文件头专项校验
const head = bodyLines(file.items[0]);
const invs = head.filter((line) => /^\/\/ INV-\d{2} /.test(line));
if (invs.length < 18 || invs.length > 20) errors.push(`INV 条数 ${invs.length} 不在 18~20`);
invs.forEach((line) => {
  if (!line.includes("守住位置：") || !line.includes("改错故障：")) {
    errors.push(`INV 缺字段: ${line}`);
  }
});
if (head[head.length - 1] !== "//") errors.push(`文件头末行不是 //: ${head[head.length - 1]}`);
if (!file.items[0].raw) errors.push("首个 item 不是 raw");

// 文件头必须在首条 import 之前
const firstImportNo = srcLines.findIndex((line) => line.trim().startsWith("import ")) + 1;
const headAnchorNo = srcLines.findIndex((line) => line.trim() === file.items[0].anchor.trim()) + 1;
if (headAnchorNo !== firstImportNo) errors.push(`文件头锚点不是首条 import: anchor=${headAnchorNo} import=${firstImportNo}`);

console.log(`items=${file.items.length} total=${total}`);
console.log(`anchors: ${file.items.filter((it) => it.anchor).length}`);
if (warns.length) console.log("WARN:\n" + warns.join("\n"));
if (errors.length) {
  console.log("FAIL:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
