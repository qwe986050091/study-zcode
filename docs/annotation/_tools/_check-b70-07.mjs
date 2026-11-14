import fs from "node:fs";
import path from "node:path";

const specPath = "d:/code/_annot_baseline/ZC-deep-b70-spec-07.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const repoRoot = "d:/code/ZCode";

const forbidden = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);

const errors = [];
let totalInserted = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const filePath = path.join(repoRoot, entry.file);
  const src = fs.readFileSync(filePath, "utf8");
  const lines = src.split(/\r?\n/);

  const usedIndexes = new Map();

  entry.items.forEach((item, itemIdx) => {
    const anchorTrim = item.anchor.trim();
    const hits = [];
    lines.forEach((line, i) => {
      if (line.trim() === anchorTrim) hits.push(i);
    });

    if (hits.length === 0) {
      errors.push(`[${itemIdx}] anchor not found: ${item.anchor}`);
      return;
    }
    let pos;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`[${itemIdx}] nth out of range: ${item.nth} (hits=${hits.length})`);
        return;
      }
      pos = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`[${itemIdx}] anchor not unique (hits=${hits.length}): ${item.anchor}`);
        return;
      }
      pos = hits[0];
    }

    if (usedIndexes.has(pos)) {
      errors.push(`[${itemIdx}] duplicate insertion index ${pos}`);
      return;
    }
    usedIndexes.set(pos, itemIdx);

    const indent = (lines[pos].match(/^[ \t]*/) || [""])[0];
    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.slice();
      if (inserted.some((l) => /^[ \t]/.test(l))) {
        errors.push(`[${itemIdx}] raw lines must not be indented`);
      }
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`));
    } else {
      errors.push(`[${itemIdx}] item has neither raw nor lines`);
      return;
    }

    blockCount += 1;
    totalInserted += inserted.length;

    if (inserted.length < 3 || inserted.length > 6) {
      if (!(itemIdx === 0 && inserted.length === 22)) {
        errors.push(`[${itemIdx}] block size ${inserted.length} outside 3..6`);
      }
    }

    inserted.forEach((rawLine, k) => {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith("//")) {
        errors.push(`[${itemIdx}:${k}] does not start with //: ${rawLine}`);
        return;
      }
      if (trimmed.includes("*/")) {
        errors.push(`[${itemIdx}:${k}] contains */: ${rawLine}`);
      }
      const text = trimmed.replace(/^\/\//, "").trim();
      if (text.length > 0) {
        if (text.endsWith(";")) {
          errors.push(`[${itemIdx}:${k}] ends with ;: ${rawLine}`);
        }
        if (text.includes("=>")) {
          errors.push(`[${itemIdx}:${k}] contains =>: ${rawLine}`);
        }
        const firstWord = text.split(/[\s:：,，、]/)[0];
        if (forbidden.has(firstWord)) {
          errors.push(`[${itemIdx}:${k}] forbidden leading word "${firstWord}": ${rawLine}`);
        }
        if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(text)) {
          errors.push(`[${itemIdx}:${k}] looks like a call expression: ${rawLine}`);
        }
      }
    });

    if (itemIdx === 0) {
      const raw = item.raw || [];
      if (raw.length !== 22) {
        errors.push(`header raw length ${raw.length} !== 22`);
      }
      if (!String(raw[0] || "").startsWith("// INV-01")) {
        errors.push(`header first line not // INV-01: ${raw[0]}`);
      }
      if (raw[18] !== "//") {
        errors.push(`header 19th line not "//": ${raw[18]}`);
      }
    }
  });

  lines.forEach((line, i) => {
    if (line.trim().startsWith("// INV-") || line.includes("// 模块职责：")) {
      errors.push(`source already contains annotation line ${i + 1}: ${line}`);
    }
  });
}

if (totalInserted !== 62) {
  errors.push(`total inserted ${totalInserted} !== 62`);
}

if (errors.length > 0) {
  console.error("FAIL");
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}

console.log("OK blocks=" + blockCount + " lines=" + totalInserted);
