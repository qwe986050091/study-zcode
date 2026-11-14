import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b69-spec-02.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const fileEntry = spec.files[0];
const targetPath = "d:/code/ZCode/" + fileEntry.file;
const text = fs.readFileSync(targetPath, "utf8");
const lines = text.split(/\r?\n/);
const trims = lines.map((l) => l.trim());

const forbidden = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errors = [];
const usedIdx = new Map();
let total = 0;

function validateInserted(insertLines, label) {
  for (const raw of insertLines) {
    const t = raw.trim();
    if (!t.startsWith("//")) errors.push(`${label}: 不以 // 开头 -> ${raw}`);
    if (t.includes("*/")) errors.push(`${label}: 含 */ -> ${raw}`);
    const body = t.slice(2).trim();
    if (body.length > 0) {
      const first = body.split(/\s+/)[0];
      if (forbidden.includes(first)) errors.push(`${label}: 禁止词开头 ${first} -> ${raw}`);
    }
    if (t.endsWith(";")) errors.push(`${label}: 以分号结尾 -> ${raw}`);
    if (t.includes("=>")) errors.push(`${label}: 含箭头 -> ${raw}`);
    if (/\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(t)) {
      errors.push(`${label}: 形似调用表达式 -> ${raw}`);
    }
  }
}

fileEntry.items.forEach((item, i) => {
  const label = `item#${i + 1}`;
  const anchorTrim = item.anchor.trim();
  const matches = [];
  trims.forEach((t, idx) => {
    if (t === anchorTrim) matches.push(idx);
  });
  if (matches.length === 0) {
    errors.push(`${label}: anchor 未命中 -> ${item.anchor}`);
    return;
  }
  let idx;
  if (item.nth !== undefined) {
    if (matches.length < item.nth) {
      errors.push(`${label}: nth=${item.nth} 超出现有 ${matches.length} 次`);
      return;
    }
    idx = matches[item.nth - 1];
  } else {
    if (matches.length !== 1) {
      errors.push(`${label}: anchor 不唯一（${matches.length} 次）-> ${item.anchor}`);
      return;
    }
    idx = matches[0];
  }
  if (usedIdx.has(idx)) {
    errors.push(`${label}: 插入下标与 ${usedIdx.get(idx)} 重复 -> ${idx}`);
  }
  usedIdx.set(idx, label);

  let insertLines;
  if (Array.isArray(item.raw)) {
    insertLines = item.raw;
  } else if (Array.isArray(item.lines)) {
    if (item.lines.length < 3 || item.lines.length > 6) {
      errors.push(`${label}: lines 块长度 ${item.lines.length} 不在 3~6`);
    }
    insertLines = item.lines.map((l) => (l === "" ? "//" : "// " + l));
  } else {
    errors.push(`${label}: 既无 raw 也无 lines`);
    return;
  }
  validateInserted(insertLines, label);
  total += insertLines.length;

  if (i === 0) {
    if (!Array.isArray(item.raw)) errors.push("header: 首个 item 必须用 raw");
    if (item.raw.length !== 22) errors.push(`header: raw 长度 ${item.raw.length} !== 22`);
    if (!item.raw[0].startsWith("// INV-01")) errors.push("header: 首行不是 // INV-01");
    if (item.raw[18] !== "//") errors.push("header: 第 19 行不是 //");
    for (let n = 1; n <= 18; n++) {
      const tag = `// INV-${String(n).padStart(2, "0")}`;
      if (!item.raw[n - 1].startsWith(tag)) errors.push(`header: 第 ${n} 行缺少 ${tag}`);
    }
    if (!item.raw[19].startsWith("// 模块职责：")) errors.push("header: 缺少模块职责");
    if (!item.raw[20].startsWith("// 状态所有权：")) errors.push("header: 缺少状态所有权");
    if (!item.raw[21].startsWith("// 阅读顺序：")) errors.push("header: 缺少阅读顺序");
    for (const r of item.raw) {
      if (/^\s/.test(r)) errors.push(`header: raw 行带缩进 -> ${r}`);
    }
  }
});

const sorted = [...usedIdx.keys()].sort((a, b) => a - b);
console.log("insert indices:", sorted.join(","));
console.log("blocks:", fileEntry.items.length, "lines:", total);

if (total !== 64) errors.push(`总行数 ${total} !== 64`);

if (errors.length) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${fileEntry.items.length} lines=${total}`);
