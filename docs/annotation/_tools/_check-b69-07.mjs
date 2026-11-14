import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b69-spec-07.json";
const FILE_PATH = "d:/code/ZCode/packages/web/src/share/conversationSharePreviewClient.ts";
const EXPECTED_TOTAL = 64;

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const source = readFileSync(FILE_PATH, "utf8");
const srcLines = source.split(/\r?\n/);

const errors = [];
const fail = (msg) => errors.push(msg);

const FORBIDDEN = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);
const CALL_EXPR = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/u;

function checkInsertedLine(line, where) {
  const t = line.trim();
  if (!t.startsWith("//")) fail(`${where}: 插入行不以 // 开头: ${JSON.stringify(line)}`);
  if (line.includes("*/")) fail(`${where}: 插入行含 */: ${JSON.stringify(line)}`);
  const text = t.replace(/^\/\//u, "").trim();
  if (text.length === 0) return;
  const first = text.split(/[\s，。、：；,.:]/u)[0];
  if (FORBIDDEN.has(first)) fail(`${where}: 禁止词开头 "${first}": ${JSON.stringify(line)}`);
  if (/;\s*$/u.test(t)) fail(`${where}: 以分号结尾: ${JSON.stringify(line)}`);
  if (t.includes("=>")) fail(`${where}: 含箭头: ${JSON.stringify(line)}`);
  if (CALL_EXPR.test(t)) fail(`${where}: 含调用表达式: ${JSON.stringify(line)}`);
}

let total = 0;
let blockCount = 0;
let headerChecked = false;

for (const entry of spec.files) {
  if (entry.file !== "packages/web/src/share/conversationSharePreviewClient.ts") {
    fail(`file 字段不匹配: ${entry.file}`);
  }
  const trimmedSrc = srcLines.map((l) => l.trim());
  const usedIndices = new Map();

  entry.items.forEach((item, itemIdx) => {
    blockCount += 1;
    const nth = item.nth ?? 1;
    const hits = [];
    trimmedSrc.forEach((l, i) => {
      if (l === item.anchor.trim()) hits.push(i);
    });
    if (hits.length === 0) {
      fail(`item#${itemIdx} 锚点未命中: ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (nth > hits.length) {
      fail(`item#${itemIdx} nth=${nth} 超出命中数 ${hits.length}: ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (hits.length > 1 && item.nth === undefined) {
      fail(`item#${itemIdx} 锚点不唯一(${hits.length} 次)且未指定 nth: ${JSON.stringify(item.anchor)}`);
      return;
    }
    const idx = hits[nth - 1];
    if (usedIndices.has(idx)) {
      fail(`item#${itemIdx} 与其他 item 插入下标重复: ${idx}`);
    }
    usedIndices.set(idx, itemIdx);

    const indent = (srcLines[idx].match(/^[ \t]*/) ?? [""])[0];
    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw;
      if (item.raw.some((l) => /^[ \t]/u.test(l))) {
        fail(`item#${itemIdx} raw 行不应带缩进`);
      }
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`));
      if (item.lines.length < 3 || item.lines.length > 6) {
        fail(`item#${itemIdx} 块行数 ${item.lines.length} 不在 3~6`);
      }
    } else {
      fail(`item#${itemIdx} 缺少 raw 或 lines`);
      return;
    }

    inserted.forEach((l, k) => checkInsertedLine(l, `item#${itemIdx}[${k}]`));
    total += inserted.length;

    if (itemIdx === 0) {
      headerChecked = true;
      if (item.raw.length !== 22) fail(`文件头 raw 长度 ${item.raw.length} !== 22`);
      if (!item.raw[0].startsWith("// INV-01")) fail("文件头首行不是 // INV-01");
      if (item.raw[18] !== "//") fail(`文件头第 19 行不是 //: ${JSON.stringify(item.raw[18])}`);
      if (idx !== srcLines.findIndex((l) => l.trim() !== "")) {
        fail("文件头锚点不是文件第一个非空行");
      }
      for (let i = 0; i < 18; i += 1) {
        if (!item.raw[i].startsWith(`// INV-${String(i + 1).padStart(2, "0")}`)) {
          fail(`文件头第 ${i + 1} 条编号不正确: ${JSON.stringify(item.raw[i])}`);
        }
      }
    }
  });
}

if (!headerChecked) fail("缺少文件头 item");
if (total !== EXPECTED_TOTAL) fail(`插入总行数 ${total} !== ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.error(`FAIL (${errors.length})`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${total}`);
