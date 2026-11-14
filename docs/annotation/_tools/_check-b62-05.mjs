import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b62-spec-05.json";
const srcPath = "d:/code/ZCode/packages/ui/src/store/commandsStore.ts";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const srcLines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/).map((l) => l.trim());

const bannedStart = [
  "const", "let", "var", "function", "class", "import", "export", "return", "if", "else",
  "for", "while", "switch", "try", "catch", "await", "async", "throw", "new", "interface",
  "type", "enum",
];

const errors = [];
let total = 0;
let itemCount = 0;
let rawCount = 0;

const fileEntry = spec.files[0];
if (fileEntry.file !== "packages/ui/src/store/commandsStore.ts") {
  errors.push("file path mismatch");
}

fileEntry.items.forEach((item, idx) => {
  itemCount += 1;
  const lines = item.raw ?? item.lines;
  if (!lines) errors.push(`item#${idx} missing raw/lines`);
  total += lines.length;

  if ("raw" in item) rawCount += 1;

  const anchor = item.anchor;
  if (typeof anchor !== "string" || anchor.trim() !== anchor) {
    errors.push(`item#${idx} anchor not trimmed: ${JSON.stringify(anchor)}`);
  }
  const hits = srcLines.filter((l) => l === anchor).length;
  const nth = item.nth ?? 1;
  if (hits === 0) errors.push(`item#${idx} anchor not found: ${anchor}`);
  if (hits > 1 && item.nth === undefined) errors.push(`item#${idx} anchor duplicated (${hits}x) without nth: ${anchor}`);
  if (nth > hits) errors.push(`item#${idx} nth=${nth} exceeds hits=${hits}: ${anchor}`);

  lines.forEach((raw, li) => {
    const isRaw = "raw" in item;
    if (isRaw && !raw.trim().startsWith("//")) {
      errors.push(`item#${idx} line#${li} raw not a comment: ${raw}`);
      return;
    }
    const text = isRaw ? raw.trim() : `// ${raw}`;
    if (text.includes("*/")) errors.push(`item#${idx} line#${li} contains */`);
    const body = text.replace(/^\/\/\s?/, "").trim();
    if (body === "") return;
    if (body.endsWith(";")) errors.push(`item#${idx} line#${li} ends with ;`);
    if (/;/g.test(body)) errors.push(`item#${idx} line#${li} contains ascii ;`);
    if (body.includes("=>")) errors.push(`item#${idx} line#${li} contains =>`);
    const first = body.split(/[\s，。、（(]/)[0];
    if (bannedStart.includes(first)) errors.push(`item#${idx} line#${li} banned start: ${first}`);
    if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body)) {
      errors.push(`item#${idx} line#${li} identifier.identifier( shape`);
    }
  });
});

const header = fileEntry.items[0];
const invLines = header.raw.filter((l) => l.startsWith("// INV-"));
if (invLines.length < 18 || invLines.length > 20) errors.push(`INV count = ${invLines.length}`);
const headerTail = header.raw[header.raw.length - 1].trim();
if (headerTail !== "//" && !headerTail.startsWith("// ")) errors.push("header tail invalid");
const blankIdx = header.raw.findIndex((l) => l.trim() === "//");
if (blankIdx < 0) errors.push("header missing // separator");
else {
  const summary = header.raw.length - blankIdx - 1;
  if (summary < 2 || summary > 4) errors.push(`header summary lines = ${summary}`);
}

console.log("items:", itemCount, "raw items:", rawCount, "total lines:", total);
console.log("INV count:", invLines.length);
if (errors.length) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" -", e));
  process.exit(1);
}
console.log("PASS");
