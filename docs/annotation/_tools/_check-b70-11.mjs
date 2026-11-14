import fs from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b70-spec-11.json";
const TARGET = "d:\\code\\ZCode\\packages\\ui\\src\\v4\\paneLayoutPersistence.ts";

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const original = fs.readFileSync(TARGET, "utf8").split(/\r?\n/);

const errors = [];
const fail = (msg) => errors.push(msg);

if (spec.files.length !== 1) fail("files 长度应为 1");
const entry = spec.files[0];
if (entry.file !== "packages/ui/src/v4/paneLayoutPersistence.ts") fail("file 路径不符");

let total = 0;
let blocks = 0;
const usedIndexes = new Map();

entry.items.forEach((item, i) => {
  const insertLines = item.raw ? item.raw : (item.lines || []).map((l) => (l === "" ? "//" : `// ${l}`));
  const isHeader = i === 0;

  if (item.raw) {
    if (!isHeader) fail(`item ${i}: 只有文件头可用 raw`);
    if (item.raw.length !== 22) fail(`文件头 raw 长度应为 22，实际 ${item.raw.length}`);
    if (!item.raw[0].startsWith("// INV-01")) fail(`文件头首行应为 // INV-01，实际 ${item.raw[0]}`);
    if (item.raw[18] !== "//") fail(`文件头第 19 行应为 //，实际 ${JSON.stringify(item.raw[18])}`);
    item.raw.forEach((l, k) => {
      if (l !== l.trimStart()) fail(`文件头第 ${k + 1} 行不应有缩进`);
      if (!l.startsWith("//")) fail(`文件头第 ${k + 1} 行必须以 // 开头`);
    });
  } else {
    if (item.lines.length < 3 || item.lines.length > 6) fail(`item ${i}: lines 数量应为 3~6，实际 ${item.lines.length}`);
    item.lines.forEach((l, k) => {
      if (l !== l.trim()) fail(`item ${i} 第 ${k + 1} 行不应带首尾空白`);
    });
  }

  // anchor 匹配（trim 后整行相等）
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(`item ${i}: anchor 缺失`);
    return;
  }
  const anchorTrim = item.anchor.trim();
  const hits = [];
  original.forEach((line, idx) => {
    if (line.trim() === anchorTrim) hits.push(idx);
  });
  if (hits.length === 0) {
    fail(`item ${i}: anchor 未命中 -> ${item.anchor}`);
    return;
  }
  const nth = item.nth === undefined ? 1 : item.nth;
  if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
    fail(`item ${i}: nth=${nth} 无效，命中数 ${hits.length}`);
    return;
  }
  if (hits.length > 1 && item.nth === undefined) {
    fail(`item ${i}: anchor 不唯一（命中 ${hits.length} 次）-> ${item.anchor}`);
    return;
  }
  const insertAt = hits[nth - 1];
  if (usedIndexes.has(insertAt)) {
    fail(`item ${i}: 插入下标 ${insertAt} 与 item ${usedIndexes.get(insertAt)} 重复`);
  }
  usedIndexes.set(insertAt, i);

  // 插入行内容校验
  insertLines.forEach((line, k) => {
    if (!line.trim().startsWith("//")) fail(`item ${i} 第 ${k + 1} 行 trim 后不以 // 开头: ${line}`);
    if (line.includes("*/")) fail(`item ${i} 第 ${k + 1} 行含 */`);
    if (line.endsWith(";") || line.trimEnd().endsWith(";")) fail(`item ${i} 第 ${k + 1} 行以分号结尾: ${line}`);
    if (line.includes("=>")) fail(`item ${i} 第 ${k + 1} 行含箭头: ${line}`);
    if (/[A-Za-z0-9_$)\]]\.[A-Za-z0-9_$]+\s*\(/.test(line)) fail(`item ${i} 第 ${k + 1} 行含调用表达式: ${line}`);
    const text = line.trim().replace(/^\/\/\s?/, "");
    if (text !== "") {
      const first = text.split(/\s+/)[0];
      if (FORBIDDEN.includes(first)) fail(`item ${i} 第 ${k + 1} 行以禁止词 ${first} 开头: ${line}`);
      if (text.endsWith(";")) fail(`item ${i} 第 ${k + 1} 行文本以分号结尾: ${line}`);
    }
  });

  total += insertLines.length;
  blocks += 1;
});

if (total !== 63) fail(`新增总行数应为 63，实际 ${total}`);

if (errors.length > 0) {
  console.error("FAILED");
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}
console.log(`OK blocks=${blocks} lines=${total}`);
