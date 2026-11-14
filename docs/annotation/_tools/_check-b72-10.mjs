import fs from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b72-spec-10.json";
const ROOT = "d:/code/ZCode";
const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

const forbiddenStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let totalLines = 0;
let blockCount = 0;
let headerChecked = false;

for (const entry of spec.files) {
  const abs = `${ROOT}/${entry.file}`;
  if (!fs.existsSync(abs)) fail(`target missing: ${abs}`);
  const srcLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const trimmed = srcLines.map((l) => l.trim());

  const usedIndices = new Set();
  let fileTotal = 0;

  entry.items.forEach((item, itemIdx) => {
    if (typeof item.anchor !== "string" || item.anchor.length === 0) {
      fail(`item ${itemIdx}: empty anchor`);
    }
    const matches = [];
    trimmed.forEach((t, i) => {
      if (t === item.anchor.trim()) matches.push(i);
    });
    let hitIndex;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1) fail(`item ${itemIdx}: bad nth`);
      if (matches.length < item.nth) {
        fail(`item ${itemIdx}: anchor "${item.anchor}" has ${matches.length} matches, nth=${item.nth}`);
      }
      hitIndex = matches[item.nth - 1];
    } else {
      if (matches.length !== 1) {
        fail(`item ${itemIdx}: anchor "${item.anchor}" matched ${matches.length} times (need unique)`);
      }
      hitIndex = matches[0];
    }
    if (trimmed[hitIndex] === "") fail(`item ${itemIdx}: anchor is blank line`);

    if (usedIndices.has(hitIndex)) fail(`item ${itemIdx}: duplicate insert index ${hitIndex}`);
    usedIndices.add(hitIndex);

    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((t) => (t === "" ? "//" : `// ${t}`));
    } else {
      fail(`item ${itemIdx}: neither raw nor lines`);
    }
    if (inserted.length < 1) fail(`item ${itemIdx}: empty insertion`);

    inserted.forEach((line, li) => {
      const t = line.trim();
      if (!t.startsWith("//")) fail(`item ${itemIdx} line ${li}: not a line comment: ${line}`);
      if (t.includes("*/")) fail(`item ${itemIdx} line ${li}: contains */`);
      if (/[\r\n]/.test(line)) fail(`item ${itemIdx} line ${li}: embedded newline`);

      const body = t.slice(2).trim();
      if (body.length > 0) {
        for (const w of forbiddenStart) {
          if (body === w || new RegExp(`^${w}(?![A-Za-z0-9_$])`).test(body)) {
            fail(`item ${itemIdx} line ${li}: body starts with forbidden word "${w}": ${body}`);
          }
        }
        if (body.endsWith(";")) fail(`item ${itemIdx} line ${li}: body ends with ;`);
        if (body.includes("=>")) fail(`item ${itemIdx} line ${li}: body contains =>`);
        if (/\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(body)) {
          fail(`item ${itemIdx} line ${li}: body contains call expression: ${body}`);
        }
      }
    });

    if (item === entry.items[0]) {
      if (!Array.isArray(item.raw)) fail("header: must use raw");
      if (item.raw.length !== 22) fail(`header: raw length ${item.raw.length} !== 22`);
      if (!item.raw[0].trim().startsWith("// INV-01")) fail("header: first line not // INV-01");
      if (item.raw[18].trim() !== "//") fail(`header: 19th line is "${item.raw[18]}" not "//"`);
      headerChecked = true;
    } else if ("raw" in item) {
      fail(`item ${itemIdx}: non-header item must use lines`);
    }

    totalLines += inserted.length;
    fileTotal += inserted.length;
    blockCount += 1;
  });

  console.log(`${entry.file}: blocks=${entry.items.length} inserted=${fileTotal}`);
}

if (!headerChecked) fail("no header item found");
if (totalLines !== 62) fail(`total inserted lines ${totalLines} !== 62`);

console.log("OK");
