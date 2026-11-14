import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/XC-deep-b58-spec-12.json".replace("XC", "ZC");
const targetPath = "d:/code/ZCode/packages/shared/src/conversation-share-content.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const rawLines = readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = rawLines.map((l) => l.trim());

const file = spec.files[0];
if (file.file !== "packages/shared/src/conversation-share-content.ts") {
  console.error("FAIL file path:", file.file);
}

const forbidden = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let total = 0;
let insertCount = 0;
const errors = [];

for (const item of file.items) {
  const body = item.raw ?? item.lines;
  total += body.length;
  insertCount += 1;

  const hits = trimmed.filter((t) => t === item.anchor).length;
  const nth = item.nth ?? 1;
  if (hits === 0) errors.push(`anchor missing: ${item.anchor}`);
  if (hits > 1 && item.nth === undefined) errors.push(`anchor ambiguous (${hits}): ${item.anchor}`);
  if (item.nth !== undefined && (nth < 1 || nth > hits)) errors.push(`nth out of range: ${item.anchor}`);

  for (const line of body) {
    const isRaw = Array.isArray(item.raw);
    if (!isRaw && !line.startsWith("//")) {
      // lines 由插入器加 //，原文不能自带
    }
    if (line.includes("*/")) errors.push(`contains */: ${line}`);
    if (line.includes("=>")) errors.push(`contains =>: ${line}`);
    if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(line)) {
      errors.push(`call style foo.bar(: ${line}`);
    }
    const bare = line.replace(/^\s*\/\/\s?/, "").trim();
    if (bare.endsWith(";")) errors.push(`ends with ;: ${line}`);
    const first = bare.split(/[\s（(]/)[0];
    if (forbidden.includes(first)) errors.push(`forbidden start "${first}": ${line}`);
  }
}

const header = file.items[0];
const invLines = header.raw.filter((l) => /^\/\/ INV-\d{2} /.test(l)).length;
if (invLines < 18 || invLines > 20) errors.push(`INV count = ${invLines}`);

console.log("anchors(items):", insertCount);
console.log("total comment lines:", total, "(target 73, allowed 73-75)");
console.log("INV lines:", invLines);
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "ALL CHECKS PASSED");
process.exitCode = errors.length || total < 73 || total > 75 ? 1 : 0;
