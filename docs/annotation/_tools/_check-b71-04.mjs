import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b71-spec-04.json";
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const entry = spec.files[0];
const targetPath = "d:/code/ZCode/" + entry.file;
const rawText = readFileSync(targetPath, "utf8");
const srcLines = rawText.split(/\r?\n/);

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const usedIndexes = new Set();
let totalLines = 0;
let blockCount = 0;

const resolveIndex = (anchor, nth) => {
  const hits = [];
  for (let i = 0; i < srcLines.length; i += 1) {
    if (srcLines[i].trim() === anchor.trim()) hits.push(i);
  }
  if (hits.length === 0) return { error: `anchor not found: ${JSON.stringify(anchor)}` };
  if (nth != null) {
    if (nth < 1 || nth > hits.length) {
      return { error: `nth out of range (${nth}) for anchor ${JSON.stringify(anchor)}, hits=${hits.length}` };
    }
    if (hits.length > 1) {
      // nth 指定即可,但报告一下避免歧义
    }
    return { index: hits[nth - 1] };
  }
  if (hits.length !== 1) {
    return { error: `anchor not unique: ${JSON.stringify(anchor)} hits=${hits.length}` };
  }
  return { index: hits[0] };
};

for (const item of entry.items) {
  blockCount += 1;
  const resolved = resolveIndex(item.anchor, item.nth);
  if (resolved.error) {
    errors.push(resolved.error);
    continue;
  }
  const at = resolved.index;
  if (usedIndexes.has(at)) errors.push(`duplicate insert index ${at} for anchor ${JSON.stringify(item.anchor)}`);
  usedIndexes.add(at);

  const indent = (srcLines[at].match(/^\s*/) ?? [""])[0];
  let inserted = [];
  if (Array.isArray(item.raw)) {
    inserted = item.raw.slice();
  } else if (Array.isArray(item.lines)) {
    inserted = item.lines.map((line) => (line === "" ? `${indent}//` : `${indent}// ${line}`));
  } else {
    errors.push(`item has neither raw nor lines: ${JSON.stringify(item.anchor)}`);
    continue;
  }
  totalLines += inserted.length;
  if (inserted.length < 3 || inserted.length > 6) {
    if (!(blockCount === 1 && inserted.length === 22)) {
      errors.push(`block size ${inserted.length} out of 3..6 for anchor ${JSON.stringify(item.anchor)}`);
    }
  }

  for (const line of inserted) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) {
      errors.push(`not a comment: ${JSON.stringify(line)}`);
      continue;
    }
    if (trimmed.includes("*/")) errors.push(`contains */: ${JSON.stringify(line)}`);
    const body = trimmed.slice(2).trim();
    if (body) {
      const first = body.split(/\s+/)[0];
      if (BANNED_START.includes(first)) {
        errors.push(`banned leading word "${first}": ${JSON.stringify(line)}`);
      }
      if (/[;；]$/.test(body)) errors.push(`ends with semicolon: ${JSON.stringify(line)}`);
      if (body.includes("=>")) errors.push(`contains arrow: ${JSON.stringify(line)}`);
      if (CALL_RE.test(body)) errors.push(`contains call expression: ${JSON.stringify(line)}`);
    }
  }
}

const header = entry.items[0].raw ?? [];
if (header.length !== 22) errors.push(`header raw length ${header.length} !== 22`);
if (!header[0] || !header[0].startsWith("// INV-01")) errors.push("header first line must start with // INV-01");
if (header[18] !== "//") errors.push(`header line 19 is ${JSON.stringify(header[18])} !== "//"`);

if (totalLines !== 61) errors.push(`total inserted lines ${totalLines} !== 61`);

if (errors.length > 0) {
  console.log(`FAIL blocks=${blockCount} lines=${totalLines}`);
  for (const error of errors) console.log("- " + error);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalLines}`);
