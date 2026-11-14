import { readFileSync } from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b70-spec-06.json";
const ROOT = "d:\\code\\ZCode\\";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const entry = spec.files[0];
const targetPath = ROOT + entry.file.replace(/\//g, "\\");
const source = readFileSync(targetPath, "utf8");
const lines = source.split(/\r?\n/);

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/;

const failures = [];
const fail = (msg) => failures.push(msg);

const seenIndexes = new Set();
let total = 0;
const itemReports = [];

for (let i = 0; i < entry.items.length; i++) {
  const item = entry.items[i];
  const anchorTrim = item.anchor.trim();
  const hits = [];
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() === anchorTrim) hits.push(j);
  }
  if (hits.length === 0) {
    fail(`item#${i}: anchor 未命中 -> ${JSON.stringify(item.anchor)}`);
    continue;
  }
  let index;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
      fail(`item#${i}: nth=${item.nth} 超出命中数 ${hits.length}`);
      continue;
    }
    index = hits[item.nth - 1];
  } else {
    if (hits.length !== 1) {
      fail(`item#${i}: anchor 命中 ${hits.length} 次，不唯一 -> ${JSON.stringify(item.anchor)}`);
      continue;
    }
    index = hits[0];
  }
  if (seenIndexes.has(index)) {
    fail(`item#${i}: 插入下标重复 -> ${index}`);
    continue;
  }
  seenIndexes.add(index);

  let insertLines;
  if (item.raw !== undefined) {
    insertLines = item.raw;
    if (i !== 0) fail(`item#${i}: 只有文件头可用 raw`);
  } else {
    if (!Array.isArray(item.lines)) {
      fail(`item#${i}: 缺少 raw 或 lines`);
      continue;
    }
    insertLines = item.lines.map((t) => (t === "" ? "//" : "// " + t));
  }

  insertLines.forEach((ln, k) => {
    const t = ln.trim();
    const where = `item#${i}.line#${k}`;
    if (!t.startsWith("//")) fail(`${where}: 插入行 trim 后不是 // 开头 -> ${JSON.stringify(ln)}`);
    if (ln.includes("*/")) fail(`${where}: 含 */ -> ${JSON.stringify(ln)}`);
    const text = t.replace(/^\/\/\s?/, "");
    if (text !== "") {
      const first = text.split(/\s+/)[0];
      if (FORBIDDEN.includes(first)) fail(`${where}: 禁用起始词 ${first} -> ${JSON.stringify(text)}`);
      if (text.trimEnd().endsWith(";")) fail(`${where}: 以分号结尾 -> ${JSON.stringify(text)}`);
      if (text.includes("=>")) fail(`${where}: 含箭头 -> ${JSON.stringify(text)}`);
      if (CALL_RE.test(text)) fail(`${where}: 疑似调用表达式 -> ${JSON.stringify(text)}`);
    }
  });

  total += insertLines.length;
  itemReports.push({ item: i, index, count: insertLines.length });
}

if (total !== 63) fail(`新增总行数 ${total} !== 63`);

const header = entry.items[0].raw;
if (!Array.isArray(header) || header.length !== 22) {
  fail(`文件头 raw 长度 ${Array.isArray(header) ? header.length : "N/A"} !== 22`);
} else {
  if (!header[0].startsWith("// INV-01")) fail(`文件头首行不以 // INV-01 开头 -> ${JSON.stringify(header[0])}`);
  if (header[18] !== "//") fail(`文件头第 19 行不是 // -> ${JSON.stringify(header[18])}`);
  for (let n = 0; n < 18; n++) {
    const expect = `// INV-${String(n + 1).padStart(2, "0")}`;
    if (!header[n].startsWith(expect)) fail(`文件头第 ${n + 1} 行应为 ${expect} 开头 -> ${JSON.stringify(header[n])}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL");
  failures.forEach((m) => console.error(" - " + m));
  process.exit(1);
}

console.log("OK");
console.log("blocks=" + entry.items.length);
console.log("lines=" + total);
console.log(itemReports.map((r) => `item#${r.item}@${r.index}+${r.count}`).join(" "));
