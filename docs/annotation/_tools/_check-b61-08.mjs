import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZZZ_TMP_SPEC".replace("ZZZ_TMP_SPEC", "ZC-deep-b61-spec-08.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const file = spec.files[0];
const src = fs.readFileSync("d:/code/ZCode/" + file.file, "utf8").split(/\r?\n/);
const trimmed = src.map((l) => l.trim());

const items = file.items;
let total = 0;
const errors = [];

const BANNED = ["const", "let", "var", "function", "class", "import", "export", "return", "if", "else", "for", "while", "switch", "try", "catch", "await", "async", "throw", "new", "interface", "type", "enum"];

function stripComment(line) {
  const m = line.match(/^\/\/ ?(.*)$/);
  return m ? m[1] : null;
}

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const lines = it.raw ? it.raw : it.lines;
  total += lines.length;
  if (!it.raw) {
    if (!Array.isArray(it.lines) || it.lines.length === 0) errors.push(`item ${i}: 缺 lines`);
    if (it.raw !== undefined) errors.push(`item ${i}: 同时有 raw 与 lines`);
  } else if (!Array.isArray(it.raw) || it.raw.length === 0) {
    errors.push(`item ${i}: 缺 raw`);
  }
  if (typeof it.anchor !== "string" || it.anchor === "") errors.push(`item ${i}: anchor 为空`);
  if (it.anchor.includes("\n")) errors.push(`item ${i}: anchor 含换行`);
  if (it.anchor !== it.anchor.trim()) errors.push(`item ${i}: anchor 首尾有空白`);

  const count = trimmed.filter((l) => l === it.anchor).length;
  const nth = it.nth ?? 1;
  if (count === 0) errors.push(`item ${i}: anchor 未匹配 -> ${JSON.stringify(it.anchor)}`);
  if (count > 1 && it.nth === undefined) errors.push(`item ${i}: anchor 重复 ${count} 次但无 nth -> ${JSON.stringify(it.anchor)}`);
  if (it.nth !== undefined && (nth < 1 || nth > count)) errors.push(`item ${i}: nth=${nth} 超出出现次数 ${count}`);

  // 注释行校验（普通 item 按插入器规则补 // 前缀后模拟）
  for (let j = 0; j < lines.length; j++) {
    const entry = lines[j];
    if (!it.raw && entry.startsWith("//")) {
      errors.push(`item ${i} line ${j}: 普通 item 不应自带 // 前缀`);
    }
    const raw = it.raw ? entry : entry === "" ? "//" : `// ${entry}`;
    if (!raw.startsWith("//")) {
      errors.push(`item ${i} line ${j}: 非整行注释 -> ${JSON.stringify(entry)}`);
      continue;
    }
    const body = stripComment(raw);
    if (body === null) continue;
    if (raw.includes("*/")) errors.push(`item ${i} line ${j}: 含 */`);
    const content = body.trim();
    if (content === "") continue;
    if (content.endsWith(";")) errors.push(`item ${i} line ${j}: 以 ; 结尾`);
    if (content.includes("=>")) errors.push(`item ${i} line ${j}: 含 =>`);
    if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(content)) errors.push(`item ${i} line ${j}: 标识符.标识符( 形态`);
    const first = content.split(/\s+/)[0];
    if (BANNED.includes(first)) errors.push(`item ${i} line ${j}: 禁词开头 ${first}`);
    if (content.includes(";")) errors.push(`item ${i} line ${j}: 含半角分号`);
  }
}

if (total !== 71) errors.push(`总行数 ${total} != 71`);
if (items[0].raw === undefined) errors.push("首项不是 raw 文件头");
if (items[0].anchor !== src[0].trim()) errors.push("文件头锚点不是第一条 import");

const invCount = items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) errors.push(`INV 条数 ${invCount} 不在 18~20`);
if (items[0].raw[items[0].raw.length - 4] !== "//") {
  // 允许末尾总述，检查 INV 段后确实是空注释行
  const idx = items[0].raw.findIndex((l) => l === "//");
  if (idx < 0) errors.push("文件头缺少空 // 收尾行");
}

console.log(JSON.stringify({ items: items.length, total, invCount, errors }, null, 2));
