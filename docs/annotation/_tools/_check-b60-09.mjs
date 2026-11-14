import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-09.json";
const targetPath = "d:/code/ZCode/packages/ui/src/lib/assistantFileReferences.ts";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const file = spec.files[0];
const srcLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const errors = [];
const items = file.items;

// 1) anchor 匹配与 nth
const seen = new Map();
for (const [i, item] of items.entries()) {
  const anchor = item.anchor;
  const matches = [];
  trimmed.forEach((l, idx) => {
    if (l === anchor) matches.push(idx + 1);
  });
  const nth = item.nth ?? 1;
  if (matches.length === 0) {
    errors.push(`[anchor] item#${i} 未匹配: ${JSON.stringify(anchor)}`);
  } else if (nth > matches.length) {
    errors.push(`[anchor] item#${i} nth=${nth} 超出出现次数 ${matches.length}: ${JSON.stringify(anchor)}`);
  }
  if (matches.length > 1 && !item.nth) {
    errors.push(`[anchor] item#${i} 出现 ${matches.length} 次但未声明 nth: ${JSON.stringify(anchor)}`);
  }
  const key = `${anchor}#${nth}`;
  if (seen.has(key)) errors.push(`[anchor] item#${i} 与 item#${seen.get(key)} 命中同一行`);
  seen.set(key, i);
}

// 2) 总数
const total = items.reduce((n, it) => n + (it.raw ? it.raw.length : it.lines.length), 0);
if (total !== 70) errors.push(`[total] 总行数 ${total}，期望 70`);

// 3) raw 只用于文件头
items.forEach((it, i) => {
  if (it.raw && i !== 0) errors.push(`[raw] item#${i} 非文件头却使用 raw`);
  if (!it.raw && !Array.isArray(it.lines)) errors.push(`[shape] item#${i} 缺少 lines`);
});

// 4) 注释内容约束
const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const checkLine = (text, where) => {
  if (text.includes("*/")) errors.push(`[禁串] ${where} 含 */: ${text}`);
  if (text.includes("=>")) errors.push(`[禁串] ${where} 含 =>: ${text}`);
  if (text.trimEnd().endsWith(";")) errors.push(`[禁串] ${where} 以 ; 结尾: ${text}`);
  if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(text)) {
    errors.push(`[禁形] ${where} 出现 标识符.标识符( 调用形态: ${text}`);
  }
  const body = text.replace(/^\/\/\s?/, "").trim();
  if (!body) return;
  const first = body.match(/^[A-Za-z]+/);
  if (first && banned.includes(first[0])) {
    errors.push(`[禁词] ${where} 以 ${first[0]} 开头: ${text}`);
  }
};

items.forEach((it, i) => {
  const arr = it.raw ?? it.lines.map((l) => `// ${l}`);
  arr.forEach((l, j) => {
    if (!l.startsWith("//")) errors.push(`[prefix] item#${i} 行#${j} 缺少 // 前缀: ${l}`);
    checkLine(l, `item#${i} 行#${j}`);
  });
});

// 5) 文件头结构
const head = items[0].raw ?? [];
const invs = head.filter((l) => /^\/\/ INV-\d\d /.test(l));
if (invs.length < 18 || invs.length > 20) errors.push(`[head] INV 条数 ${invs.length}，期望 18~20`);
invs.forEach((l, i) => {
  if (!/^\/\/ INV-\d\d 断言：.+；守住位置：.+；改错故障：.+$/.test(l)) {
    errors.push(`[head] INV 格式不符: ${l}`);
  }
  const no = String(i + 1).padStart(2, "0");
  if (!l.startsWith(`// INV-${no} `)) errors.push(`[head] INV 编号不连续: ${l}`);
});
if (head[head.length - 1] !== "//") errors.push("[head] 文件头末尾不是 // 空行");

console.log(JSON.stringify({ items: items.length, total, inv: invs.length, errors }, null, 2));
process.exit(errors.length ? 1 : 0);
