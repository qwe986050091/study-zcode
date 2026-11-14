import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b61-spec-12.json";
const TARGET = "d:/code/ZCode/packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split("\n");
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
    const rows = item.raw ?? item.lines;
    if (!rows) {
      errors.push(`item missing raw/lines: ${item.anchor}`);
      continue;
    }
    total += rows.length;

    // anchor match
    const anchor = item.anchor;
    const hits = [];
    trimmed.forEach((t, i) => {
      if (t === anchor.trim()) hits.push(i + 1);
    });
    const nth = item.nth ?? 1;
    if (hits.length === 0) {
      errors.push(`anchor NOT FOUND: ${anchor}`);
    } else if (item.nth !== undefined) {
      if (hits.length < nth) errors.push(`nth ${nth} > hits ${hits.length}: ${anchor}`);
    } else if (hits.length !== 1) {
      errors.push(`anchor NOT UNIQUE (${hits.length} hits at ${hits.join(",")}): ${anchor}`);
    }

    // comment content checks
    const isRaw = Array.isArray(item.raw);
    for (const raw of rows) {
      let text;
      if (isRaw) {
        if (raw === "//") text = "";
        else if (raw.startsWith("// ")) text = raw.slice(3);
        else {
          errors.push(`raw line not a // comment: ${raw}`);
          continue;
        }
      } else {
        if (raw === "") {
          text = "";
        } else if (raw.startsWith("//")) {
          errors.push(`normal line already has //: ${raw}`);
          continue;
        } else {
          text = raw;
        }
      }
      if (raw.includes("*/")) errors.push(`contains */: ${raw}`);
      if (text.includes(";")) errors.push(`contains ;: ${raw}`);
      if (text.includes("=>")) errors.push(`contains =>: ${raw}`);
      if (/[\w$]\.[\w$]+\(/.test(text)) errors.push(`call-shape pattern: ${raw}`);
      const first = text.trim().split(/\s+/)[0] ?? "";
      if (FORBIDDEN_START.includes(first)) errors.push(`forbidden start "${first}": ${raw}`);
    }
  }
}

const invCount = spec.files[0].items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;

console.log(`items=${itemCount} total=${total} inv=${invCount}`);
if (errors.length) {
  console.log(`FAIL (${errors.length})`);
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
