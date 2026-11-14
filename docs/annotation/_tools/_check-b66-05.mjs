import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b66-spec-05.json";
const relPath = "apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-reads.ts";
const srcPath = `d:/code/ZCode/${relPath}`;

const errors = [];

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (error) {
  console.log("FAIL");
  console.log(" - JSON parse error:", error.message);
  process.exit(1);
}

const srcLines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/).map((l) => l.trim());

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  console.log("FAIL");
  console.log(" - spec must contain exactly one file entry");
  process.exit(1);
}

const bannedStart = [
  "const", "let", "var", "function", "class", "import", "export", "return", "if", "else",
  "for", "while", "switch", "try", "catch", "await", "async", "throw", "new", "interface",
  "type", "enum",
];
const callShape = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const fileEntry = spec.files[0];
if (fileEntry.file !== relPath) errors.push(`file path mismatch: ${fileEntry.file}`);
if (!Array.isArray(fileEntry.items) || fileEntry.items.length < 2) errors.push("items missing");

let total = 0;
const perItem = [];

fileEntry.items.forEach((item, idx) => {
  const lines = item.raw ?? item.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push(`item#${idx} missing raw/lines`);
    return;
  }
  perItem.push(lines.length);
  total += lines.length;

  if (typeof item.anchor !== "string" || item.anchor.trim() !== item.anchor) {
    errors.push(`item#${idx} anchor not trimmed: ${JSON.stringify(item.anchor)}`);
    return;
  }
  const hits = srcLines.filter((l) => l === item.anchor).length;
  const nth = item.nth ?? 1;
  if (hits === 0) errors.push(`item#${idx} anchor not found: ${item.anchor}`);
  if (hits > 1 && item.nth === undefined) {
    errors.push(`item#${idx} anchor duplicated (${hits}x) without nth: ${item.anchor}`);
  }
  if (nth > hits) errors.push(`item#${idx} nth=${nth} exceeds hits=${hits}: ${item.anchor}`);

  const isRaw = "raw" in item;
  lines.forEach((line, li) => {
    if (typeof line !== "string") {
      errors.push(`item#${idx} line#${li} not a string`);
      return;
    }
    if (isRaw && !line.startsWith("//")) {
      errors.push(`item#${idx} line#${li} raw not a comment: ${line}`);
      return;
    }
    const body = (isRaw ? line.replace(/^\/\/\s?/, "") : line).trim();
    if (body === "") return;
    if ((isRaw ? line : body).includes("*/")) errors.push(`item#${idx} line#${li} contains */`);
    if (body.endsWith(";")) errors.push(`item#${idx} line#${li} ends with ;`);
    if (body.includes(";")) errors.push(`item#${idx} line#${li} contains ascii ;`);
    if (body.includes("=>")) errors.push(`item#${idx} line#${li} contains =>`);
    if (callShape.test(body)) errors.push(`item#${idx} line#${li} dotted-call shape: ${body}`);
    const first = body.split(/[\s，。、（(]/)[0];
    if (bannedStart.includes(first)) errors.push(`item#${idx} line#${li} banned start: ${first}`);
  });
});

const header = fileEntry.items[0];
if (header.anchor !== srcLines[0]) errors.push(`first anchor != first source line: ${header.anchor}`);
const headerLines = header.raw ?? [];
if (headerLines.length !== 22) errors.push(`header lines = ${headerLines.length}, expected 22`);
const invLines = headerLines.filter((l) => l.startsWith("// INV-"));
if (invLines.length !== 18) errors.push(`INV count = ${invLines.length}, expected 18`);
const blankIdx = headerLines.findIndex((l) => l.trim() === "//");
if (blankIdx !== 18) errors.push(`header separator index = ${blankIdx}, expected 18`);
const summary = headerLines.length - blankIdx - 1;
if (summary !== 3) errors.push(`header summary lines = ${summary}, expected 3`);

if (total !== 65) errors.push(`total lines = ${total}, expected 65`);

console.log("items:", fileEntry.items.length, "per-item:", perItem.join("+"), "total:", total);
console.log("INV:", invLines.length, "summary:", summary);
if (errors.length) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" -", e));
  process.exit(1);
}
console.log("OK");
