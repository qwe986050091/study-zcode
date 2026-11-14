import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b61-spec-10.json";
const targetPath = "d:/code/ZCode/packages/ui/src/components/ai-elements/speech-input.tsx";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const src = fs.readFileSync(targetPath, "utf8");
const rawLines = src.split(/\r?\n/);

let total = 0;
const errors = [];

const BAN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const files = spec.files || [];
for (const f of files) {
  if (f.file !== "packages/ui/src/components/ai-elements/speech-input.tsx") {
    errors.push(`文件路径不符: ${f.file}`);
  }
  const items = f.items || [];
  console.log(`文件: ${f.file}  items=${items.length}`);

  const anchorCount = new Map();
  for (const it of items) {
    if (typeof it.anchor !== "string" || it.anchor === "") {
      errors.push("存在空 anchor");
      continue;
    }
    anchorCount.set(it.anchor, (anchorCount.get(it.anchor) || 0) + 1);
  }

  items.forEach((it, idx) => {
    const n = idx + 1;
    const isRaw = Array.isArray(it.raw);
    const lines = isRaw ? it.raw : it.lines;
    if (!Array.isArray(lines)) {
      errors.push(`#${n} 缺少 raw/lines`);
      return;
    }
    total += lines.length;

    const anchor = it.anchor;
    const matched = rawLines.filter((l) => l.trim() === anchor.trim());
    const occurrence = anchorCount.get(anchor) || 1;
    const nth = it.nth || 1;

    if (matched.length === 0) {
      errors.push(`#${n} anchor 未命中: ${JSON.stringify(anchor)}`);
    } else if (nth > matched.length) {
      errors.push(`#${n} nth=${nth} 超出出现次数 ${matched.length}: ${JSON.stringify(anchor)}`);
    } else if (occurrence === 1 && matched.length > 1 && !it.nth) {
      errors.push(`#${n} anchor 出现 ${matched.length} 次但未标注 nth: ${JSON.stringify(anchor)}`);
    }

    lines.forEach((line, li) => {
      const tag = `#${n}.${li + 1}`;
      if (typeof line !== "string") {
        errors.push(`${tag} 非字符串`);
        return;
      }
      if (line.includes("*/")) errors.push(`${tag} 含 */`);
      const body = isRaw ? line.replace(/^\/\/\s?/, "") : line;
      if (body.includes(";")) errors.push(`${tag} 含分号 ; : ${JSON.stringify(line)}`);
      if (body.includes("=>")) errors.push(`${tag} 含 => : ${JSON.stringify(line)}`);
      if (/[\w$)\]]\.[\w$]+\s*\(/.test(body)) {
        errors.push(`${tag} 疑似 标识符.标识符( 调用形态: ${JSON.stringify(line)}`);
      }
      const first = body.trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
      if (BAN_START.includes(first)) {
        errors.push(`${tag} 以禁用词开头(${first}): ${JSON.stringify(line)}`);
      }
    });
  });

  const header = items[0];
  if (!header || !Array.isArray(header.raw)) {
    errors.push("首个 item 不是 raw 文件头");
  } else {
    const invCount = header.raw.filter((l) => /^\/\/\s*INV-\d{2}\s/.test(l)).length;
    if (invCount < 18 || invCount > 20) errors.push(`文件头 INV 数量异常: ${invCount}`);
    if (header.raw[header.raw.length - 1] !== "//") errors.push("文件头未以 \"//\" 收尾");
    if (header.raw[0].includes("use client")) errors.push("文件头顺序异常");
  }
}

console.log(`items 总数=${spec.files[0].items.length}`);
console.log(`注释总行数=${total}`);
if (total < 70 || total > 72) errors.push(`总行数超出范围: ${total}`);

if (errors.length) {
  console.log("自检失败:");
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log("自检全部通过");
