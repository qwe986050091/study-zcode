import { readFileSync } from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b63-spec-10.json";
const TARGET = "d:\\code\\ZCode\\packages\\ui\\src\\components\\ai-elements\\web-preview.tsx";
const EXPECT_TOTAL = 67;

const BANNED_START = [
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
const BANNED_START_RE = new RegExp(`^(${BANNED_START.join("|")})\\b`);
const METHOD_CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const fail = (msg) => errors.push(msg);

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split(/\r?\n/);

const fileEntry = Array.isArray(spec.files) ? spec.files[0] : null;
if (!fileEntry) fail("缺 files[0]");
const items = fileEntry?.items;
if (!Array.isArray(items) || items.length === 0) fail("items 非空校验失败");

const stripPrefix = (line) => {
  if (line.startsWith("// ")) return line.slice(3);
  if (line === "//") return "";
  return null;
};

const checkBody = (body, where) => {
  if (typeof body !== "string") return fail(`${where}: 非字符串`);
  if (body.trim() === "") return;
  if (body.includes("*/")) fail(`${where}: 含 */`);
  if (BANNED_START_RE.test(body)) fail(`${where}: 以禁用关键字开头 -> ${body}`);
  if (body.endsWith(";")) fail(`${where}: 以 ; 结尾 -> ${body}`);
  if (body.includes("=>")) fail(`${where}: 含 =>`);
  if (METHOD_CALL_RE.test(body)) fail(`${where}: 含方法调用形态 -> ${body}`);
};

let total = 0;
let anchorCount = 0;

(items ?? []).forEach((item, idx) => {
  const where = `items[${idx}]`;

  if (idx === 0) {
    if (!Array.isArray(item.raw) || item.raw.length === 0) {
      fail(`${where}: 首项必须提供非空 raw`);
    } else {
      item.raw.forEach((line, i) => {
        const body = stripPrefix(line);
        if (body === null) fail(`${where}.raw[${i}]: 未以 // 开头 -> ${line}`);
        else checkBody(body, `${where}.raw[${i}]`);
      });
      total += item.raw.length;
    }
  } else {
    if (!Array.isArray(item.lines) || item.lines.length === 0) {
      fail(`${where}: 非首项必须提供非空 lines`);
    } else {
      item.lines.forEach((body, i) => checkBody(body, `${where}.lines[${i}]`));
      total += item.lines.length;
    }
  }

  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(`${where}: anchor 缺失`);
    return;
  }
  const trimmed = item.anchor.trim();
  const hits = srcLines.reduce((acc, line, lineNo) => {
    if (line.trim() === trimmed) acc.push(lineNo + 1);
    return acc;
  }, []);
  anchorCount += 1;
  if (hits.length === 0) {
    fail(`${where}: anchor 未匹配 -> ${item.anchor}`);
    return;
  }
  const nth = item.nth === undefined ? 1 : item.nth;
  if (!Number.isInteger(nth) || nth < 1) {
    fail(`${where}: nth 非法 -> ${item.nth}`);
    return;
  }
  if (nth > hits.length) {
    fail(`${where}: nth 越界 (nth=${nth}, hits=${hits.length}) -> ${item.anchor}`);
    return;
  }
  if (hits.length > 1 && item.nth === undefined) {
    fail(`${where}: anchor 不唯一 (${hits.length} 处, 行 ${hits.join(",")}) -> ${item.anchor}`);
  }
});

if (total !== EXPECT_TOTAL) fail(`总行数不符: ${total} !== ${EXPECT_TOTAL}`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK total=${total} anchors=${anchorCount}`);
