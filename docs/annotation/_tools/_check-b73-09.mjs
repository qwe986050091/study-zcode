import { readFileSync } from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b73-spec-09.json";
const ROOT = "d:\\code\\ZCode";

const FORBIDDEN_HEAD = [
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

const errors = [];

function fail(msg) {
  errors.push(msg);
}

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
if (!spec.files || spec.files.length !== 1) fail("spec.files 必须恰好 1 项");
const entry = spec.files[0];
const targetPath = `${ROOT}\\${entry.file.replace(/\//g, "\\")}`;
const original = readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = original.map((line) => line.trim());

let totalLines = 0;
let blockCount = 0;
const insertAt = new Map();

entry.items.forEach((item, itemIndex) => {
  const tag = `item[${itemIndex}] anchor=<${item.anchor}>`;
  const hits = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === item.anchor.trim()) hits.push(i);
  }

  let hitIndex = -1;
  if (typeof item.nth === "number") {
    if (item.nth < 1 || item.nth > hits.length) {
      fail(`${tag} nth=${item.nth} 无效，实际命中 ${hits.length} 次`);
      return;
    }
    hitIndex = hits[item.nth - 1];
  } else {
    if (hits.length !== 1) {
      fail(`${tag} 应唯一命中，实际命中 ${hits.length} 次`);
      return;
    }
    hitIndex = hits[0];
  }

  const indentMatch = original[hitIndex].match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "";

  let lines;
  if (Array.isArray(item.raw)) {
    lines = item.raw.slice();
    if (itemIndex !== 0) fail(`${tag} 只有文件头可使用 raw`);
  } else if (Array.isArray(item.lines)) {
    lines = item.lines.map((text) => (text === "" ? `${indent}//` : `${indent}// ${text}`));
  } else {
    fail(`${tag} 必须提供 raw 或 lines`);
    return;
  }

  if (itemIndex !== 0) {
    const size = lines.length;
    if (size < 3 || size > 6) fail(`${tag} 块大小 ${size} 不在 3~6 之间`);
  }

  lines.forEach((line, offset) => {
    if (!line.trimStart().startsWith("//")) fail(`${tag} 第 ${offset + 1} 行不以 // 开头`);
    if (line.includes("*/")) fail(`${tag} 第 ${offset + 1} 行包含 */`);
    const body = line.trim().replace(/^\/\/\s?/, "");
    if (/[A-Za-z0-9_$]\.[A-Za-z0-9_$]+\(/.test(body)) {
      fail(`${tag} 第 ${offset + 1} 行含调用表达式: ${body}`);
    }
    if (body.includes("=>")) fail(`${tag} 第 ${offset + 1} 行含箭头: ${body}`);
    if (body.endsWith(";")) fail(`${tag} 第 ${offset + 1} 行以分号结尾: ${body}`);
    const head = body.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (head && FORBIDDEN_HEAD.includes(head[1])) {
      fail(`${tag} 第 ${offset + 1} 行以禁止词开头: ${body}`);
    }
  });

  if (insertAt.has(hitIndex)) fail(`${tag} 插入下标 ${hitIndex} 重复`);
  insertAt.set(hitIndex, { itemIndex, lines });
  totalLines += lines.length;
  blockCount += 1;
});

// 文件头专用断言
const header = entry.items[0];
if (!Array.isArray(header.raw) || header.raw.length !== 22) {
  fail(`文件头 raw 长度应为 22，实际 ${header.raw ? header.raw.length : "非 raw"}`);
} else {
  if (!String(header.raw[0]).trim().startsWith("// INV-01")) fail("文件头首行必须以 // INV-01 开头");
  if (String(header.raw[18]) !== "//") fail(`文件头第 19 行应为 //，实际 <${header.raw[18]}>`);
  for (let k = 1; k <= 18; k += 1) {
    const expect = `// INV-${String(k).padStart(2, "0")}`;
    if (!String(header.raw[k - 1]).trim().startsWith(expect)) {
      fail(`文件头第 ${k} 行应以 ${expect} 开头`);
    }
  }
}

if (totalLines !== 61) fail(`插入总行数应为 61，实际 ${totalLines}`);

// 模拟插入，确认原有行未被改动
const sortedIndexes = [...insertAt.keys()].sort((a, b) => a - b);
const result = [];
let cursor = 0;
for (const idx of sortedIndexes) {
  while (cursor < idx) {
    result.push(original[cursor]);
    cursor += 1;
  }
  result.push(...insertAt.get(idx).lines);
}
while (cursor < original.length) {
  result.push(original[cursor]);
  cursor += 1;
}
const originalNonEmpty = original.filter((line) => line.trim() !== "");
const resultNonEmpty = result.filter((line) => line.trim() !== "");
if (originalNonEmpty.length + totalLines !== resultNonEmpty.length) {
  fail("插入后非空行数量不守恒");
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
