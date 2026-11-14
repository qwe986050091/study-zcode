import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b72-spec-09.json";
const targetPath = "d:/code/ZCode/packages/desktop/src/main/applicationIcons.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = readFileSync(targetPath, "utf8");
const sourceLines = source.split(/\r?\n/);

const errors = [];
const fail = (msg) => errors.push(msg);

const FORBIDDEN = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const forbiddenRe = new RegExp("^\\s*(?:" + FORBIDDEN.join("|") + ")\\b");
const callRe = /[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+\s*\(/;

const usedIndexes = new Map();
let totalInserted = 0;
let blockCount = 0;
let headerChecked = false;

for (const fileSpec of spec.files) {
  if (fileSpec.file !== "packages/desktop/src/main/applicationIcons.ts") {
    fail(`unexpected file entry: ${fileSpec.file}`);
  }
  for (const item of fileSpec.items) {
    blockCount += 1;
    const anchorTrim = item.anchor.trim();
    const matches = [];
    sourceLines.forEach((line, idx) => {
      if (line.trim() === anchorTrim) matches.push(idx);
    });
    if (matches.length === 0) {
      fail(`anchor not found: ${JSON.stringify(item.anchor)}`);
      continue;
    }
    let hit;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
        fail(`invalid nth ${item.nth} for anchor ${JSON.stringify(item.anchor)} (hits=${matches.length})`);
        continue;
      }
      hit = matches[item.nth - 1];
    } else {
      if (matches.length !== 1) {
        fail(`anchor not unique (${matches.length} hits): ${JSON.stringify(item.anchor)}`);
        continue;
      }
      hit = matches[0];
    }
    if (usedIndexes.has(hit)) {
      fail(`duplicate insertion index ${hit}: ${JSON.stringify(item.anchor)} and ${JSON.stringify(usedIndexes.get(hit))}`);
      continue;
    }
    usedIndexes.set(hit, item.anchor);

    const indent = (sourceLines[hit].match(/^[ \t]*/) || [""])[0];
    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.map((line) => String(line));
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((line) => (String(line) === "" ? indent + "//" : indent + "// " + String(line)));
      if (inserted.length < 3 || inserted.length > 6) {
        fail(`lines block size ${inserted.length} outside 3..6 at anchor ${JSON.stringify(item.anchor)}`);
      }
    } else {
      fail(`item without raw/lines at anchor ${JSON.stringify(item.anchor)}`);
      continue;
    }

    totalInserted += inserted.length;

    for (const line of inserted) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) {
        fail(`inserted line does not start with //: ${JSON.stringify(line)}`);
        continue;
      }
      if (trimmed.includes("*/")) fail(`inserted line contains */: ${JSON.stringify(line)}`);
      if (line.includes("\t")) fail(`inserted line contains tab: ${JSON.stringify(line)}`);
      const text = trimmed.slice(2);
      if (forbiddenRe.test(text)) fail(`forbidden leading word: ${JSON.stringify(line)}`);
      if (/;\s*$/.test(text)) fail(`text ends with semicolon: ${JSON.stringify(line)}`);
      if (text.includes("=>")) fail(`text contains arrow: ${JSON.stringify(line)}`);
      if (callRe.test(text)) fail(`text contains call expression: ${JSON.stringify(line)}`);
    }

    if (blockCount === 1) {
      headerChecked = true;
      if (!Array.isArray(item.raw)) fail("header block must use raw");
      else {
        if (item.raw.length !== 22) fail(`header raw length ${item.raw.length} !== 22`);
        if (!String(item.raw[0]).startsWith("// INV-01")) fail("header first line is not // INV-01");
        if (item.raw[18] !== "//") fail(`header line 19 is ${JSON.stringify(item.raw[18])}, expected "//"`);
        for (let i = 0; i < 18; i += 1) {
          const expected = `// INV-${String(i + 1).padStart(2, "0")}`;
          if (!String(item.raw[i]).startsWith(expected)) {
            fail(`header INV order broken at line ${i + 1}: ${JSON.stringify(item.raw[i])}`);
          }
        }
      }
    }
  }
}

if (!headerChecked) fail("missing header block");
if (totalInserted !== 61) fail(`total inserted lines ${totalInserted} !== 61`);

if (errors.length > 0) {
  console.log("FAIL");
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
