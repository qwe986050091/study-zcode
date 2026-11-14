import fs from "node:fs";
import path from "node:path";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b65-spec-10.json";
const ROOT = "d:/code/ZCode";
const EXPECTED_TOTAL = 65;
const HEADER_LINES = 22;
const FORBIDDEN = [
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
const FORBIDDEN_START = new RegExp(`^(${FORBIDDEN.join("|")})\\b`);
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

let spec;
try {
  spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
} catch (error) {
  fail(`JSON 不可解析: ${error.message}`);
}

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail(`files 必须是长度为 1 的数组，实际 ${spec.files?.length}`);
}

const entry = spec.files[0];
if (entry.file !== "apps/zcode-cli/packages/cli/src/arguments.ts") {
  fail(`file 字段不符合预期: ${entry.file}`);
}
if (!Array.isArray(entry.items) || entry.items.length === 0) {
  fail("items 必须是非空数组");
}

const abs = path.join(ROOT, entry.file);
if (!fs.existsSync(abs)) fail(`源文件不存在: ${abs}`);
const fileLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);

const checkLine = (text, label) => {
  if (typeof text !== "string") fail(`${label} 不是字符串`);
  if (text.includes("*/")) fail(`${label} 含 */: ${text}`);
  if (text.trimEnd().endsWith(";")) fail(`${label} 以 ; 结尾: ${text}`);
  if (text.includes("=>")) fail(`${label} 含 =>: ${text}`);
  if (CALL_EXPR.test(text)) fail(`${label} 含调用表达式: ${text}`);
  const body = text.replace(/^\s*\/\/\s?/, "").trim();
  if (body && FORBIDDEN_START.test(body)) {
    fail(`${label} 以禁词开头: ${text}`);
  }
};

let total = 0;
let headerChecked = false;

entry.items.forEach((item, itemIndex) => {
  const label = `item[${itemIndex}]`;
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(`${label} anchor 缺失`);
  }
  const anchor = item.anchor.trim();
  const matches = [];
  fileLines.forEach((line, idx) => {
    if (line.trim() === anchor) matches.push(idx);
  });
  if (matches.length === 0) fail(`${label} anchor 不存在: ${anchor}`);
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
      fail(`${label} nth 非法: ${item.nth} / ${matches.length}`);
    }
  } else if (matches.length !== 1) {
    fail(`${label} anchor 不唯一(${matches.length}): ${anchor}`);
  }

  let lines;
  if (Array.isArray(item.raw)) {
    if (item.lines !== undefined) fail(`${label} 同时存在 raw 与 lines`);
    lines = item.raw;
  } else if (Array.isArray(item.lines)) {
    lines = item.lines;
  } else {
    fail(`${label} 缺少 raw 或 lines`);
  }
  if (lines.length === 0) fail(`${label} 行数为 0`);

  if (itemIndex === 0) {
    headerChecked = true;
    if (anchor !== fileLines[0].trim()) {
      fail(`第一项 anchor 不等于文件首行: ${anchor}`);
    }
    if (lines.length !== HEADER_LINES) {
      fail(`第一项必须 ${HEADER_LINES} 行，实际 ${lines.length}`);
    }
    const invCount = lines.filter((l) => /^\/\/ INV-\d+\b/.test(l)).length;
    if (invCount !== 18) fail(`第一项 INV 条数应为 18，实际 ${invCount}`);
  }

  lines.forEach((line, i) => checkLine(line, `${label}.line[${i}]`));
  total += lines.length;
});

if (!headerChecked) fail("缺少文件头项");
if (total !== EXPECTED_TOTAL) fail(`总行数应为 ${EXPECTED_TOTAL}，实际 ${total}`);

console.log("OK");
console.log(`items=${entry.items.length} total=${total}`);
