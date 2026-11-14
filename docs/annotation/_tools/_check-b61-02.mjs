import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b61-spec-02.json";
const ROOT = "d:/code/ZCode/";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const errors = [];
let total = 0;
let itemCount = 0;

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

for (const fileSpec of spec.files) {
  const srcPath = ROOT + fileSpec.file;
  const src = readFileSync(srcPath, "utf8");
  const srcLines = src.split(/\r?\n/);
  const trimmed = srcLines.map((l) => l.trim());

  const seen = new Map();
  for (const item of fileSpec.items) {
    itemCount += 1;
    const a = item.anchor;
    const count = trimmed.filter((l) => l === a).length;
    if (count === 0) errors.push(`anchor 未匹配: ${JSON.stringify(a)}`);
    const nth = item.nth ?? 1;
    if (count > 1 && item.nth === undefined) {
      errors.push(`anchor 不唯一且缺 nth (count=${count}): ${JSON.stringify(a)}`);
    }
    if (item.nth !== undefined && (nth < 1 || nth > count)) {
      errors.push(`nth 越界 (count=${count}, nth=${nth}): ${JSON.stringify(a)}`);
    }
    const key = `${a}#${nth}`;
    if (seen.has(key)) errors.push(`重复挂载同一 anchor: ${JSON.stringify(a)}`);
    seen.set(key, true);

    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (hasRaw === hasLines) errors.push(`item 必须且只能有 raw 或 lines: ${JSON.stringify(a)}`);
    const body = hasRaw ? item.raw : item.lines;
    total += body.length;

    for (const line of body) {
      if (hasRaw) {
        if (!line.startsWith("//")) errors.push(`raw 行必须以 // 开头: ${JSON.stringify(line)}`);
      }
      if (line.includes("*/")) errors.push(`注释含 */: ${JSON.stringify(line)}`);
      if (line.includes("=>")) errors.push(`注释含 =>: ${JSON.stringify(line)}`);
      const content = line.replace(/^\/\/\s?/, "");
      if (/;\s*$/.test(content)) errors.push(`注释以 ; 结尾: ${JSON.stringify(line)}`);
      const head = content.trimStart();
      for (const w of BANNED_START) {
        if (head === w || head.startsWith(w + " ")) {
          errors.push(`注释以禁词 ${w} 开头: ${JSON.stringify(line)}`);
        }
      }
      if (/[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(content)) {
        errors.push(`注释含 标识符.标识符( 调用形态: ${JSON.stringify(line)}`);
      }
    }
  }
}

const invCount = spec.files[0].items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) errors.push(`INV 条数越界: ${invCount}`);

console.log(`items=${itemCount} totalLines=${total} inv=${invCount}`);
if (errors.length) {
  console.log("FAIL");
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}
console.log("ALL PASS");
