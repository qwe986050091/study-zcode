import fs from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b62-spec-06.json";
const TARGET = "d:/code/ZCode/packages/ui/src/lib/codingPlanFunnelTelemetry.ts";

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const srcLines = fs.readFileSync(TARGET, "utf8").split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const errors = [];
const file = spec.files[0];
if (spec.files.length !== 1) errors.push(`files 数量应为 1，实际 ${spec.files.length}`);
if (file.file !== "packages/ui/src/lib/codingPlanFunnelTelemetry.ts")
  errors.push(`file 路径不符: ${file.file}`);

let total = 0;
file.items.forEach((item, i) => {
  const n = item.raw ? item.raw.length : item.lines.length;
  total += n;
  if (item.raw && item.lines) errors.push(`item#${i} 同时含 raw 与 lines`);
  if (!item.raw && !item.lines) errors.push(`item#${i} 既无 raw 也无 lines`);
  if (item.raw && i !== 0) errors.push(`item#${i} raw 只允许用于文件头`);

  const nth = item.nth ?? 1;
  const hits = [];
  trimmed.forEach((t, idx) => {
    if (t === item.anchor.trim()) hits.push(idx + 1);
  });
  if (hits.length === 0) errors.push(`item#${i} anchor 未匹配: ${JSON.stringify(item.anchor)}`);
  if (!item.nth && hits.length > 1)
    errors.push(`item#${i} anchor 重复 ${hits.length} 次但未写 nth: ${JSON.stringify(item.anchor)}`);
  if (item.nth && hits.length < nth)
    errors.push(`item#${i} nth=${nth} 超出出现次数 ${hits.length}: ${JSON.stringify(item.anchor)}`);
});

const BAN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const callForm = /[A-Za-z0-9_$]\.[A-Za-z0-9_$]+\(/;

let bodyLines = 0;
file.items.forEach((item, i) => {
  const arr = item.raw ? item.raw : item.lines.map((t) => (t === "" ? "//" : "// " + t));
  arr.forEach((raw, j) => {
    const where = `item#${i}[${j}]`;
    if (item.raw && !raw.startsWith("//")) errors.push(`${where} raw 行必须以 // 开头`);
    if (raw.includes("*/")) errors.push(`${where} 含 */`);
    let body = raw.replace(/^\/\/ ?/, "");
    if (body.trim() === "") return;
    bodyLines++;
    const first = body.trim().split(/[\s，。；、:：]/)[0];
    if (BAN_START.includes(first)) errors.push(`${where} 以禁词开头: ${first}`);
    if (BAN_START.some((w) => body.trim().startsWith(w + " "))) errors.push(`${where} 疑似以禁词开头`);
    if (/;/.test(body)) errors.push(`${where} 含半角分号`);
    if (body.trim().endsWith(";")) errors.push(`${where} 以分号结尾`);
    if (body.includes("=>")) errors.push(`${where} 含 =>`);
    if (callForm.test(body)) errors.push(`${where} 含 标识符.标识符( 调用形态`);
  });
});

const invs = (file.items[0].raw || []).filter((l) => /^\/\/ INV-\d\d /.test(l));
if (invs.length < 18 || invs.length > 20) errors.push(`INV 数量 ${invs.length} 不在 18~20`);
invs.forEach((l, k) => {
  const expected = `INV-${String(k + 1).padStart(2, "0")} `;
  if (!l.startsWith("// " + expected)) errors.push(`INV 编号不连续: ${l.slice(0, 12)}`);
  ["；守住位置：", "；改错故障："].forEach((mark) => {
    if (!l.includes(mark)) errors.push(`${expected} 缺少标记 ${mark}`);
  });
});

if (total < 68 || total > 70) errors.push(`总行数 ${total} 不在 68~70`);

console.log(`items=${file.items.length} total=${total} bodyLines=${bodyLines} inv=${invs.length}`);
if (errors.length) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" - " + e));
  process.exit(1);
}
console.log("ALL PASS");
