import fs from "node:fs";
import path from "node:path";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b64-spec-03.json";
const ROOT = "d:/code/ZCode";
const EXPECTED_FILE = "packages/ui/src/browser-use/BrowserViewportToolbar.tsx";
const EXPECTED_LINES = 66;
const HEADER_LINES = 22;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
if (!spec.files || !Array.isArray(spec.files) || spec.files.length !== 1) {
  fail(`spec.files 必须只有一个文件项，实际 ${Array.isArray(spec.files) ? spec.files.length : "非数组"}`);
}
const entry = spec.files[0];
if (entry.file !== EXPECTED_FILE) fail(`file 不符: ${entry.file}`);

const KEYWORDS = [
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
const START_RE = new RegExp(`^(?:${KEYWORDS.join("|")})\\b`);
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const stripPrefix = (line) => line.replace(/^\/\/ ?/, "");

const checkText = (text, where) => {
  if (text.includes("*/")) fail(`${where} 含禁词 */`);
  if (START_RE.test(text)) fail(`${where} 以关键字开头: ${text}`);
  if (text.endsWith(";")) fail(`${where} 以 ; 结尾: ${text}`);
  if (text.includes("=>")) fail(`${where} 含 =>: ${text}`);
  const m = text.match(CALL_RE);
  if (m) fail(`${where} 含调用式片段 ${m[0]}: ${text}`);
};

const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

const targetPath = path.join(ROOT, entry.file);
const rawLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
const firstLine = rawLines[0].trim();

let total = 0;
let anchorCount = 0;

items.forEach((item, index) => {
  const where = `items[${index}]`;
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(`${where} anchor 缺失`);
  }
  const hasRaw = Array.isArray(item.raw);
  const hasLines = Array.isArray(item.lines);

  if (index === 0) {
    if (!hasRaw) fail(`${where} 首项必须提供 raw`);
    if (hasLines) fail(`${where} 首项不应同时提供 lines`);
    if (item.raw.length !== HEADER_LINES) {
      fail(`${where} raw 行数 ${item.raw.length} 不等于 ${HEADER_LINES}`);
    }
    item.raw.forEach((line, i) => {
      if (typeof line !== "string" || !(line === "//" || line.startsWith("// "))) {
        fail(`${where} raw[${i}] 不是合法整行注释: ${JSON.stringify(line)}`);
      }
      checkText(stripPrefix(line), `${where} raw[${i}]`);
    });
    if (item.anchor.trim() !== firstLine) {
      fail(`${where} 首项 anchor 不等于文件首行: ${JSON.stringify(item.anchor)}`);
    }
    total += item.raw.length;
  } else {
    if (!hasLines) fail(`${where} 必须提供 lines`);
    if (hasRaw) fail(`${where} 非首项不应提供 raw`);
    if (item.lines.length === 0) fail(`${where} lines 为空`);
    item.lines.forEach((line, i) => {
      if (typeof line !== "string") fail(`${where} lines[${i}] 不是字符串`);
      if (line.trim() === "") return;
      if (line.startsWith("//")) fail(`${where} lines[${i}] 不应自带注释前缀`);
      checkText(line, `${where} lines[${i}]`);
    });
    total += item.lines.length;
  }

  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) fail(`${where} nth 非法: ${item.nth}`);
  }

  const anchor = item.anchor.trim();
  const hits = [];
  rawLines.forEach((line, i) => {
    if (line.trim() === anchor) hits.push(i + 1);
  });
  if (hits.length === 0) fail(`${where} anchor 未命中: ${JSON.stringify(item.anchor)}`);
  if (item.nth === undefined) {
    if (hits.length > 1) {
      fail(`${where} anchor 命中 ${hits.length} 次（行 ${hits.join(",")}），需指定 nth`);
    }
  } else if (item.nth > hits.length) {
    fail(`${where} nth=${item.nth} 越界，命中 ${hits.length} 次`);
  }
  anchorCount += 1;
});

if (total !== EXPECTED_LINES) fail(`总插入行数 ${total} 不等于 ${EXPECTED_LINES}`);

console.log(`file: ${entry.file}`);
console.log(`blocks: ${items.length}`);
console.log(`anchors: ${anchorCount}`);
console.log(`lines: ${total}`);
console.log("OK");
