import fs from "node:fs";
import path from "node:path";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b63-spec-12.json";
const ROOT = "d:/code/ZCode";
const EXPECTED_LINES = 67;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
if (!spec.files || !Array.isArray(spec.files) || spec.files.length === 0) {
  fail("spec.files 为空");
}

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

let total = 0;
let anchorCount = 0;

for (const entry of spec.files) {
  const targetPath = path.join(ROOT, entry.file);
  const source = fs.readFileSync(targetPath, "utf8");
  const rawLines = source.split(/\r?\n/);
  const items = entry.items;
  if (!Array.isArray(items) || items.length === 0) fail(`${entry.file} items 为空`);

  items.forEach((item, index) => {
    const where = `${entry.file} items[${index}]`;
    if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
      fail(`${where} anchor 缺失`);
    }
    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (index === 0) {
      if (!hasRaw) fail(`${where} 首项必须提供 raw`);
      if (hasLines) fail(`${where} 首项不应同时提供 lines`);
      if (item.raw.length === 0) fail(`${where} raw 为空`);
      item.raw.forEach((line, i) => {
        if (typeof line !== "string" || !(line === "//" || line.startsWith("// "))) {
          fail(`${where} raw[${i}] 不是合法整行注释: ${line}`);
        }
        checkText(stripPrefix(line), `${where} raw[${i}]`);
      });
      total += item.raw.length;
    } else {
      if (!hasLines) fail(`${where} 必须提供 lines`);
      if (hasRaw) fail(`${where} 非首项不应提供 raw`);
      if (item.lines.length === 0) fail(`${where} lines 为空`);
      item.lines.forEach((line, i) => {
        if (typeof line !== "string" || line.trim() === "") {
          fail(`${where} lines[${i}] 为空`);
        }
        if (line.startsWith("//")) fail(`${where} lines[${i}] 不应自带注释前缀`);
        checkText(line, `${where} lines[${i}]`);
      });
      total += item.lines.length;
    }

    const anchor = item.anchor.trim();
    const hits = [];
    rawLines.forEach((line, i) => {
      if (line.trim() === anchor) hits.push(i + 1);
    });
    if (hits.length === 0) fail(`${where} anchor 未命中: ${JSON.stringify(item.anchor)}`);
    const nth = item.nth === undefined ? null : item.nth;
    if (nth === null) {
      if (hits.length > 1) {
        fail(`${where} anchor 命中 ${hits.length} 次（行 ${hits.join(",")}），需指定 nth`);
      }
    } else {
      if (!Number.isInteger(nth) || nth < 1) fail(`${where} nth 非法: ${nth}`);
      if (nth > hits.length) fail(`${where} nth=${nth} 越界，命中 ${hits.length} 次`);
    }
    anchorCount += 1;
  });
}

if (total !== EXPECTED_LINES) fail(`总行数 ${total} 不等于 ${EXPECTED_LINES}`);

console.log(`file: packages/ui/src/store/skillStore.ts`);
console.log(`items: ${spec.files[0].items.length}`);
console.log(`anchors: ${anchorCount}`);
console.log(`lines: ${total}`);
console.log("OK");
