import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = "d:\\code";
const specPath = path.join(ROOT, "_annot_baseline", "ZC-deep-b71-spec-05.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const FORBIDDEN = [
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
const CALL_RE = /[A-Za-z0-9_$]\.[A-Za-z0-9_$]+\s*\(/;

let totalLines = 0;
let blockCount = 0;
const problems = [];

for (const entry of spec.files) {
  const filePath = path.join(ROOT, "ZCode", entry.file);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  const insertions = [];
  entry.items.forEach((item, itemIndex) => {
    blockCount += 1;
    const anchor = String(item.anchor ?? "").trim();
    if (!anchor) {
      problems.push(`item ${itemIndex}: empty anchor`);
      return;
    }
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === anchor) hits.push(i);
    }
    const nth = item.nth ?? 1;
    if (hits.length === 0) {
      problems.push(`item ${itemIndex}: anchor not found -> ${anchor}`);
      return;
    }
    if (nth > hits.length) {
      problems.push(`item ${itemIndex}: nth ${nth} exceeds hits ${hits.length} -> ${anchor}`);
      return;
    }
    if (hits.length > 1 && !item.nth) {
      problems.push(`item ${itemIndex}: anchor not unique (${hits.length}) -> ${anchor}`);
      return;
    }
    const insertAt = hits[nth - 1];

    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (hasRaw === hasLines) {
      problems.push(`item ${itemIndex}: must have exactly one of raw/lines`);
      return;
    }

    let rendered;
    if (hasRaw) {
      rendered = item.raw.slice();
    } else {
      const indentMatch = /^[ \t]*/.exec(lines[insertAt]);
      const indent = indentMatch ? indentMatch[0] : "";
      rendered = item.lines.map((text) =>
        String(text).length === 0 ? `${indent}//` : `${indent}// ${text}`,
      );
    }

    insertions.push({ itemIndex, insertAt, rendered });

    for (const out of rendered) {
      const trimmed = out.trim();
      totalLines += 1;
      if (!trimmed.startsWith("//")) {
        problems.push(`item ${itemIndex}: inserted line not comment -> ${trimmed}`);
        continue;
      }
      if (trimmed.includes("*/")) {
        problems.push(`item ${itemIndex}: contains */ -> ${trimmed}`);
      }
      const body = trimmed.slice(2).trim();
      const first = body.split(/\s+/)[0] ?? "";
      if (FORBIDDEN.includes(first)) {
        problems.push(`item ${itemIndex}: forbidden leading word "${first}" -> ${trimmed}`);
      }
      if (body.endsWith(";")) {
        problems.push(`item ${itemIndex}: body ends with ; -> ${trimmed}`);
      }
      if (body.includes("=>")) {
        problems.push(`item ${itemIndex}: contains => -> ${trimmed}`);
      }
      if (CALL_RE.test(body)) {
        problems.push(`item ${itemIndex}: looks like dotted call -> ${trimmed}`);
      }
    }
  });

  const seen = new Map();
  for (const ins of insertions) {
    if (seen.has(ins.insertAt)) {
      problems.push(
        `duplicate insert index ${ins.insertAt} at items ${seen.get(ins.insertAt)} and ${ins.itemIndex}`,
      );
    }
    seen.set(ins.insertAt, ins.itemIndex);
  }

  const header = entry.items[0];
  if (!Array.isArray(header.raw)) {
    problems.push("header item must use raw");
  } else {
    if (header.raw.length !== 22) {
      problems.push(`header raw length ${header.raw.length} !== 22`);
    }
    if (!String(header.raw[0]).startsWith("// INV-01")) {
      problems.push("header first line must start with // INV-01");
    }
    if (String(header.raw[18]).trim() !== "//") {
      problems.push(`header line 19 must be //, got "${header.raw[18]}"`);
    }
  }
}

if (totalLines !== 62) {
  problems.push(`total inserted lines ${totalLines} !== 62`);
}

if (problems.length > 0) {
  console.error("FAIL");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
