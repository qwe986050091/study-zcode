import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const specPath = resolve("d:/code/_annot_baseline/ZC-deep-b70-spec-09.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const IGNORE = new Set([
  // 占位：无
]);

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let totalInserted = 0;
let blockCount = 0;
let headerChecked = false;
const errors = [];

function fail(msg) {
  errors.push(msg);
}

for (const fileSpec of spec.files) {
  const filePath = resolve("d:/code/ZCode", fileSpec.file);
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const trimmed = lines.map((l) => l.trim());

  const insertions = [];
  const usedIndexes = new Set();

  fileSpec.items.forEach((item, itemIdx) => {
    blockCount += 1;
    const anchor = item.anchor.trim();
    const hits = [];
    trimmed.forEach((line, idx) => {
      if (line === anchor) hits.push(idx);
    });

    let target = -1;
    if (typeof item.nth === "number") {
      if (item.nth < 1 || item.nth > hits.length) {
        fail(`item#${itemIdx + 1} nth=${item.nth} 越界，命中数=${hits.length}，anchor=${anchor}`);
        return;
      }
      target = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        fail(`item#${itemIdx + 1} anchor 命中 ${hits.length} 次（要求唯一）：${anchor}`);
        return;
      }
      target = hits[0];
    }

    if (usedIndexes.has(target)) {
      fail(`item#${itemIdx + 1} 与已有 item 插入下标重复：${target}`);
      return;
    }
    usedIndexes.add(target);

    const isRaw = Array.isArray(item.raw);
    if (isRaw && Array.isArray(item.lines)) {
      fail(`item#${itemIdx + 1} 同时给出 raw 与 lines`);
      return;
    }
    const rawLines = isRaw ? item.raw : item.lines;
    if (!Array.isArray(rawLines)) {
      fail(`item#${itemIdx + 1} 缺少 raw/lines`);
      return;
    }

    const indentMatch = lines[target].match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : "";

    const produced = isRaw
      ? rawLines.slice()
      : rawLines.map((t) => (t === "" ? `${indent}//` : `${indent}// ${t}`));

    // 全行约束
    produced.forEach((line) => {
      if (!line.trimStart().startsWith("//")) {
        fail(`item#${itemIdx + 1} 插入行未以 // 开头：${line}`);
      }
      if (line.includes("*/")) {
        fail(`item#${itemIdx + 1} 插入行含 */：${line}`);
      }
      const trimmedLine = line.trim();
      if (trimmedLine.endsWith(";")) {
        fail(`item#${itemIdx + 1} 插入行以分号结尾：${line}`);
      }
      if (line.includes("=>")) {
        fail(`item#${itemIdx + 1} 插入行含箭头：${line}`);
      }
      const body = trimmedLine.replace(/^\/\/\s?/, "");
      const firstWord = body.match(/^([A-Za-z_$][\w$]*)/);
      if (firstWord && FORBIDDEN.includes(firstWord[1])) {
        fail(`item#${itemIdx + 1} 注释正文以禁止词开头（${firstWord[1]}）：${line}`);
      }
      if (CALL_EXPR.test(body)) {
        fail(`item#${itemIdx + 1} 注释正文疑似调用表达式：${line}`);
      }
      if (body.includes("(")) {
        fail(`item#${itemIdx + 1} 注释正文含左括号，保守拒绝：${line}`);
      }
    });

    if (isRaw && itemIdx === 0) {
      headerChecked = true;
      if (produced.length !== 22) {
        fail(`文件头 raw 行数=${produced.length}，要求 22`);
      }
      if (!produced[0].startsWith("// INV-01")) {
        fail(`文件头首行不是 // INV-01：${produced[0]}`);
      }
      if (produced[18] !== "//") {
        fail(`文件头第 19 行不是 //：${JSON.stringify(produced[18])}`);
      }
    }

    totalInserted += produced.length;
    insertions.push({ index: target, lines: produced });
  });

  if (!headerChecked) fail("第一个 item 不是文件头 raw 块");

  // 模拟插入，确认原有行未被改变且顺序稳定
  insertions.sort((a, b) => a.index - b.index);
  const out = [];
  let cursor = 0;
  for (const ins of insertions) {
    for (; cursor < ins.index; cursor += 1) out.push(lines[cursor]);
    out.push(...ins.lines);
  }
  for (; cursor < lines.length; cursor += 1) out.push(lines[cursor]);

  const originalNonEmpty = lines.filter((l, i) => lines.length && l !== undefined);
  const outSetOk = out.slice().sort().join("\u0000") === [...lines, ...insertions.flatMap((i) => i.lines)].sort().join("\u0000");
  if (!outSetOk) fail("模拟插入后行集合异常");
  if (originalNonEmpty.length !== lines.length) fail("原文件行读取异常");
  if (out.length !== lines.length + totalInserted) {
    fail(`模拟插入后总行数不符：${out.length} != ${lines.length} + ${totalInserted}`);
  }
}

if (totalInserted !== 63) fail(`插入总行数=${totalInserted}，要求 63`);
if (blockCount !== spec.files.reduce((n, f) => n + f.items.length, 0)) fail("块计数异常");

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
