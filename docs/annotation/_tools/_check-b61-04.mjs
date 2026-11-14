import { readFileSync } from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b61-spec-04.json";
const targetPath = "d:\\code\\ZCode\\apps\\zcode-cli\\packages\\dynamic-workflow\\src\\index.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const fileLines = readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = fileLines.map((l) => l.trim());

const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errs = [];
let total = 0;
let itemCount = 0;
const seen = new Map();

for (const file of spec.files) {
  for (const item of file.items) {
    itemCount += 1;
    total += item.raw ? item.raw.length : item.lines.length;

    // anchor 出现次数（trim 后整行相等）
    const hits = trimmed.reduce((acc, line, idx) => (line === item.anchor.trim() ? [...acc, idx + 1] : acc), []);
    if (hits.length === 0) {
      errs.push(`anchor 未命中: ${JSON.stringify(item.anchor)}`);
      continue;
    }
    const nth = item.nth ?? 1;
    seen.set(item.anchor, (seen.get(item.anchor) ?? 0) + 1);
    if (hits.length > 1 && item.nth === undefined) {
      errs.push(`anchor 重复 ${hits.length} 次但缺 nth: ${JSON.stringify(item.anchor)} 行 ${hits.join(",")}`);
    }
    if (nth > hits.length) {
      errs.push(`nth 越界 ${nth}/${hits.length}: ${JSON.stringify(item.anchor)}`);
    }

    const body = item.raw ? item.raw : item.lines.map((l) => `// ${l}`);
    for (const rawLine of body) {
      if (!rawLine.startsWith("//")) {
        errs.push(`非注释行: ${JSON.stringify(rawLine)}`);
        continue;
      }
      let text = rawLine.replace(/^\/\/\s?/, "");
      if (rawLine === "//") text = "";
      if (text.includes("*/")) errs.push(`含 */: ${JSON.stringify(rawLine)}`);
      if (/=>/.test(text)) errs.push(`含 =>: ${JSON.stringify(rawLine)}`);
      if (/;\s*$/.test(text)) errs.push(`以 ; 结尾: ${JSON.stringify(rawLine)}`);
      const first = text.split(/\s+/)[0] ?? "";
      if (banned.includes(first)) errs.push(`禁词开头 ${first}: ${JSON.stringify(rawLine)}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(text)) {
        errs.push(`标识符.标识符( 形态: ${JSON.stringify(rawLine)}`);
      }
    }
  }
}

console.log(`items = ${itemCount}`);
console.log(`total lines = ${total}`);
if (total !== 71) errs.push(`总行数 ${total} != 71`);
if (errs.length) {
  console.log("FAIL");
  for (const e of errs) console.log(" - " + e);
  process.exit(1);
}
console.log("PASS: 全部检查通过");
