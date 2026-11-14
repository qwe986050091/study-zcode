import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-06.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const target = "d:/code/ZCode/packages/desktop/src/host/windowHostSessionsIndexObserver.ts";
const srcLines = fs.readFileSync(target, "utf8").split(/\r?\n/);

const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let errors = [];
let total = 0;

for (const f of spec.files) {
  if (f.file !== "packages/desktop/src/host/windowHostSessionsIndexObserver.ts") {
    errors.push(`unexpected file ${f.file}`);
  }
  let prevIndex = -1;
  for (const item of f.items) {
    const anchor = item.anchor;
    const matches = srcLines
      .map((l, i) => (l.trim() === anchor ? i : -1))
      .filter((i) => i >= 0);
    const nth = item.nth ?? 1;
    if (matches.length === 0) errors.push(`anchor missing: ${anchor}`);
    if (matches.length > 1 && !item.nth) errors.push(`anchor duplicated without nth (${matches.length}): ${anchor}`);
    if (item.nth && nth > matches.length) errors.push(`nth out of range: ${anchor}`);
    const pos = matches[nth - 1];
    if (pos !== undefined) {
      if (pos <= prevIndex) errors.push(`anchor order not increasing: ${anchor}`);
      prevIndex = pos;
    }

    const body = item.raw ?? item.lines;
    if (!Array.isArray(body) || body.length === 0) errors.push(`empty body: ${anchor}`);
    total += body.length;

    for (const line of body) {
      if (line.includes("*/")) errors.push(`contains */: ${line}`);
      if (line.includes("=>")) errors.push(`contains =>: ${line}`);
      if (line.trimEnd().endsWith(";")) errors.push(`ends with ;: ${line}`);
      const content = item.raw
        ? line.replace(/^\/\/\s?/, "").trimStart()
        : line.trimStart();
      const first = content.split(/\s+/)[0] ?? "";
      if (banned.includes(first)) errors.push(`banned start word "${first}": ${line}`);
    }
  }
}

const headerItem = spec.files[0].items[0];
const invCount = (headerItem.raw ?? []).filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) errors.push(`INV count out of range: ${invCount}`);

console.log(JSON.stringify({
  items: spec.files[0].items.length,
  total,
  invCount,
  firstAnchorIsImport: headerItem.anchor.startsWith("import "),
  headerTail: headerItem.raw[headerItem.raw.length - 1],
  errors,
}, null, 2));
