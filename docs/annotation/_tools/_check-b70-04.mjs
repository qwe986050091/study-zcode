import { readFileSync } from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b70-spec-04.json";
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const BANNED_RE = new RegExp("^(" + BANNED.join("|") + ")\\b");
const CALL_RE = /\b[\w$]+\.[\w$]+\s*\(/;

const errors = [];
let totalInserted = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const filePath = "d:\\code\\ZCode\\" + entry.file;
  const src = readFileSync(filePath, "utf8");
  const srcLines = src.split(/\r?\n/);
  const trimmed = srcLines.map((l) => l.trim());

  const insertAt = new Map(); // index -> item
  let fileTotal = 0;

  entry.items.forEach((item, itemIdx) => {
    blockCount++;
    const anchorTrim = String(item.anchor).trim();
    if (anchorTrim === "") errors.push(`item#${itemIdx} anchor 为空`);

    const hits = [];
    trimmed.forEach((t, i) => {
      if (t === anchorTrim) hits.push(i);
    });

    let idx = -1;
    if (item.nth !== undefined) {
      const n = item.nth;
      if (!Number.isInteger(n) || n < 1 || n > hits.length) {
        errors.push(`item#${itemIdx} nth 无效 anchor=${anchorTrim} hits=${hits.length}`);
        return;
      }
      idx = hits[n - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`item#${itemIdx} anchor 不唯一/未命中 (${hits.length}) anchor=${anchorTrim}`);
        return;
      }
      idx = hits[0];
    }

    if (insertAt.has(idx)) {
      errors.push(`插入下标重复 idx=${idx} item#${itemIdx} anchor=${anchorTrim}`);
      return;
    }

    let outLines;
    if (Array.isArray(item.raw)) {
      outLines = item.raw;
    } else if (Array.isArray(item.lines)) {
      const indent = srcLines[idx].match(/^\s*/)[0];
      outLines = item.lines.map((l) => (l === "" ? indent + "//" : indent + "// " + l));
    } else {
      errors.push(`item#${itemIdx} 既无 raw 也无 lines`);
      return;
    }

    if (itemIdx > 0 && (outLines.length < 3 || outLines.length > 6)) {
      errors.push(`item#${itemIdx} 块行数越界 ${outLines.length}`);
    }

    fileTotal += outLines.length;
    totalInserted += outLines.length;
    insertAt.set(idx, { itemIdx, outLines, anchorTrim });
  });

  for (const [idx, info] of insertAt) {
    info.outLines.forEach((line, k) => {
      const t = line.trim();
      if (!t.startsWith("//")) {
        errors.push(`item#${info.itemIdx} 行${k} 不以 // 开头: ${JSON.stringify(line)}`);
        return;
      }
      if (t.includes("*/")) errors.push(`item#${info.itemIdx} 行${k} 含 */`);
      if (t.endsWith(";")) errors.push(`item#${info.itemIdx} 行${k} 以分号结尾`);
      if (t.includes("=>")) errors.push(`item#${info.itemIdx} 行${k} 含箭头`);
      const text = t.slice(2).trim();
      if (BANNED_RE.test(text)) {
        errors.push(`item#${info.itemIdx} 行${k} 命中禁止词: ${JSON.stringify(t)}`);
      }
      if (CALL_RE.test(t)) {
        errors.push(`item#${info.itemIdx} 行${k} 疑似调用表达式: ${JSON.stringify(t)}`);
      }
      if (info.anchorTrim === "") errors.push("anchor 为空");
    });
  }

  // 文件头校验
  const header = entry.items[0];
  if (!Array.isArray(header.raw) || header.raw.length !== 22) {
    errors.push(`文件头 raw 长度应为 22，实际 ${header.raw ? header.raw.length : "无"}`);
  } else {
    if (!header.raw[0].startsWith("// INV-01")) errors.push("文件头首行不是 // INV-01");
    if (header.raw[18] !== "//") errors.push(`文件头第 19 行不是 //，实际 ${JSON.stringify(header.raw[18])}`);
    for (let i = 1; i <= 18; i++) {
      const tag = `// INV-${String(i).padStart(2, "0")}`;
      if (!header.raw[i - 1].startsWith(tag)) errors.push(`文件头第 ${i} 行不是 ${tag}`);
    }
  }

  console.log(`${entry.file}: blocks=${entry.items.length} lines=${fileTotal} insertPoints=${insertAt.size}`);
}

if (totalInserted !== 62) errors.push(`插入总行数应为 62，实际 ${totalInserted}`);

if (errors.length > 0) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" - " + e));
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
