import fs from "node:fs";

const target = "d:/code/ZCode/packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx";
const specPath = "d:/code/_annot_baseline/ZC-deep-b62-spec-01.json";

const srcLines = fs.readFileSync(target, "utf8").split(/\r?\n/);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const file = spec.files[0];
const items = file.items;

const errors = [];
const forbidStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let total = 0;
let invCount = 0;
const used = new Map();

items.forEach((item, i) => {
  const tag = `item[${i}]`;
  if (typeof item.anchor !== "string" || item.anchor.length === 0) {
    errors.push(`${tag} anchor 为空`);
    return;
  }
  const matches = srcLines
    .map((line, idx) => ({ idx, text: line.trim() }))
    .filter((entry) => entry.text === item.anchor.trim());
  const nth = item.nth ?? 1;
  if (matches.length === 0) {
    errors.push(`${tag} anchor 未匹配: ${JSON.stringify(item.anchor)}`);
  } else if (nth > matches.length) {
    errors.push(`${tag} nth=${nth} 超出出现次数 ${matches.length}: ${JSON.stringify(item.anchor)}`);
  }
  const key = `${item.anchor}::${nth}`;
  if (used.has(key)) {
    errors.push(`${tag} anchor+nth 重复: ${key}`);
  }
  used.set(key, i);

  const isRaw = Array.isArray(item.raw);
  const lines = isRaw ? item.raw : item.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push(`${tag} lines/raw 缺失`);
    return;
  }
  if (isRaw && i !== 0) {
    errors.push(`${tag} raw 只允许用于首条`);
  }
  total += lines.length;

  lines.forEach((line, j) => {
    const lineTag = `${tag}.line[${j}]`;
    if (line.includes("*/")) errors.push(`${lineTag} 含 */`);
    if (line.includes("=>")) errors.push(`${lineTag} 含 =>`);
    if (line.includes(";")) errors.push(`${lineTag} 含分号`);
    if (isRaw && !line.startsWith("//")) {
      errors.push(`${lineTag} raw 行未以 // 开头`);
      return;
    }
    const body = line.replace(/^\/\/\s?/, "").trim();
    if (body.length === 0) return;
    const first = body.split(/\s+/)[0];
    if (forbidStart.includes(first)) {
      errors.push(`${lineTag} 以禁词开头: ${first}`);
    }
    if (/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body)) {
      errors.push(`${lineTag} 命中 标识符.标识符( 形态: ${body}`);
    }
    if (i === 0 && /^INV-\d\d /.test(body)) invCount += 1;
  });
});

if (file.file !== "packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx") {
  errors.push(`file 路径不符: ${file.file}`);
}
if (total !== 68) errors.push(`总行数 ${total} != 68`);
if (items[0] && !Array.isArray(items[0].raw)) errors.push("首条不是 raw");
if (invCount < 18 || invCount > 20) errors.push(`INV 数量 ${invCount} 不在 18~20`);
if (items[0] && items[0].raw) {
  const last = items[0].raw[items[0].raw.length - 1].trim();
  if (last !== "//") errors.push(`文件头末行不是 "//": ${JSON.stringify(last)}`);
}

console.log(JSON.stringify({ items: items.length, total, invCount, errors }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
