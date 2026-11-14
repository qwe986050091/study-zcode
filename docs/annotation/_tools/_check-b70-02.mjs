import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b70-spec-02.json";
const TARGET = "d:/code/ZCode/packages/model-option-map/src/evaluator.ts";
const EXPECTED_LINES = 63;
const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_EXPR = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const fail = (msg) => errors.push(msg);

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const fileText = readFileSync(TARGET, "utf8");
const fileLines = fileText.split(/\r?\n/);

const entry = spec.files?.[0];
if (!entry) fail("spec.files[0] 缺失");
if (entry.file !== "packages/model-option-map/src/evaluator.ts") fail(`file 字段不符: ${entry.file}`);

const insertions = new Map(); // index -> number of inserted lines
let total = 0;
let blockCount = 0;

for (const [i, item] of entry.items.entries()) {
  const raw = item.raw;
  const lines = item.lines;
  if ((raw === undefined) === (lines === undefined)) {
    fail(`item#${i} 必须且只能有 raw 或 lines 之一`);
    continue;
  }
  const payload = raw ?? lines;
  total += payload.length;
  blockCount += 1;

  const anchor = String(item.anchor ?? "").trim();
  if (!anchor) {
    fail(`item#${i} anchor 为空`);
    continue;
  }
  const hits = [];
  fileLines.forEach((line, idx) => {
    if (line.trim() === anchor) hits.push(idx);
  });
  if (hits.length === 0) {
    fail(`item#${i} anchor 未命中: ${anchor}`);
    continue;
  }
  let target;
  if (item.nth !== undefined) {
    const n = Number(item.nth);
    if (!Number.isInteger(n) || n < 1 || n > hits.length) {
      fail(`item#${i} nth=${item.nth} 越界，命中数 ${hits.length}`);
      continue;
    }
    target = hits[n - 1];
  } else {
    if (hits.length !== 1) {
      fail(`item#${i} anchor 非唯一（命中 ${hits.length} 次）: ${anchor}`);
      continue;
    }
    target = hits[0];
  }
  if (target === 0 && i !== 0) fail(`item#${i} 锚定到文件第一行，但只有文件头可锚定首行`);
  if (insertions.has(target)) {
    fail(`item#${i} 与其它 item 插入下标重复: ${target}`);
  }
  insertions.set(target, payload.length);
}

// 文件头专项检查
const header = entry.items[0];
if (!header?.raw) {
  fail("第一个 item 不是 raw 文件头");
} else {
  if (header.raw.length !== 22) fail(`文件头 raw 长度 ${header.raw.length} !== 22`);
  if (!header.raw[0].startsWith("// INV-01")) fail("文件头首行未以 // INV-01 开头");
  if (header.raw[18] !== "//") fail(`文件头第 19 行应为 //，实际: ${JSON.stringify(header.raw[18])}`);
  for (let k = 0; k < 18; k += 1) {
    const want = `// INV-${String(k + 1).padStart(2, "0")} `;
    if (!header.raw[k].startsWith(want)) fail(`文件头第 ${k + 1} 行前缀应为 ${want}`);
  }
  const tail = header.raw.slice(19);
  if (tail.length !== 3) fail(`文件头尾部说明应为 3 行，实际 ${tail.length}`);
  const tailPrefix = ["// 模块职责：", "// 状态所有权：", "// 阅读顺序："];
  tail.forEach((line, k) => {
    if (!line.startsWith(tailPrefix[k])) fail(`文件头尾部第 ${k + 1} 行应以 ${tailPrefix[k]} 开头`);
  });
}

// 注释行内容检查
const checkLine = (line, itemIdx) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("//")) fail(`item#${itemIdx} 行未以 // 开头: ${line}`);
  if (trimmed.includes("*/")) fail(`item#${itemIdx} 含 */: ${line}`);
  const body = trimmed.slice(2).trim();
  if (body) {
    const first = body.split(/\s+/)[0];
    if (BANNED.includes(first)) fail(`item#${itemIdx} 以禁止词 ${first} 开头: ${line}`);
  }
  if (trimmed.endsWith(";")) fail(`item#${itemIdx} 以分号结尾: ${line}`);
  if (trimmed.includes("=>")) fail(`item#${itemIdx} 含箭头: ${line}`);
  const call = trimmed.match(CALL_EXPR);
  if (call) fail(`item#${itemIdx} 含调用表达式 ${call[0]}: ${line}`);
};

entry.items.forEach((item, idx) => {
  if (item.raw) {
    for (const line of item.raw) checkLine(line, idx);
  } else {
    for (const line of item.lines) checkLine(line === "" ? "//" : `// ${line}`, idx);
  }
});

if (total !== EXPECTED_LINES) fail(`插入总行数 ${total} !== ${EXPECTED_LINES}`);

// 模拟插入，确保原有行顺序不变且不产生空注释块
const insertedRows = [...insertions.entries()].sort((a, b) => a[0] - b[0]);
const rebuilt = [];
let cursor = 0;
for (const [idx, count] of insertedRows) {
  rebuilt.push(...fileLines.slice(cursor, idx));
  for (let k = 0; k < count; k += 1) rebuilt.push("//");
  cursor = idx;
}
rebuilt.push(...fileLines.slice(cursor));
if (rebuilt.length !== fileLines.length + total) {
  fail(`重建后行数 ${rebuilt.length} 与预期 ${fileLines.length + total} 不符`);
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const msg of errors) console.error(`- ${msg}`);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${total}`);
