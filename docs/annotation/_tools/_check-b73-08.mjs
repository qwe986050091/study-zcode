import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b73-spec-08.json";
const ROOT = "d:/code/ZCode/";
const EXPECT_TOTAL = 60;
const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const failures = [];
const blocks = [];

for (const entry of spec.files) {
  const abs = ROOT + entry.file;
  const source = readFileSync(abs, "utf8");
  const hadTrailingNewline = source.endsWith("\n") || source.endsWith("\r\n");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();
  const trimmed = lines.map((line) => line.trim());

  const insertPoints = [];
  let totalInserted = 0;

  entry.items.forEach((item, itemIndex) => {
    const anchor = item.anchor.trim();
    if (anchor === "") failures.push(`item#${itemIndex}: anchor 为空`);
    const hits = [];
    trimmed.forEach((line, idx) => {
      if (line === anchor) hits.push(idx);
    });
    const nth = item.nth ?? 1;
    if (hits.length === 0) {
      failures.push(`item#${itemIndex}: anchor 未命中 -> ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (nth === 1 && hits.length !== 1) {
      failures.push(`item#${itemIndex}: anchor 命中 ${hits.length} 次但不唯一 -> ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (nth > hits.length) {
      failures.push(`item#${itemIndex}: nth=${nth} 超出命中数 ${hits.length}`);
      return;
    }
    const at = hits[nth - 1];
    if (trimmed[at] === "") failures.push(`item#${itemIndex}: anchor 指向空行`);

    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      const indent = (lines[at].match(/^[ \t]*/) || [""])[0];
      inserted = item.lines.map((text) => (text === "" ? `${indent}//` : `${indent}// ${text}`));
    } else {
      failures.push(`item#${itemIndex}: 既无 raw 也无 lines`);
      return;
    }

    insertPoints.push({ at, count: inserted.length, itemIndex, inserted });
    totalInserted += inserted.length;
    blocks.push({ itemIndex, anchor, at, inserted });

    inserted.forEach((rawLine, k) => {
      const t = rawLine.trim();
      if (!t.startsWith("//")) failures.push(`item#${itemIndex}[${k}]: 不以 // 开头 -> ${rawLine}`);
      if (t.includes("*/")) failures.push(`item#${itemIndex}[${k}]: 含 */ -> ${rawLine}`);
      const text = t.replace(/^\/+/, "").trim();
      if (text !== "") {
        const word = text.split(/[\s:：,，、]/)[0];
        if (FORBIDDEN_START.includes(word)) {
          failures.push(`item#${itemIndex}[${k}]: 禁止起始词 ${word} -> ${rawLine}`);
        }
      }
      if (text.endsWith(";")) failures.push(`item#${itemIndex}[${k}]: 以分号结尾 -> ${rawLine}`);
      if (rawLine.includes("=>")) failures.push(`item#${itemIndex}[${k}]: 含箭头 -> ${rawLine}`);
      if (/[A-Za-z0-9_$\]\)]\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(rawLine)) {
        failures.push(`item#${itemIndex}[${k}]: 形似调用表达式 -> ${rawLine}`);
      }
    });

    if (itemIndex === 0) {
      if (!Array.isArray(item.raw)) failures.push("文件头 item 必须使用 raw");
      else {
        if (item.raw.length !== 22) failures.push(`文件头 raw 长度 ${item.raw.length} !== 22`);
        if (!String(item.raw[0] || "").trim().startsWith("// INV-01")) failures.push("文件头首行不是 // INV-01");
        if ((item.raw[18] || "").trim() !== "//") failures.push("文件头第 19 行不是 //");
      }
    } else if (item.lines) {
      if (item.lines.length < 3 || item.lines.length > 6) {
        failures.push(`item#${itemIndex}: 块行数 ${item.lines.length} 不在 3~6`);
      }
    }
  });

  const seen = new Map();
  for (const p of insertPoints) {
    if (seen.has(p.at)) failures.push(`重复插入下标 ${p.at}（item#${seen.get(p.at)} 与 item#${p.itemIndex}）`);
    seen.set(p.at, p.itemIndex);
  }

  // 模拟 zc-insert：按插入下标升序拼接，验证只增不删
  const sorted = insertPoints.slice().sort((a, b) => a.at - b.at);
  const output = [];
  let cursor = 0;
  for (const p of sorted) {
    output.push(...lines.slice(cursor, p.at));
    output.push(...p.inserted);
    cursor = p.at;
  }
  output.push(...lines.slice(cursor));
  if (output.length !== lines.length + totalInserted) {
    failures.push(`拼接后行数异常：${output.length} !== ${lines.length + totalInserted}`);
  }
  const stripInserted = () => {
    const kept = [];
    let c = 0;
    for (const p of sorted) {
      kept.push(...lines.slice(c, p.at));
      c = p.at;
    }
    kept.push(...lines.slice(c));
    return kept.join("\n") === lines.join("\n");
  };
  if (!stripInserted()) failures.push("移除插入行后原文不一致（发生了改写）");

  console.log(`${entry.file}: 原文 ${lines.length} 行，插入 ${totalInserted} 行，块 ${entry.items.length} 个`);
  if (totalInserted !== EXPECT_TOTAL) {
    failures.push(`插入总行数 ${totalInserted} !== ${EXPECT_TOTAL}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`OK blocks=${blocks.length} lines=${blocks.reduce((s, b) => s + b.inserted.length, 0)}`);
