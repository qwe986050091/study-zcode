import { readFileSync } from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b73-spec-04.json";
const ROOT = "d:\\code\\ZCode\\";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const errors = [];

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;
const FORBIDDEN_RE = new RegExp("^(" + FORBIDDEN.join("|") + ")\\b");

let totalLines = 0;
let blockCount = 0;
let headerChecked = false;

for (const entry of spec.files) {
  const abs = ROOT + entry.file.replace(/\//g, "\\");
  const text = readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  const trimmed = lines.map((l) => l.trim());

  const usedIdx = new Map();
  for (const item of entry.items) {
    if (!item.anchor || typeof item.anchor !== "string") {
      errors.push("item 缺少 anchor");
      continue;
    }
    const a = item.anchor.trim();
    const hits = [];
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === a) hits.push(i);
    }
    if (hits.length === 0) {
      errors.push(`anchor 未命中: ${a}`);
      continue;
    }
    let idx;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`nth 越界: ${a} nth=${item.nth} hits=${hits.length}`);
        continue;
      }
      idx = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`anchor 不唯一: ${a} hits=${hits.length}`);
        continue;
      }
      idx = hits[0];
    }
    if (usedIdx.has(idx)) {
      errors.push(`重复插入下标 ${idx} (anchor: ${a})`);
      continue;
    }
    usedIdx.set(idx, a);

    const anchorIndent = (lines[idx].match(/^[ \t]*/) || [""])[0];
    let inserted;
    let isRaw = false;
    if (Array.isArray(item.raw)) {
      isRaw = true;
      if (item.lines !== undefined) errors.push(`anchor ${a} 同时给了 raw 与 lines`);
      inserted = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((s) =>
        s === "" ? anchorIndent + "//" : anchorIndent + "// " + s,
      );
    } else {
      errors.push(`anchor ${a} 既无 raw 也无 lines`);
      continue;
    }

    if (isRaw && headerChecked === false && blockCount === 0) {
      headerChecked = true;
      if (item.raw.length !== 22) errors.push(`文件头 raw 长度=${item.raw.length}，应为 22`);
      if (!String(item.raw[0]).startsWith("// INV-01")) {
        errors.push("文件头首行未以 // INV-01 开头");
      }
      if (item.raw[18] !== "//") {
        errors.push(`文件头第 19 行不是 //，实际: ${JSON.stringify(item.raw[18])}`);
      }
      for (let k = 0; k < 18; k++) {
        const r = String(item.raw[k]);
        if (!r.startsWith(`// INV-${String(k + 1).padStart(2, "0")}`)) {
          errors.push(`INV 序号错位: 第 ${k + 1} 条为 ${r.slice(0, 12)}`);
        }
        if (!r.includes("守住位置") || !r.includes("改错故障")) {
          errors.push(`INV-${k + 1} 缺少「守住位置」或「改错故障」`);
        }
      }
    }

    if (isRaw) {
      for (const l of inserted) {
        if (/^[ \t]/.test(l)) errors.push(`raw 行带缩进: ${l}`);
      }
    }

    inserted.forEach((l, n) => {
      const t = l.trim();
      if (!t.startsWith("//")) errors.push(`插入行未以 // 开头: ${l}`);
      if (l.includes("*/")) errors.push(`插入行含 */: ${l}`);
      const rest = t.slice(2).trimStart();
      if (FORBIDDEN_RE.test(rest)) errors.push(`插入行命中禁止词: ${rest}`);
      if (rest.endsWith(";")) errors.push(`插入行以分号结尾: ${l}`);
      if (l.includes("=>")) errors.push(`插入行含箭头: ${l}`);
      if (CALL_RE.test(l)) errors.push(`插入行含调用表达式: ${l}`);
      if (l.includes("\n") || l.includes("\r")) errors.push(`插入行含换行: ${JSON.stringify(l)}`);
    });

    totalLines += inserted.length;
    blockCount += 1;
  }
}

if (!headerChecked) errors.push("未找到文件头 item");

if (totalLines !== 60) errors.push(`插入总行数=${totalLines}，应为 60`);

const sizes = [];
for (const entry of spec.files) {
  for (const item of entry.items) {
    const n = Array.isArray(item.raw) ? item.raw.length : item.lines.length;
    sizes.push(n);
  }
}
for (let i = 1; i < sizes.length; i++) {
  if (sizes[i] < 3 || sizes[i] > 6) errors.push(`第 ${i + 1} 块行数=${sizes[i]}，应在 3~6`);
}

if (errors.length) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalLines} sizes=${sizes.join(",")}`);
