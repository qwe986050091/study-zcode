import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-12.json";
const targetPath = "d:/code/ZCode/packages/ui/src/v4/ConversationDraftEmptyState.tsx";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const src = fs.readFileSync(targetPath, "utf8");
const rawLines = src.split(/\r?\n/);
const trimmed = rawLines.map((l) => l.trim());

const errors = [];
const bannedStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let total = 0;
let itemCount = 0;
const fileEntry = spec.files[0];
if (spec.files.length !== 1) errors.push("files 数量不为 1");
if (fileEntry.file !== "packages/ui/src/v4/ConversationDraftEmptyState.tsx") {
  errors.push("file 路径不符: " + fileEntry.file);
}

const seen = new Map();

for (const [i, item] of fileEntry.items.entries()) {
  itemCount++;
  const anchor = item.anchor;
  const payload = item.raw ?? item.lines;
  const len = payload.length;
  total += len;
  if (len < 1) errors.push(`item#${i} 行数为 0`);
  if (item.raw && item.lines) errors.push(`item#${i} 同时有 raw 与 lines`);

  // anchor 匹配统计
  const matches = [];
  trimmed.forEach((line, idx) => {
    if (line === anchor.trim()) matches.push(idx + 1);
  });
  const nth = item.nth ?? 1;
  if (matches.length === 0) {
    errors.push(`item#${i} anchor 未匹配: ${JSON.stringify(anchor)}`);
  } else if (matches.length > 1 && item.nth === undefined) {
    errors.push(`item#${i} anchor 出现 ${matches.length} 次但缺 nth: ${JSON.stringify(anchor)}`);
  } else if (nth > matches.length) {
    errors.push(`item#${i} nth=${nth} 超出匹配数 ${matches.length}: ${JSON.stringify(anchor)}`);
  }
  const key = anchor.trim();
  if (!seen.has(key)) seen.set(key, matches.length);

  // 内容校验
  payload.forEach((line, j) => {
    const where = `item#${i}:${j}`;
    if (/[\r\n]/.test(line)) errors.push(`${where} 含换行`);
    if (line.includes("*/")) errors.push(`${where} 含 */`);
    if (item.raw) {
      if (!line.startsWith("//")) errors.push(`${where} raw 行不以 // 开头`);
    }
    const body = line.replace(/^\s*\/\/\s?/, "");
    const bodyTrim = body.trim();
    if (bodyTrim.endsWith(";")) errors.push(`${where} 以 ; 结尾`);
    if (bodyTrim.includes("=>")) errors.push(`${where} 含 =>`);
    if (/[\p{L}\p{N}_$)\]]\.[\p{L}_$][\p{L}\p{N}_$]*\(/u.test(bodyTrim)) {
      errors.push(`${where} 命中 标识符.标识符( 调用形态`);
    }
    const firstWord = (bodyTrim.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) ?? [""])[0];
    if (bannedStart.includes(firstWord)) errors.push(`${where} 以禁词开头: ${firstWord}`);
  });
}

if (total < 71 || total > 73) errors.push(`总行数 ${total} 不在 71~73`);
if (total !== 71) errors.push(`期望 71 行，实际 ${total}`);
if (fileEntry.items[0].raw === undefined) errors.push("首个 item 不是 raw 文件头");
if (fileEntry.items[0].anchor.trim() !== "import {") errors.push("文件头锚点不是首条 import");

// INV 条数
const header = fileEntry.items[0].raw;
const invs = header.filter((l) => /^\/\/ INV-\d{2} /.test(l));
if (invs.length < 18 || invs.length > 20) errors.push(`INV 条数 ${invs.length} 不在 18~20`);
invs.forEach((l, idx) => {
  const want = `INV-${String(idx + 1).padStart(2, "0")} `;
  if (!l.includes(want)) errors.push(`INV 序号不连续: ${l.slice(0, 20)}`);
  if (!/；守住位置：.+；改错故障：.+。$/.test(l)) errors.push(`INV 结构不符: ${want}`);
});
if (header[header.length - 1].trim() !== "//") errors.push("文件头末尾不是空注释行");

console.log("items =", itemCount);
console.log("total lines =", total);
console.log("INV count =", invs.length);
console.log("anchor 去重情况:");
for (const [k, c] of seen) console.log(`  ${c} 次  ${k.slice(0, 60)}`);
if (errors.length) {
  console.log("\nFAIL:");
  errors.forEach((e) => console.log(" -", e));
  process.exit(1);
}
console.log("\n全部通过");
