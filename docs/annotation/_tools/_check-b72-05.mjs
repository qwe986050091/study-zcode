import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b72-spec-05.json";
const targetPath = "d:/code/ZCode/apps/dev-docs/src/capability-map/CapabilityMapDetail.tsx";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = readFileSync(targetPath, "utf8");
const fileLines = source.split(/\r?\n/);

const BANNED_START = [
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

const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const inserts = [];
let totalInserted = 0;
let blockCount = 0;

function fail(msg) {
  errors.push(msg);
}

function checkText(displayLine, label) {
  const trimmed = displayLine.trim();
  if (!trimmed.startsWith("//")) {
    fail(`${label}: 插入行未以 // 开头 -> ${JSON.stringify(displayLine)}`);
    return;
  }
  if (trimmed.includes("*/")) {
    fail(`${label}: 插入行包含 */ -> ${JSON.stringify(displayLine)}`);
  }
  if (trimmed.endsWith(";")) {
    fail(`${label}: 插入行以 ; 结尾 -> ${JSON.stringify(displayLine)}`);
  }
  const body = trimmed.replace(/^\/\/\s?/, "");
  if (!body) return;
  if (body.includes("=>")) {
    fail(`${label}: 插入行包含 => -> ${JSON.stringify(displayLine)}`);
  }
  const first = body.split(/\s+/)[0].toLowerCase();
  if (BANNED_START.includes(first)) {
    fail(`${label}: 插入行以禁止词开头 ${first} -> ${JSON.stringify(displayLine)}`);
  }
  if (CALL_RE.test(body)) {
    fail(`${label}: 插入行含疑似调用表达式 -> ${JSON.stringify(displayLine)}`);
  }
}

const items = spec.files[0].items;
for (let i = 0; i < items.length; i += 1) {
  const item = items[i];
  const label = `item[${i}]`;
  const anchor = item.anchor;
  if (typeof anchor !== "string" || !anchor.trim()) {
    fail(`${label}: anchor 非法`);
    continue;
  }
  const indices = [];
  for (let li = 0; li < fileLines.length; li += 1) {
    if (fileLines[li].trim() === anchor.trim()) indices.push(li);
  }
  if (indices.length === 0) {
    fail(`${label}: anchor 未命中 -> ${JSON.stringify(anchor)}`);
    continue;
  }
  let index;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > indices.length) {
      fail(`${label}: nth=${item.nth} 超出命中次数 ${indices.length}`);
      continue;
    }
    index = indices[item.nth - 1];
  } else {
    if (indices.length !== 1) {
      fail(`${label}: anchor 命中 ${indices.length} 次且未指定 nth -> ${JSON.stringify(anchor)}`);
      continue;
    }
    index = indices[0];
  }

  const anchorLine = fileLines[index];
  if (!anchorLine.trim()) {
    fail(`${label}: anchor 为空行`);
    continue;
  }
  const indent = (anchorLine.match(/^\s*/) || [""])[0];

  let produced;
  if (Array.isArray(item.raw)) {
    if (item.lines !== undefined) fail(`${label}: raw 与 lines 不能同时存在`);
    produced = item.raw.map((line, k) => {
      if (typeof line !== "string") fail(`${label}: raw[${k}] 不是字符串`);
      return line;
    });
    for (let k = 0; k < produced.length; k += 1) {
      if (/^\s/.test(produced[k])) fail(`${label}: raw[${k}] 带缩进`);
      checkText(produced[k], `${label}.raw[${k}]`);
    }
  } else if (Array.isArray(item.lines)) {
    produced = item.lines.map((line, k) => {
      if (typeof line !== "string") fail(`${label}: lines[${k}] 不是字符串`);
      const body = line.trimEnd();
      const display = body === "" ? `${indent}//` : `${indent}// ${body}`;
      checkText(display, `${label}.lines[${k}]`);
      return display;
    });
  } else {
    fail(`${label}: 缺少 raw 或 lines`);
    continue;
  }

  if (produced.length < 1) fail(`${label}: 块内无内容`);
  if (i > 0 && (produced.length < 3 || produced.length > 6)) {
    fail(`${label}: 块行数 ${produced.length} 不在 3~6 之间`);
  }

  totalInserted += produced.length;
  blockCount += 1;
  inserts.push({ index, produced, anchor, label });
}

const seen = new Map();
for (const ins of inserts) {
  if (seen.has(ins.index)) {
    fail(`插入下标重复: ${seen.get(ins.index)} 与 ${ins.label} 都指向第 ${ins.index + 1} 行`);
  }
  seen.set(ins.index, ins.label);
}

if (totalInserted !== 61) {
  fail(`插入总行数 ${totalInserted} !== 61`);
}

const header = items[0];
if (!Array.isArray(header.raw)) {
  fail("文件头缺少 raw");
} else {
  if (header.raw.length !== 22) fail(`文件头 raw 长度 ${header.raw.length} !== 22`);
  if (!String(header.raw[0]).startsWith("// INV-01")) {
    fail(`文件头首行不是 // INV-01 -> ${JSON.stringify(header.raw[0])}`);
  }
  if (header.raw[18] !== "//") {
    fail(`文件头第 19 行不是单独的 // -> ${JSON.stringify(header.raw[18])}`);
  }
  const invSeen = header.raw.slice(0, 18).map((line, k) => {
    const expected = `// INV-${String(k + 1).padStart(2, "0")}`;
    if (!line.startsWith(expected)) fail(`文件头 INV 顺序错误，第 ${k + 1} 条应为 ${expected}`);
    if (!line.includes("守住位置")) fail(`文件头 ${expected} 缺少 守住位置`);
    if (!line.includes("改错故障")) fail(`文件头 ${expected} 缺少 改错故障`);
    return expected;
  });
  if (invSeen.length !== 18) fail("文件头 INV 条数不为 18");
  const labels = ["模块职责：", "状态所有权：", "阅读顺序："];
  for (let k = 0; k < labels.length; k += 1) {
    const line = header.raw[19 + k];
    if (!String(line).startsWith(`// ${labels[k]}`)) {
      fail(`文件头第 ${20 + k} 行缺少 ${labels[k]} -> ${JSON.stringify(line)}`);
    }
  }
}

if (errors.length > 0) {
  console.log(`FAIL count=${errors.length}`);
  for (const e of errors) console.log(`- ${e}`);
  process.exit(1);
}

inserts.sort((a, b) => a.index - b.index);
const preview = [];
let cursor = 0;
for (const ins of inserts) {
  while (cursor < ins.index) {
    preview.push(fileLines[cursor]);
    cursor += 1;
  }
  preview.push(...ins.produced);
}
while (cursor < fileLines.length) {
  preview.push(fileLines[cursor]);
  cursor += 1;
}

console.log(
  `OK blocks=${blockCount} lines=${totalInserted} anchors=${inserts.length} resultLines=${preview.length}`,
);
