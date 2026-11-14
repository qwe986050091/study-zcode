import fs from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b72-spec-03.json";
const ROOT = "d:\\code\\ZCode";

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const errors = [];
const BANNED = new Set([
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
]);

const TARGET_TOTAL = 61;
const HEADER_LINES = 22;

let totalLines = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const abs = `${ROOT}\\${entry.file.replace(/\//g, "\\")}`;
  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split(/\r?\n/);
  const usedIndices = new Map();

  entry.items.forEach((item, itemIndex) => {
    const anchorTrim = item.anchor.trim();
    if (!anchorTrim) errors.push(`[item ${itemIndex}] anchor 为空`);

    const hits = [];
    lines.forEach((line, i) => {
      if (line.trim() === anchorTrim) hits.push(i);
    });

    if (hits.length === 0) {
      errors.push(`[item ${itemIndex}] anchor 未命中: ${JSON.stringify(anchorTrim)}`);
      return;
    }
    let insertAt;
    if (item.nth !== undefined) {
      if (hits.length < item.nth) {
        errors.push(`[item ${itemIndex}] nth=${item.nth} 越界，命中 ${hits.length} 次`);
        return;
      }
      insertAt = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`[item ${itemIndex}] anchor 不唯一（${hits.length} 次）: ${JSON.stringify(anchorTrim)}`);
        return;
      }
      insertAt = hits[0];
    }
    if (usedIndices.has(insertAt)) {
      errors.push(`[item ${itemIndex}] 插入下标重复: ${insertAt}`);
    }
    usedIndices.set(insertAt, true);

    const isHeader = itemIndex === 0;
    let inserted = [];
    if (isHeader) {
      if (!Array.isArray(item.raw)) errors.push("[header] 缺少 raw");
      inserted = item.raw ?? [];
      if (inserted.length !== HEADER_LINES) {
        errors.push(`[header] raw 长度 ${inserted.length} !== ${HEADER_LINES}`);
      }
      if (!inserted[0] || !inserted[0].startsWith("// INV-01")) {
        errors.push(`[header] 首行不是 // INV-01: ${JSON.stringify(inserted[0])}`);
      }
      if (inserted[18] !== "//") {
        errors.push(`[header] 第 19 行不是 //: ${JSON.stringify(inserted[18])}`);
      }
    } else {
      if (!Array.isArray(item.lines)) errors.push(`[item ${itemIndex}] 缺少 lines`);
      const body = item.lines ?? [];
      if (body.length < 3 || body.length > 6) {
        errors.push(`[item ${itemIndex}] lines 长度 ${body.length} 不在 3~6`);
      }
      inserted = body.map((text) => (text === "" ? "//" : `// ${text}`));
    }

    blockCount += 1;
    totalLines += inserted.length;

    inserted.forEach((line, k) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) {
        errors.push(`[item ${itemIndex}#${k}] 不是整行注释: ${JSON.stringify(line)}`);
        return;
      }
      if (line.includes("*/")) {
        errors.push(`[item ${itemIndex}#${k}] 含 */: ${JSON.stringify(line)}`);
      }
      const text = trimmed.slice(2).trim();
      if (!text) return;
      const first = text.match(/^[A-Za-z_$][\w$]*/);
      if (first && BANNED.has(first[0])) {
        errors.push(`[item ${itemIndex}#${k}] 以禁止词开头(${first[0]}): ${JSON.stringify(text)}`);
      }
      if (text.endsWith(";")) {
        errors.push(`[item ${itemIndex}#${k}] 以分号结尾: ${JSON.stringify(text)}`);
      }
      if (text.includes("=>")) {
        errors.push(`[item ${itemIndex}#${k}] 含箭头: ${JSON.stringify(text)}`);
      }
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(text)) {
        errors.push(`[item ${itemIndex}#${k}] 含调用表达式: ${JSON.stringify(text)}`);
      }
    });
  });
}

if (totalLines !== TARGET_TOTAL) {
  errors.push(`插入总行数 ${totalLines} !== ${TARGET_TOTAL}`);
}

if (errors.length > 0) {
  console.error("FAIL");
  errors.forEach((e) => console.error("- " + e));
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
