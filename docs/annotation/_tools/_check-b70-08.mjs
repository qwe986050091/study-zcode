import fs from "node:fs";
import path from "node:path";

const repoRoot = "d:\\code\\ZCode";
const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b70-spec-08.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let problems = [];
let totalInserted = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const filePath = path.join(repoRoot, entry.file);
  const rawFile = fs.readFileSync(filePath, "utf8");
  const lines = rawFile.split(/\r?\n/);
  const trimmed = lines.map((l) => l.trim());

  const insertions = [];

  entry.items.forEach((item, itemIdx) => {
    blockCount += 1;

    // ---- locate anchor ----
    const hits = [];
    trimmed.forEach((t, i) => {
      if (t === item.anchor.trim()) hits.push(i);
    });
    if (hits.length === 0) {
      problems.push(`[item ${itemIdx}] anchor not found: ${JSON.stringify(item.anchor)}`);
      return;
    }
    let anchorLineIdx;
    if (item.nth != null) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        problems.push(`[item ${itemIdx}] nth=${item.nth} invalid (hits=${hits.length})`);
        return;
      }
      anchorLineIdx = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        problems.push(`[item ${itemIdx}] anchor not unique (hits=${hits.length}): ${JSON.stringify(item.anchor)}`);
        return;
      }
      anchorLineIdx = hits[0];
    }

    // ---- build inserted lines ----
    let newLines = [];
    if (Array.isArray(item.raw)) {
      newLines = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      const indentMatch = lines[anchorLineIdx].match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0] : "";
      newLines = item.lines.map((t) => (t === "" ? indent + "//" : indent + "// " + t));
    } else {
      problems.push(`[item ${itemIdx}] has neither raw nor lines`);
      return;
    }

    // ---- per-line checks ----
    newLines.forEach((l, j) => {
      const t = l.trim();
      if (!t.startsWith("//")) problems.push(`[item ${itemIdx} line ${j}] not a comment: ${JSON.stringify(l)}`);
      if (l.includes("*/")) problems.push(`[item ${itemIdx} line ${j}] contains */: ${JSON.stringify(l)}`);
      if (/;\s*$/.test(t)) problems.push(`[item ${itemIdx} line ${j}] ends with semicolon: ${JSON.stringify(t)}`);
      if (t.includes("=>")) problems.push(`[item ${itemIdx} line ${j}] contains arrow: ${JSON.stringify(t)}`);
      if (CALL_RE.test(t)) problems.push(`[item ${itemIdx} line ${j}] contains call expression: ${JSON.stringify(t)}`);
      const body = t.replace(/^\/\/\s?/, "").trim();
      const first = body.split(/[\s（(:：,，]/)[0];
      if (FORBIDDEN.includes(first)) {
        problems.push(`[item ${itemIdx} line ${j}] forbidden leading word '${first}': ${JSON.stringify(t)}`);
      }
    });

    // ---- header-specific checks ----
    if (itemIdx === 0) {
      if (!Array.isArray(item.raw)) problems.push("[header] header item must use raw");
      if (newLines.length !== 22) problems.push(`[header] raw length ${newLines.length} !== 22`);
      if (!newLines[0] || !newLines[0].startsWith("// INV-01")) {
        problems.push(`[header] first line must start with // INV-01: ${JSON.stringify(newLines[0])}`);
      }
      if (newLines[18] !== "//") problems.push(`[header] line 19 must be exactly "//": ${JSON.stringify(newLines[18])}`);
      for (let k = 0; k < 18; k += 1) {
        const expected = `// INV-${String(k + 1).padStart(2, "0")} `;
        if (!newLines[k] || !newLines[k].startsWith(expected)) {
          problems.push(`[header] line ${k + 1} must start with ${JSON.stringify(expected)}`);
        }
      }
      if (newLines.some((l) => /^[ \t]/.test(l))) problems.push("[header] raw lines must not be indented");
    }

    totalInserted += newLines.length;
    insertions.push({ itemIdx, anchorLineIdx, newLines });
  });

  // ---- no duplicate insertion index ----
  const seen = new Map();
  insertions.forEach((ins) => {
    if (seen.has(ins.anchorLineIdx)) {
      problems.push(`duplicate insertion index ${ins.anchorLineIdx} for items ${seen.get(ins.anchorLineIdx)} and ${ins.itemIdx}`);
    } else {
      seen.set(ins.anchorLineIdx, ins.itemIdx);
    }
  });
}

if (totalInserted !== 63) problems.push(`total inserted lines ${totalInserted} !== 63`);

if (problems.length > 0) {
  console.log("FAIL");
  problems.forEach((p) => console.log(" - " + p));
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
