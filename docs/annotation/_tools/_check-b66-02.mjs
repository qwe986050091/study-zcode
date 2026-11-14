import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b66-spec-02.json";
const ROOT = "d:/code/ZCode";
const TARGET = "packages/ui/src/ToolCallBlocks/renderers/list-models.tsx";

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
if (!spec || !Array.isArray(spec.files)) fail("spec.files 缺失");
if (spec.files.length !== 1) fail("files 必须只有一项，实际 " + spec.files.length);

const entry = spec.files[0];
if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) fail("items 缺失");
if (typeof entry.file !== "string") fail("file 字段缺失");

const sourcePath = ROOT + "/" + entry.file;
const sourceLines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
const trimmedSource = sourceLines.map((line) => line.trim());
const firstLine = trimmedSource[0];

let total = 0;
const counts = [];

entry.items.forEach((item, index) => {
  if (typeof item.anchor !== "string") fail("items[" + index + "] anchor 不是字符串");
  const anchor = item.anchor.trim();
  if (anchor.length === 0) fail("items[" + index + "] anchor 为空");
  const occurrences = trimmedSource.filter((line) => line === anchor).length;
  const nth = item.nth === undefined ? 1 : item.nth;
  if (!Number.isInteger(nth) || nth < 1) fail("items[" + index + "] nth 非法: " + item.nth);
  if (occurrences < nth) {
    fail("items[" + index + "] anchor 不存在（出现 " + occurrences + " 次，需要第 " + nth + " 次）: " + anchor);
  }
  if (occurrences > 1 && item.nth === undefined) {
    fail("items[" + index + "] anchor 出现 " + occurrences + " 次但未声明 nth: " + anchor);
  }
  if (index === 0 && anchor !== firstLine) fail("第一项 anchor 不等于文件首行");
  if (index === 0 && Array.isArray(item.lines)) fail("第一项应使用 raw，不应有 lines");

  const payloads = [];
  if (Array.isArray(item.raw)) {
    for (const line of item.raw) {
      if (typeof line !== "string") fail("items[" + index + "] raw 含非字符串");
      if (!line.startsWith("//")) fail("items[" + index + "] raw 行必须以 // 开头: " + line);
      payloads.push(line.replace(/^\/\//, ""));
    }
  }
  if (Array.isArray(item.lines)) {
    for (const line of item.lines) {
      if (typeof line !== "string") fail("items[" + index + "] lines 含非字符串");
      payloads.push(line);
    }
  }
  if (!Array.isArray(item.raw) && !Array.isArray(item.lines)) {
    fail("items[" + index + "] 既无 raw 也无 lines");
  }
  if (Array.isArray(item.raw) && Array.isArray(item.lines)) {
    fail("items[" + index + "] 同时存在 raw 与 lines");
  }

  payloads.forEach((payload) => {
    const text = payload.trim();
    if (text.includes("*/")) fail("items[" + index + "] 含 */ : " + text);
    if (text.endsWith(";")) fail("items[" + index + "] 以 ; 结尾: " + text);
    if (text.includes("=>")) fail("items[" + index + "] 含 => : " + text);
    if (CALL_RE.test(text)) fail("items[" + index + "] 含调用表达式: " + text);
    const head = text.toLowerCase();
    for (const word of BANNED_START) {
      if (head === word || head.startsWith(word + " ") || head.startsWith(word + "(") || head.startsWith(word + ":") || head.startsWith(word + "\t")) {
        fail("items[" + index + "] 以禁词开头（" + word + "）: " + text);
      }
    }
  });

  const lineCount = payloads.length;
  total += lineCount;
  counts.push({ index, anchor, count: lineCount });
});

if (entry.items[0].raw.length !== 22) {
  fail("第一项 raw 应为 22 行，实际 " + entry.items[0].raw.length);
}
if (total !== 67) fail("注释总行数应为 67，实际 " + total);

console.log("OK");
console.log("file: " + entry.file);
console.log("items: " + entry.items.length);
console.log("total comment lines: " + total);
for (const info of counts) {
  console.log("  #" + info.index + " (" + info.count + " 行) " + info.anchor);
}
