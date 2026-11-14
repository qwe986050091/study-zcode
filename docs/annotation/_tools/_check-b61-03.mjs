import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b61-spec-03.json";
const TARGET = "d:/code/ZCode/apps/zcode-cli/packages/core/src/session-context/read-session-context.ts";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const srcLines = readFileSync(TARGET, "utf8").split(/\r?\n/).map((l) => l.trim());

let total = 0;
let fail = 0;
const errs = [];

const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

for (const file of spec.files) {
  if (file.file !== "apps/zcode-cli/packages/core/src/session-context/read-session-context.ts") {
    errs.push(`unexpected file path: ${file.file}`);
  }
  console.log(`items: ${file.items.length}`);
  for (const [i, item] of file.items.entries()) {
    const anchor = item.anchor;
    const hits = srcLines.reduce((acc, l, idx) => (l === anchor.trim() ? [...acc, idx] : acc), []);
    if (hits.length === 0) {
      errs.push(`[item ${i}] anchor not found: ${JSON.stringify(anchor)}`);
    } else if (item.nth === undefined) {
      if (hits.length !== 1) errs.push(`[item ${i}] anchor duplicated ${hits.length}x, need nth: ${JSON.stringify(anchor)}`);
    } else {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errs.push(`[item ${i}] nth ${item.nth} out of range (${hits.length}) for ${JSON.stringify(anchor)}`);
      }
    }

    const n = item.raw ? item.raw.length : item.lines.length;
    total += n;

    const comments = item.raw ?? item.lines.map((l) => "// " + l);
    for (const c of comments) {
      if (!c.startsWith("//")) errs.push(`[item ${i}] not a comment line: ${JSON.stringify(c)}`);
      if (c.includes("*/")) errs.push(`[item ${i}] contains */: ${JSON.stringify(c)}`);
      const body = c.replace(/^\/\/\s?/, "").trim();
      if (body === "") continue;
      if (body.endsWith(";")) errs.push(`[item ${i}] ends with ;: ${JSON.stringify(body)}`);
      if (body.includes("=>")) errs.push(`[item ${i}] contains =>: ${JSON.stringify(body)}`);
      const first = body.split(/\s+/)[0];
      if (BANNED.includes(first)) errs.push(`[item ${i}] banned starter ${first}: ${JSON.stringify(body)}`);
      if (/[\p{L}\p{N}_$)]\s*\.\s*[\p{L}_$][\p{L}\p{N}_$]*\s*\(/u.test(body)) {
        errs.push(`[item ${i}] looks like identifier.method( call: ${JSON.stringify(body)}`);
      }
    }
  }
}

const invCount = (spec.files[0].items[0].raw ?? []).filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
console.log(`INV lines: ${invCount}`);
if (invCount < 18 || invCount > 20) errs.push(`INV count ${invCount} not in 18..20`);

console.log(`total lines: ${total}`);
if (total < 71 || total > 73) errs.push(`total ${total} not in 71..73`);
if (total !== 71) errs.push(`total ${total} != 71`);

console.log(`header is first item raw: ${Boolean(spec.files[0].items[0].raw)}`);
if (!spec.files[0].items[0].raw) errs.push("first item is not raw");
if (spec.files[0].items[0].anchor !== "import {") errs.push("first item anchor is not first import");

if (errs.length > 0) {
  fail = errs.length;
  console.log("FAIL");
  for (const e of errs) console.log(" - " + e);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
console.log(fail === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${fail}`);
