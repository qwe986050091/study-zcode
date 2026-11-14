import fs from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b72-spec-11.json";
const TARGET = "d:/code/ZCode/packages/shared/src/tool-call-summary.ts";
const EXPECTED = 61;

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const srcLines = fs.readFileSync(TARGET, "utf8").split(/\r?\n/);

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;
const errors = [];
let total = 0;
let blockCount = 0;

for (const file of spec.files) {
  if (file.file !== "packages/shared/src/tool-call-summary.ts") {
    errors.push(`unexpected file: ${file.file}`);
  }
  const usedIndices = new Set();
  for (let i = 0; i < file.items.length; i++) {
    const item = file.items[i];
    const anchorTrim = String(item.anchor).trim();
    const hits = [];
    srcLines.forEach((line, idx) => {
      if (line.trim() === anchorTrim) hits.push(idx);
    });
    let index;
    if (Object.prototype.hasOwnProperty.call(item, "nth")) {
      const n = item.nth;
      if (!Number.isInteger(n) || n < 1 || n > hits.length) {
        errors.push(`item ${i}: nth ${n} invalid (hits=${hits.length})`);
        continue;
      }
      index = hits[n - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`item ${i}: anchor not unique, hits=${hits.length}: ${anchorTrim}`);
        continue;
      }
      index = hits[0];
    }
    if (usedIndices.has(index)) {
      errors.push(`item ${i}: duplicate insertion index ${index}`);
    }
    usedIndices.add(index);

    const indentMatch = srcLines[index].match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.map((line) => indent + line);
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((line) => indent + (line === "" ? "//" : `// ${line}`));
    } else {
      errors.push(`item ${i}: lacks raw/lines`);
      continue;
    }

    total += inserted.length;
    blockCount++;

    inserted.forEach((line, j) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) {
        errors.push(`item ${i} line ${j}: does not start with //: ${trimmed}`);
        return;
      }
      if (trimmed.includes("*/")) {
        errors.push(`item ${i} line ${j}: contains */`);
      }
      if (trimmed.endsWith(";")) {
        errors.push(`item ${i} line ${j}: ends with ;`);
      }
      if (trimmed.includes("=>")) {
        errors.push(`item ${i} line ${j}: contains =>`);
      }
      if (CALL_RE.test(trimmed)) {
        errors.push(`item ${i} line ${j}: looks like call expression`);
      }
      const body = trimmed.replace(/^\/\/\s*/, "").trim();
      if (body) {
        const first = body.split(/\s+/)[0];
        if (FORBIDDEN.includes(first)) {
          errors.push(`item ${i} line ${j}: starts with forbidden word ${first}`);
        }
      }
    });
  }

  const header = file.items[0];
  if (!header || !Array.isArray(header.raw)) {
    errors.push("header item missing raw");
  } else {
    if (header.raw.length !== 22) {
      errors.push(`header raw length ${header.raw.length} !== 22`);
    }
    if (!String(header.raw[0]).trim().startsWith("// INV-01")) {
      errors.push("header first line does not start with // INV-01");
    }
    if (String(header.raw[18]).trim() !== "//") {
      errors.push(`header line 19 is not //: ${header.raw[18]}`);
    }
  }
}

if (total !== EXPECTED) {
  errors.push(`total inserted lines ${total} !== ${EXPECTED}`);
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error("- " + e);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${total}`);
