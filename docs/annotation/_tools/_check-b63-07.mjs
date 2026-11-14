import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = "d:/code/ZCode";
const SPEC = "d:/code/_annot_baseline/ZC-deep-b63-spec-07.json";
const EXPECTED_TOTAL = 68;

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const fail = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

const files = spec.files;
if (!Array.isArray(files) || files.length === 0) fail("files 为空");
if (files.length !== 1) fail("files 长度应为 1，实际 " + files.length);

const entry = files[0];
const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

const target = resolve(ROOT, entry.file);
const src = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

const BANNED_STARTS = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const MEMBER_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let total = 0;
let anchorCount = 0;

const checkBody = (body, where) => {
  if (body.includes("*/")) fail(where + " 含 */");
  if (body.endsWith(";")) fail(where + " 以分号结尾");
  if (body.includes("=>")) fail(where + " 含 =>");
  if (MEMBER_CALL.test(body)) fail(where + " 含成员调用模式：" + body);
  const head = body.match(/^[A-Za-z_$][\w$]*/);
  if (head && BANNED_STARTS.includes(head[0])) {
    const rest = body.slice(head[0].length, head[0].length + 1);
    if (rest === "" || /[\s:=(]/.test(rest)) fail(where + " 以禁用关键字开头：" + head[0]);
  }
};

items.forEach((item, i) => {
  const where = "items[" + i + "]";
  if (typeof item.anchor !== "string") fail(where + " 缺少 anchor");
  const anchor = item.anchor.trim();
  const hits = lines
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter((x) => x.line === anchor);
  if (hits.length === 0) fail(where + " anchor 未命中：" + anchor);
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) fail(where + " nth 非法");
    if (item.nth > hits.length) fail(where + " nth 越界：" + item.nth + " > " + hits.length);
  } else if (hits.length > 1) {
    fail(where + " anchor 不唯一（" + hits.length + " 次），需 nth：" + anchor);
  }
  anchorCount += 1;

  if (i === 0) {
    if (!Array.isArray(item.raw) || item.raw.length === 0) fail("首项必须有 raw");
    if (item.lines !== undefined) fail("首项不应同时带 lines");
    item.raw.forEach((line, j) => {
      if (typeof line !== "string") fail("raw[" + j + "] 不是字符串");
      if (!(line.startsWith("// ") || line.startsWith("//"))) {
        fail("raw[" + j + "] 未以 // 开头：" + line);
      }
      const body = line.replace(/^\/\/ ?/, "").trim();
      checkBody(body, "raw[" + j + "]");
    });
    total += item.raw.length;
  } else {
    if (!Array.isArray(item.lines) || item.lines.length === 0) fail(where + " 必须有 lines");
    if (item.raw !== undefined) fail(where + " 不应带 raw");
    item.lines.forEach((line, j) => {
      if (typeof line !== "string" || line.trim() === "") fail(where + ".lines[" + j + "] 非法");
      checkBody(line.trim(), where + ".lines[" + j + "]");
    });
    total += item.lines.length;
  }
});

if (total !== EXPECTED_TOTAL) fail("总行数 " + total + " !== " + EXPECTED_TOTAL);

console.log("target: " + entry.file);
console.log("items: " + items.length + ", anchors: " + anchorCount + ", inserted lines: " + total);
console.log("OK");
