import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-08.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const rel = "packages/ui/src/components/ui/dropdown-menu.tsx";
const target = "d:/code/ZCode/" + rel;
const srcLines = fs.readFileSync(target, "utf8").split(/\r?\n/);

const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let errors = [];
let total = 0;
const anchors = [];

for (const f of spec.files) {
  if (f.file !== rel) errors.push(`unexpected file ${f.file}`);
  let prevIndex = -1;
  for (const item of f.items) {
    const anchor = item.anchor;
    const matches = srcLines
      .map((l, i) => (l.trim() === anchor ? i : -1))
      .filter((i) => i >= 0);
    const nth = item.nth ?? 1;
    anchors.push({ anchor, count: matches.length, nth: item.nth ?? null });
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
      if (/^[A-Za-z_$][\w$]*\.[\w$]*\(/.test(line)) errors.push(`call-like form: ${line}`);
      const content = item.raw
        ? line.replace(/^\/\/\s?/, "").trimStart()
        : line.trimStart();
      const first = content.split(/\s+/)[0] ?? "";
      if (banned.includes(first)) errors.push(`banned start word "${first}": ${line}`);
    }
  }
}

const headerItem = spec.files[0].items[0];
const header = headerItem.raw ?? [];
const invCount = header.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) errors.push(`INV count out of range: ${invCount}`);
if (header[header.length - 1] !== "//") errors.push(`header tail not //: ${header[header.length - 1]}`);
if (!headerItem.anchor.startsWith("import ")) errors.push("header anchor is not the first import");

const dupAnchors = anchors.filter((a) => a.count > 1);
const items = spec.files[0].items;

console.log(JSON.stringify({
  items: items.length,
  total,
  invCount,
  headerLines: header.length,
  itemLines: items.map((it, i) => ({ i, n: (it.raw ?? it.lines).length, anchor: it.anchor.slice(0, 46) })),
  duplicateAnchors: dupAnchors,
  errors,
}, null, 2));
