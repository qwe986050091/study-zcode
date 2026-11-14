import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b61-spec-11.json";
const repoRoot = "d:/code/ZCode";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const forbiddenStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let errors = [];
let total = 0;
let itemCount = 0;

for (const fileEntry of spec.files) {
  const abs = `${repoRoot}/${fileEntry.file}`;
  const srcLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const trimmed = srcLines.map((l) => l.trim());

  fileEntry.items.forEach((item, idx) => {
    itemCount++;
    const body = item.raw ?? item.lines;
    if (!Array.isArray(body)) {
      errors.push(`item#${idx} 缺少 raw 或 lines`);
      return;
    }
    total += body.length;

    if (item.raw && item.lines) errors.push(`item#${idx} 同时存在 raw 与 lines`);
    if (idx === 0 && !item.raw) errors.push("首个 item 不是 raw 文件头");
    if (idx > 0 && item.raw) errors.push(`item#${idx} 非文件头却使用 raw`);

    const hits = trimmed.map((l, i) => (l === item.anchor ? i + 1 : 0)).filter(Boolean);
    if (hits.length === 0) {
      errors.push(`item#${idx} anchor 未匹配: ${item.anchor}`);
    } else if (item.nth) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`item#${idx} nth 越界: ${item.nth}, 命中 ${hits.length}`);
      }
    } else if (hits.length > 1) {
      errors.push(`item#${idx} anchor 重复 ${hits.length} 次却未给 nth: ${item.anchor}`);
    }

    body.forEach((line, li) => {
      const text = item.raw ? line.replace(/^\/\/\s?/, "") : line;
      if (line.includes("*/")) errors.push(`item#${idx} 第${li + 1}行含 */`);
      if (line.includes("=>")) errors.push(`item#${idx} 第${li + 1}行含 =>`);
      if (/;\s*$/.test(text)) errors.push(`item#${idx} 第${li + 1}行以分号结尾`);
      const firstWord = text.trim().split(/\s+/)[0] ?? "";
      if (forbiddenStart.includes(firstWord)) {
        errors.push(`item#${idx} 第${li + 1}行以禁词开头: ${firstWord}`);
      }
      if (/[\w$)\]]+\.[A-Za-z_$][\w$]*\s*\(/.test(text)) {
        errors.push(`item#${idx} 第${li + 1}行含 标识符.标识符( 调用形态`);
      }
    });
  });

  if (fileEntry.items[0]?.raw) {
    const invs = fileEntry.items[0].raw.filter((l) => /^\/\/ INV-\d{2} /.test(l));
    if (invs.length < 18 || invs.length > 20) {
      errors.push(`INV 条数 ${invs.length} 不在 18~20`);
    }
    if (fileEntry.items[0].raw.at(-1) !== "//") errors.push("文件头未以 // 收尾");
  }
}

if (total < 68 || total > 70) errors.push(`总行数 ${total} 不在 68~70`);
if (total !== 68) errors.push(`总行数 ${total} 不是优先值 68`);

console.log(JSON.stringify({ itemCount, total, errors }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
