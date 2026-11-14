import fs from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b71-spec-02.json";
const TARGET = "d:/code/ZCode/packages/ui/src/presentation/pptxRendererPreviewEngine.ts";

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const text = fs.readFileSync(TARGET, "utf8");
const lines = text.split(/\r?\n/);

const errors = [];

const forbiddenWords = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "await",
  "async",
  "throw",
  "new",
  "interface",
  "type",
  "enum",
];

const callExpr = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let total = 0;
let blockCount = 0;
const usedIndices = new Map();

for (const fileEntry of spec.files) {
  for (const item of fileEntry.items) {
    blockCount += 1;
    const anchor = String(item.anchor);
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === anchor.trim()) {
        hits.push(i);
      }
    }
    if (hits.length === 0) {
      errors.push(`anchor not found: ${anchor}`);
      continue;
    }
    let index;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`bad nth for anchor: ${anchor} (hits=${hits.length}, nth=${item.nth})`);
        continue;
      }
      index = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`anchor not unique: ${anchor} (hits=${hits.length})`);
        continue;
      }
      index = hits[0];
    }
    if (usedIndices.has(index)) {
      errors.push(`duplicate insertion index ${index} for anchor: ${anchor}`);
      continue;
    }

    const rendered = [];
    if (Array.isArray(item.raw)) {
      for (const rawLine of item.raw) {
        rendered.push(rawLine);
      }
    } else if (Array.isArray(item.lines)) {
      const indent = (lines[index].match(/^[ \t]*/) ?? [""])[0];
      for (const line of item.lines) {
        rendered.push(line === "" ? `${indent}//` : `${indent}// ${line}`);
      }
    } else {
      errors.push(`item has neither raw nor lines: ${anchor}`);
      continue;
    }

    usedIndices.set(index, { anchor, rendered });

    for (const renderedLine of rendered) {
      total += 1;
      const trimmed = renderedLine.trim();
      if (!trimmed.startsWith("//")) {
        errors.push(`not a whole-line comment: ${JSON.stringify(renderedLine)}`);
      }
      if (renderedLine.includes("*/")) {
        errors.push(`contains block-comment terminator: ${JSON.stringify(renderedLine)}`);
      }
      if (trimmed.endsWith(";")) {
        errors.push(`ends with semicolon: ${JSON.stringify(trimmed)}`);
      }
      if (trimmed.includes("=>")) {
        errors.push(`contains arrow: ${JSON.stringify(trimmed)}`);
      }
      if (callExpr.test(trimmed)) {
        errors.push(`looks like a call expression: ${JSON.stringify(trimmed)}`);
      }
      const body = trimmed.replace(/^\/\/\s?/, "");
      const firstWord = (body.match(/^[A-Za-z_$][\w$]*/) ?? [""])[0];
      if (firstWord && forbiddenWords.includes(firstWord)) {
        errors.push(`starts with forbidden word "${firstWord}": ${JSON.stringify(trimmed)}`);
      }
    }

    if (item === fileEntry.items[0] && Array.isArray(item.raw)) {
      if (item.raw.length !== 22) {
        errors.push(`header raw length must be 22, got ${item.raw.length}`);
      }
      if (!String(item.raw[0]).startsWith("// INV-01")) {
        errors.push("header raw[0] must start with // INV-01");
      }
      if (item.raw[18] !== "//") {
        errors.push(`header raw[18] must be "//", got ${JSON.stringify(item.raw[18])}`);
      }
    }
  }
}

if (total !== 61) {
  errors.push(`total inserted lines must be 61, got ${total}`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${total}`);
