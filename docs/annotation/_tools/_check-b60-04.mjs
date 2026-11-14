import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-04.json";
const targetPath = "d:/code/ZCode/packages/desktop/src/renderer/src/main.tsx";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const srcLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errors = [];
let total = 0;
let itemCount = 0;

for (const file of spec.files) {
  for (const item of file.items) {
    itemCount += 1;
    const anchor = item.anchor;
    const isRaw = Array.isArray(item.raw);
    const out = isRaw ? item.raw : item.lines;

    if (!Array.isArray(out)) {
      errors.push(`item missing raw/lines: ${anchor}`);
      continue;
    }
    total += out.length;

    const hits = [];
    trimmed.forEach((l, i) => {
      if (l === anchor.trim()) hits.push(i + 1);
    });
    if (hits.length === 0) {
      errors.push(`anchor not found: ${JSON.stringify(anchor)}`);
    } else if (hits.length > 1) {
      const nth = item.nth;
      if (!nth) {
        errors.push(`anchor duplicated (${hits.length}) without nth: ${JSON.stringify(anchor)}`);
      } else if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
        errors.push(`bad nth=${nth} for ${JSON.stringify(anchor)} (hits=${hits.length})`);
      }
    } else if (item.nth && item.nth !== 1) {
      errors.push(`nth=${item.nth} but anchor unique: ${JSON.stringify(anchor)}`);
    }

    out.forEach((line, idx) => {
      if (isRaw) {
        if (!line.startsWith("//")) {
          errors.push(`raw line not starting with //: ${JSON.stringify(line)}`);
          return;
        }
        if (line.includes("*/")) errors.push(`raw contains */: ${JSON.stringify(line)}`);
        return;
      }
      if (line === "") return;
      const body = line.replace(/^\/+/, "").trimStart();
      if (body.includes("*/")) errors.push(`comment contains */: ${JSON.stringify(line)}`);
      if (body.endsWith(";")) errors.push(`comment ends with ;: ${JSON.stringify(line)}`);
      if (body.includes("=>")) errors.push(`comment contains =>: ${JSON.stringify(line)}`);
      const firstToken = body.match(/^[A-Za-z]+/);
      if (firstToken && FORBIDDEN_START.includes(firstToken[0])) {
        errors.push(`comment starts with forbidden word "${firstToken[0]}": ${JSON.stringify(line)}`);
      }
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body)) {
        errors.push(`comment has dotted call form: ${JSON.stringify(line)}`);
      }
    });
  }
}

const invCount = spec.files[0].items[0].raw.filter((l) => l.startsWith("// INV-")).length;
console.log(`items=${itemCount} totalLines=${total} invCount=${invCount}`);
if (invCount < 18 || invCount > 20) errors.push(`INV count out of range: ${invCount}`);
if (total !== 73) errors.push(`total lines expected 73, got ${total}`);

if (errors.length) {
  console.log("FAIL");
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
