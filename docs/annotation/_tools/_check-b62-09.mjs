import { readFileSync, existsSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b62-spec-09.json";
const TARGET = "d:/code/ZCode/packages/desktop/src/main/browserView/browserCommandInput.ts";
const EXPECTED = "packages/desktop/src/main/browserView/browserCommandInput.ts";
const TOTAL_EXPECTED = 69;

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export",
  "return", "if", "else", "for", "while", "switch", "try", "catch",
  "await", "async", "throw", "new", "interface", "type", "enum",
];
const CALL_SHAPE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
let total = 0;

for (const path of [SPEC, TARGET]) {
  if (!existsSync(path)) errors.push(`文件不存在: ${path}`);
}
if (errors.length) {
  console.log("FAIL:\n" + errors.join("\n"));
  process.exit(1);
}

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split(/\r?\n/);
const file = spec.files?.[0];

if (!file) errors.push("spec.files 为空");
if (file && file.file !== EXPECTED) errors.push(`文件路径不符: ${file.file}`);
if (!file || !Array.isArray(file.items) || file.items.length === 0) {
  errors.push("items 为空");
  console.log("FAIL:\n" + errors.join("\n"));
  process.exit(1);
}

const trimmed = srcLines.map((line, i) => ({ text: line.trim(), no: i + 1 }));

file.items.forEach((item, idx) => {
  const tag = `item#${idx + 1}`;

  if (idx === 0) {
    if (!Array.isArray(item.raw)) errors.push(`${tag} 首项缺少 raw`);
    if (item.lines) errors.push(`${tag} 首项不应同时带 lines`);
  } else {
    if (item.raw) errors.push(`${tag} raw 只允许出现在首项`);
    if (!Array.isArray(item.lines)) errors.push(`${tag} 缺少 lines`);
  }

  const body = idx === 0 ? item.raw || [] : item.lines || [];
  total += body.length;

  body.forEach((line, li) => {
    const where = `${tag} line#${li + 1}`;
    if (typeof line !== "string") {
      errors.push(`${where} 不是字符串`);
      return;
    }
    if (idx === 0) {
      if (!(line.startsWith("// ") || line === "//")) {
        errors.push(`${where} raw 行未以 // 或 // 空格开头: ${line}`);
      }
    } else {
      if (line.startsWith("//")) errors.push(`${where} lines 不应带 // 前缀: ${line}`);
      if (line.trim().length === 0) errors.push(`${where} lines 不应为空行`);
    }

    const text = line.startsWith("//") ? line.replace(/^\/\/ ?/, "") : line;

    if (text.includes("*/")) errors.push(`${where} 含 */`);
    if (text.includes("=>")) errors.push(`${where} 含 =>`);
    if (text.trimEnd().endsWith(";")) errors.push(`${where} 以 ; 结尾`);
    if (CALL_SHAPE.test(text)) errors.push(`${where} 出现 标识符.标识符( 调用形态`);

    const first = (text.split(/\s+/)[0] || "").toLowerCase();
    if (FORBIDDEN_START.includes(first)) errors.push(`${where} 以禁词开头: ${first}`);
  });

  if (typeof item.anchor !== "string" || item.anchor.trim().length === 0) {
    errors.push(`${tag} anchor 为空`);
    return;
  }
  const hits = trimmed.filter((entry) => entry.text === item.anchor.trim());
  if (hits.length === 0) {
    errors.push(`${tag} anchor 未匹配: ${JSON.stringify(item.anchor)}`);
    return;
  }
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
      errors.push(`${tag} nth 越界: nth=${item.nth} 实际匹配=${hits.length}`);
    }
  } else if (hits.length > 1) {
    errors.push(`${tag} anchor 重复 ${hits.length} 次但未指定 nth: ${JSON.stringify(item.anchor)}`);
  }
});

if (total !== TOTAL_EXPECTED) errors.push(`总行数 ${total} !== ${TOTAL_EXPECTED}`);

const head = file.items[0].raw || [];
const invs = head.filter((line) => /^\/\/ INV-\d{2} /.test(line));
if (invs.length !== 18) errors.push(`INV 条数 ${invs.length} !== 18`);
invs.forEach((line, i) => {
  const expected = `// INV-${String(i + 1).padStart(2, "0")} `;
  if (!line.startsWith(expected)) errors.push(`INV 编号不连续: ${line.slice(0, 12)}`);
  if (!line.includes("守住位置：") || !line.includes("改错故障：")) {
    errors.push(`INV 缺字段: ${line.slice(0, 20)}`);
  }
});

console.log(`items=${file.items.length} total=${total} anchors=${file.items.length}`);
if (errors.length) {
  console.log("FAIL:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("OK");
