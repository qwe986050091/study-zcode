import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b62-spec-07.json";
const target = "d:/code/ZCode/packages/ui/src/components/ai-elements/jsx-preview.tsx";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const srcRaw = fs.readFileSync(target, "utf8");
const srcLines = srcRaw.split(/\r?\n/).map((l) => l.trim());
const fileLines = new Set(srcLines);

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let errors = [];
let total = 0;

for (const file of spec.files) {
  if (file.file !== "packages/ui/src/components/ai-elements/jsx-preview.tsx") {
    errors.push(`unexpected file entry: ${file.file}`);
  }
  for (const item of file.items) {
    const lines = item.raw ?? item.lines;
    if (!Array.isArray(lines)) {
      errors.push(`missing lines for anchor: ${item.anchor}`);
      continue;
    }
    total += lines.length;

    const anchorTrim = item.anchor.trim();
    const occurrences = srcLines.filter((l) => l === anchorTrim).length;
    const nth = item.nth ?? 1;
    if (occurrences === 0) {
      errors.push(`anchor not found: ${JSON.stringify(item.anchor)}`);
    } else if (occurrences > 1 && item.nth === undefined) {
      errors.push(`anchor duplicated (${occurrences}) without nth: ${JSON.stringify(item.anchor)}`);
    } else if (nth < 1 || nth > occurrences) {
      errors.push(`nth out of range (${nth}/${occurrences}): ${JSON.stringify(item.anchor)}`);
    }

    for (const [i, line] of lines.entries()) {
      const text = item.raw ? line : line;
      if (text.includes("*/")) errors.push(`contains */ : ${JSON.stringify(line)}`);
      if (item.raw) {
        if (!text.trim().startsWith("//")) errors.push(`raw line not a comment: ${JSON.stringify(line)}`);
        const body = text.replace(/^\s*\/\//, "").trim();
        checkBody(body, line, i);
      } else {
        const body = line.trim();
        checkBody(body, line, i);
      }
    }
  }
}

function checkBody(body, line, i) {
  if (body === "") return;
  if (/[;]\s*$/.test(body) || body.includes(";")) errors.push(`contains ; : ${JSON.stringify(line)}`);
  if (body.includes("=>")) errors.push(`contains => : ${JSON.stringify(line)}`);
  if (/[\u4e00-\u9fa5A-Za-z0-9_$)\]]\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(body)) {
    errors.push(`call pattern id.id( : ${JSON.stringify(line)}`);
  }
  const words = body.replace(/^\[[^\]]*\]\s*/, "");
  for (const w of BANNED_START) {
    if (new RegExp(`^${w}(?![A-Za-z0-9_$])`).test(words)) {
      errors.push(`banned start "${w}": ${JSON.stringify(line)}`);
    }
  }
}

if (total < 68 || total > 70) errors.push(`total lines = ${total}, expected 68~70`);
if (total !== 68) errors.push(`total lines = ${total}, preferred 68`);
if (fileLines.size === 0) errors.push("empty source file");

console.log(`items = ${spec.files[0].items.length}`);
console.log(`total lines = ${total}`);
console.log(errors.length === 0 ? "CHECK PASS" : `CHECK FAIL (${errors.length})`);
for (const e of errors) console.log("  - " + e);
process.exit(errors.length === 0 ? 0 : 1);
