import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b69-spec-10.json";
const repoRoot = "d:/code/ZCode/";
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const fail = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

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
const CALL_RE = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let totalLines = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const abs = repoRoot + entry.file;
  const rawText = readFileSync(abs, "utf8");
  const srcLines = rawText.split(/\r?\n/);
  const srcTrim = srcLines.map((l) => l.trim());

  const usedIndexes = new Set();
  const insertMap = new Map();

  entry.items.forEach((item, itemIdx) => {
    if (typeof item.anchor !== "string" || item.anchor.length === 0) {
      fail("item " + itemIdx + " 缺少 anchor");
    }
    if (item.anchor.trim() !== item.anchor) {
      fail("item " + itemIdx + " anchor 首尾有空白：" + JSON.stringify(item.anchor));
    }
    if (item.anchor.length === 0) fail("item " + itemIdx + " anchor 为空行");

    const hits = [];
    srcTrim.forEach((t, i) => {
      if (t === item.anchor) hits.push(i);
    });
    if (hits.length === 0) fail("anchor 未命中：" + item.anchor);
    const nth = item.nth === undefined ? 1 : item.nth;
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      fail("anchor 第 " + nth + " 次出现无效（共 " + hits.length + " 次）：" + item.anchor);
    }
    if (item.nth === undefined && hits.length !== 1) {
      fail("anchor 不唯一（" + hits.length + " 次）且未给 nth：" + item.anchor);
    }
    const index = hits[nth - 1];
    if (usedIndexes.has(index)) fail("重复插入下标 " + (index + 1));
    usedIndexes.add(index);

    const hasRaw = Object.prototype.hasOwnProperty.call(item, "raw");
    const hasLines = Object.prototype.hasOwnProperty.call(item, "lines");
    if (hasRaw === hasLines) fail("item " + itemIdx + " 必须且只能有 raw 或 lines 之一");

    let rendered;
    if (hasRaw) {
      if (itemIdx !== 0) fail("只有第一个 item 允许使用 raw");
      if (!Array.isArray(item.raw)) fail("raw 必须是数组");
      if (item.raw.length !== 22) fail("文件头 raw 长度应为 22，实际 " + item.raw.length);
      if (!item.raw[0].startsWith("// INV-01")) fail("文件头首行不是 // INV-01");
      if (item.raw[18] !== "//") fail("文件头第 19 行必须恰为 //");
      rendered = item.raw.slice();
    } else {
      if (!Array.isArray(item.lines)) fail("lines 必须是数组");
      if (item.lines.length < 3 || item.lines.length > 6) {
        fail("块行数须在 3~6 之间，实际 " + item.lines.length);
      }
      const indent = (srcLines[index].match(/^[ \t]*/) || [""])[0];
      rendered = item.lines.map((t) => (t === "" ? indent + "//" : indent + "// " + t));
    }

    for (const line of rendered) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) fail("插入行不以 // 开头：" + trimmed);
      if (trimmed.includes("*/")) fail("插入行包含 */：" + trimmed);
      const body = trimmed.replace(/^\/\/ ?/, "");
      const firstToken = body.split(/[\s:：]/)[0];
      if (FORBIDDEN.includes(firstToken)) fail("插入行以禁止词 " + firstToken + " 开头：" + trimmed);
      if (/[;；]\s*$/.test(body)) fail("插入行以分号结尾：" + trimmed);
      if (body.includes("=>")) fail("插入行含箭头：" + trimmed);
      if (CALL_RE.test(body)) fail("插入行含调用表达式：" + trimmed);
    }

    insertMap.set(index, rendered);
    totalLines += rendered.length;
    blockCount += 1;
  });
}

const files = spec.files.length;
console.log("files=" + files + " blocks=" + blockCount + " lines=" + totalLines);
if (totalLines !== 63) fail("插入总行数应等于 63，实际 " + totalLines);
console.log("OK");
