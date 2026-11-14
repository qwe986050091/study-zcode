import fs from "node:fs";
import path from "node:path";

const specPath = "d:/code/_annot_baseline/ZC-deep-b62-spec-02.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const entry = spec.files[0];
const targetPath = path.join("d:/code/ZCode", entry.file);
const raw = fs.readFileSync(targetPath, "utf8");
const srcLines = raw.split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const forbiddenStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let total = 0;
let problems = [];
let itemCount = 0;

for (const item of entry.items) {
  itemCount += 1;
  const lines = item.raw ? item.raw : item.lines;
  total += lines.length;

  if (!Array.isArray(lines) || lines.length === 0) {
    problems.push("empty item: " + JSON.stringify(item.anchor));
  }
  if (item.raw && item !== entry.items[0]) {
    problems.push("raw used outside header: " + item.anchor);
  }
  if (item.lines && item !== entry.items[0]) {
    if (item.nth !== undefined) problems.push("unexpected nth: " + item.anchor);
  }

  const matches = [];
  trimmed.forEach((t, i) => { if (t === item.anchor.trim()) matches.push(i + 1); });
  const expectNth = item.nth ?? 1;
  if (matches.length === 0) {
    problems.push("anchor not found: " + item.anchor);
  } else if (item.nth === undefined && matches.length !== 1) {
    problems.push("anchor not unique (" + matches.length + "): " + item.anchor + " lines=" + matches.join(","));
  } else if (item.nth !== undefined && matches.length < item.nth) {
    problems.push("nth out of range: " + item.anchor + " nth=" + item.nth + " matches=" + matches.length);
  }

  for (const line of lines) {
    if (line.includes("*/")) problems.push("contains */: " + line);
    if (line.includes("=>")) problems.push("contains =>: " + line);
    const body = line.startsWith("//") ? line.slice(2).trimStart() : line.trimStart();
    if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body)) {
      problems.push("dotted call: " + line);
    }
    const firstWord = body.match(/^[A-Za-z_$][\w$]*/);
    if (firstWord && forbiddenStart.includes(firstWord[0])) {
      problems.push("forbidden start (" + firstWord[0] + "): " + line);
    }
    if (body.trimEnd().endsWith(";")) problems.push("ends with ;: " + line);
  }
}

const invCount = entry.items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;

console.log("items =", itemCount);
console.log("total lines =", total);
console.log("INV count =", invCount);
console.log("problems =", problems.length);
for (const p of problems) console.log("  -", p);
process.exit(problems.length === 0 && total === 68 ? 0 : 1);
