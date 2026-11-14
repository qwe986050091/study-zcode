import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b71-spec-07.json";
const TARGET = "d:/code/ZCode/packages/ui/src/UpdateStatusDialogController.tsx";
const EXPECTED_TOTAL = 63;
const HEADER_LEN = 22;

const BANNED_PREFIX = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/;

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split(/\r?\n/);

let total = 0;
const used = new Map();
const errors = [];

for (const fileEntry of spec.files) {
  if (fileEntry.file !== "packages/ui/src/UpdateStatusDialogController.tsx") {
    errors.push(`unexpected file: ${fileEntry.file}`);
  }

  fileEntry.items.forEach((item, itemIndex) => {
    const anchorText = item.anchor.trim();
    const hits = [];
    srcLines.forEach((line, i) => {
      if (line.trim() === anchorText) hits.push(i);
    });

    let anchorIndex = -1;
    if (item.nth) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`item#${itemIndex}: nth=${item.nth} out of range (hits=${hits.length})`);
        return;
      }
      anchorIndex = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`item#${itemIndex}: anchor not unique (hits=${hits.length}) :: ${anchorText}`);
        return;
      }
      anchorIndex = hits[0];
    }

    if (used.has(anchorIndex)) {
      errors.push(`item#${itemIndex}: duplicate insert index ${anchorIndex} (also used by item#${used.get(anchorIndex)})`);
    }
    used.set(anchorIndex, itemIndex);

    const inserted = [];
    if (Array.isArray(item.raw)) {
      if (item.lines) errors.push(`item#${itemIndex}: both raw and lines present`);
      for (const entry of item.raw) {
        if (/^\s/.test(entry)) errors.push(`item#${itemIndex}: raw line has leading indent: ${JSON.stringify(entry)}`);
        inserted.push(entry);
      }
    } else if (Array.isArray(item.lines)) {
      const indent = (srcLines[anchorIndex].match(/^[ \t]*/) || [""])[0];
      for (const entry of item.lines) {
        inserted.push(entry === "" ? `${indent}//` : `${indent}// ${entry}`);
      }
    } else {
      errors.push(`item#${itemIndex}: neither raw nor lines`);
      return;
    }

    if (itemIndex === 0) {
      if (!item.raw) errors.push("header item must use raw");
      if (inserted.length !== HEADER_LEN) errors.push(`header raw length ${inserted.length} !== ${HEADER_LEN}`);
      if (!inserted[0].startsWith("// INV-01")) errors.push(`header first line must start with // INV-01, got: ${inserted[0]}`);
      if (inserted[18] !== "//") errors.push(`header line 19 must be //, got: ${JSON.stringify(inserted[18])}`);
      const invRe = /^\/\/ INV-(\d{2}) /;
      inserted.slice(0, 18).forEach((line, i) => {
        const m = line.match(invRe);
        if (!m) errors.push(`header INV line ${i + 1} malformed: ${line}`);
        else if (Number(m[1]) !== i + 1) errors.push(`header INV numbering broken at ${i + 1}: ${line}`);
        if (!line.includes("守住位置") || !line.includes("改错故障")) {
          errors.push(`header INV line ${i + 1} missing 守住位置/改错故障: ${line}`);
        }
      });
    } else {
      if (inserted.length < 3 || inserted.length > 6) {
        errors.push(`item#${itemIndex}: block size ${inserted.length} not in 3..6`);
      }
    }

    inserted.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) errors.push(`line not comment: ${JSON.stringify(line)}`);
      if (line.includes("*/")) errors.push(`line contains */: ${JSON.stringify(line)}`);
      const body = trimmed.slice(2).trimStart();
      if (body.length > 0) {
        const first = body.split(/[\s:：,，。;；]/)[0];
        if (BANNED_PREFIX.includes(first)) errors.push(`banned prefix ${first}: ${JSON.stringify(line)}`);
      }
      if (trimmed.endsWith(";")) errors.push(`line ends with semicolon: ${JSON.stringify(line)}`);
      if (line.includes("=>")) errors.push(`line contains arrow: ${JSON.stringify(line)}`);
      if (CALL_RE.test(line)) {
        const m = line.match(CALL_RE);
        errors.push(`line looks like call expression (${m[0]}): ${JSON.stringify(line)}`);
      }
    });

    total += inserted.length;
  });
}

if (total !== EXPECTED_TOTAL) errors.push(`total inserted lines ${total} !== ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}

console.log(`OK blocks=${spec.files[0].items.length} lines=${total}`);
