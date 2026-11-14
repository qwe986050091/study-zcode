import { readFileSync } from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b73-spec-07.json";
const TARGET = "d:\\code\\ZCode\\packages\\ui\\src\\settings\\automationTemplateCatalog.ts";

const SPEC_LINES = 61;
const HEADER_LINES = 22;

const FORBIDDEN_START = [
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

const CALL_RE = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\(/;

const fail = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const src = readFileSync(TARGET, "utf8");
const srcLines = src.split(/\r?\n/);

if (!Array.isArray(spec.files) || spec.files.length !== 1) fail("spec.files 必须恰好一个文件");
const entry = spec.files[0];
if (entry.file !== "packages/ui/src/settings/automationTemplateCatalog.ts") fail("file 路径不符");
const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

const usedIndexes = new Set();
let totalInserted = 0;

const checkInsertedLine = (line, label) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("//")) fail(label + " 插入行 trim 后未以 // 开头: " + JSON.stringify(line));
  if (trimmed.includes("*/")) fail(label + " 插入行包含 */: " + JSON.stringify(line));
  const text = trimmed.replace(/^\/\/\s?/, "").trim();
  if (!text) return;
  const first = text.split(/[\s:：,，。、）)】"]/)[0];
  if (FORBIDDEN_START.includes(first)) fail(label + " 注释文本以禁止词开头: " + JSON.stringify(text));
  const m = text.match(/^([A-Za-z_$][\w$]*)/);
  if (m && FORBIDDEN_START.includes(m[1])) fail(label + " 注释文本以禁止词开头: " + JSON.stringify(text));
  if (/[;；]\s*$/.test(text) && /;\s*$/.test(text)) fail(label + " 注释文本以分号结尾: " + JSON.stringify(text));
  if (text.includes("=>")) fail(label + " 注释文本包含 =>: " + JSON.stringify(text));
  if (CALL_RE.test(text)) fail(label + " 注释文本疑似调用表达式: " + JSON.stringify(text));
};

items.forEach((item, i) => {
  const label = "item[" + i + "]";
  const anchor = item.anchor;
  if (typeof anchor !== "string" || !anchor.trim()) fail(label + " anchor 无效");

  const anchorTrim = anchor.trim();
  const hits = [];
  srcLines.forEach((line, idx) => {
    if (line.trim() === anchorTrim) hits.push(idx);
  });

  if (hits.length === 0) fail(label + " anchor 未命中: " + JSON.stringify(anchorTrim));

  let targetIndex;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) fail(label + " nth 非法");
    if (hits.length < item.nth) fail(label + " nth 超出命中次数 " + hits.length);
    targetIndex = hits[item.nth - 1];
  } else {
    if (hits.length !== 1) fail(label + " anchor 命中 " + hits.length + " 次，不唯一: " + JSON.stringify(anchorTrim));
    targetIndex = hits[0];
  }

  if (usedIndexes.has(targetIndex)) fail(label + " 插入下标重复: " + targetIndex);
  usedIndexes.add(targetIndex);

  if (i === 0) {
    if (!Array.isArray(item.raw)) fail("文件头 item 必须使用 raw");
    if (item.raw.length !== HEADER_LINES) fail("文件头 raw 长度应为 " + HEADER_LINES + "，实际 " + item.raw.length);
    if (!item.raw[0].startsWith("// INV-01")) fail("文件头首行必须以 // INV-01 开头");
    if (item.raw[18] !== "//") fail("文件头第 19 行必须严格等于 //");
    for (let n = 1; n <= 18; n += 1) {
      const prefix = "// INV-" + String(n).padStart(2, "0");
      if (!item.raw[n - 1].startsWith(prefix)) fail("文件头第 " + n + " 行缺少 " + prefix);
    }
    item.raw.forEach((line, k) => {
      if (typeof line !== "string" || !line.trim()) fail("文件头 raw[" + k + "] 非法");
      checkInsertedLine(line, label + ".raw[" + k + "]");
    });
    totalInserted += item.raw.length;
  } else {
    if (!Array.isArray(item.lines)) fail(label + " 必须使用 lines");
    if (item.lines.length < 3 || item.lines.length > 6) fail(label + " 块行数应为 3~6，实际 " + item.lines.length);
    item.lines.forEach((line, k) => {
      if (typeof line !== "string") fail(label + ".lines[" + k + "] 不是字符串");
      const rendered = line === "" ? "//" : "// " + line;
      checkInsertedLine(rendered, label + ".lines[" + k + "]");
    });
    totalInserted += item.lines.length;
  }
});

if (totalInserted !== SPEC_LINES) fail("插入总行数应为 " + SPEC_LINES + "，实际 " + totalInserted);

console.log("OK blocks=" + items.length + " lines=" + totalInserted);
