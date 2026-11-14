import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(dir, "ZC-deep-b63-spec-03.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const files = spec.files;
if (!Array.isArray(files) || files.length === 0) fail("files 为空");
const entry = files[0];
if (!entry || typeof entry.file !== "string") fail("files[0].file 缺失");
const targetPath = path.resolve(dir, "..", "ZCode", entry.file);
if (!fs.existsSync(targetPath)) fail(`目标文件不存在: ${targetPath}`);

const source = fs.readFileSync(targetPath, "utf8").replace(/\r?\n$/, "");
const sourceLines = source.split(/\r?\n/);

const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

const first = items[0];
if (!first || !Array.isArray(first.raw)) fail("首项缺少 raw");
for (const [index, line] of first.raw.entries()) {
  if (typeof line !== "string" || !(line.startsWith("// ") || line.startsWith("//"))) {
    fail(`raw[${index}] 不是 // 注释行: ${line}`);
  }
}

for (let i = 1; i < items.length; i += 1) {
  if (!Array.isArray(items[i].lines)) fail(`items[${i}] 缺少 lines`);
  for (const [j, line] of items[i].lines.entries()) {
    if (typeof line !== "string" || line.length === 0) fail(`items[${i}].lines[${j}] 非法`);
  }
}

const totalAnnotated = first.raw.length + items.slice(1).reduce((sum, item) => sum + item.lines.length, 0);
if (totalAnnotated !== 70) fail(`注释总行数应为 70，实际 ${totalAnnotated}`);

const BANNED_START = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const MEMBER_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const checkText = (text, where) => {
  if (text.includes("*/")) fail(`${where} 含 */`);
  if (/;$/.test(text)) fail(`${where} 以 ; 结尾`);
  if (text.includes("=>")) fail(`${where} 含 =>`);
  if (MEMBER_CALL.test(text)) fail(`${where} 含成员调用`);
  if (BANNED_START.test(text)) fail(`${where} 以关键字开头`);
};

for (const [index, line] of first.raw.entries()) {
  const stripped = line.startsWith("// ") ? line.slice(3) : line.slice(2);
  checkText(stripped, `raw[${index}]`);
}
for (let i = 1; i < items.length; i += 1) {
  for (const [j, line] of items[i].lines.entries()) {
    checkText(line, `items[${i}].lines[${j}]`);
  }
}

const resolveIndex = (item, itemIndex) => {
  if (typeof item.anchor !== "string" || item.anchor.length === 0) {
    fail(`items[${itemIndex}] 缺少 anchor`);
  }
  const anchor = item.anchor.trim();
  const matches = [];
  sourceLines.forEach((line, lineIndex) => {
    if (line.trim() === anchor) matches.push(lineIndex);
  });
  if (matches.length === 0) fail(`items[${itemIndex}] anchor 未找到: ${anchor}`);
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
      fail(`items[${itemIndex}] nth 越界: ${item.nth} (匹配 ${matches.length})`);
    }
    return matches[item.nth - 1];
  }
  if (matches.length !== 1) fail(`items[${itemIndex}] anchor 不唯一: ${matches.length} 处匹配 ${anchor}`);
  return matches[0];
};

const insertions = items.map((item, itemIndex) => ({
  index: resolveIndex(item, itemIndex),
  order: itemIndex,
  lines: item.raw ?? item.lines,
}));

const output = [];
let cursor = 0;
const sorted = insertions.slice().sort((a, b) => a.index - b.index || a.order - b.order);
for (const insertion of sorted) {
  while (cursor < insertion.index) {
    output.push(sourceLines[cursor]);
    cursor += 1;
  }
  output.push(...insertion.lines);
}
while (cursor < sourceLines.length) {
  output.push(sourceLines[cursor]);
  cursor += 1;
}

const commentCount = output.filter((line) => line.trim().startsWith("//")).length;
const codeCount = output.filter((line) => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("//");
}).length;
const ratio = commentCount / codeCount;
console.log(
  `总行数=${output.length} 注释行=${commentCount} 代码行=${codeCount} 比例=${(ratio * 100).toFixed(2)}%`,
);
if (ratio < 0.312 || ratio > 0.316) fail(`注释/代码比越界: ${(ratio * 100).toFixed(2)}%`);
if (output.length !== 503) fail(`插入后总行数应为 503，实际 ${output.length}`);

console.log(`anchors=${items.length} totalAnnotated=${totalAnnotated}`);
console.log("OK");
