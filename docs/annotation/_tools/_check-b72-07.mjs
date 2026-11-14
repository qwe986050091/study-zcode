import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b72-spec-07.json";
const repoRoot = "d:/code/ZCode";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const BANNED = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const fail = (msg) => errors.push(msg);

let totalLines = 0;
let blockCount = 0;
let headerRaw = null;

for (const entry of spec.files) {
  const filePath = `${repoRoot}/${entry.file}`;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const usedIndices = new Map();

  for (const item of entry.items) {
    blockCount += 1;
    const anchorTrim = item.anchor.trim();
    const hits = [];
    lines.forEach((line, i) => {
      if (line.trim() === anchorTrim) hits.push(i);
    });
    if (hits.length === 0) {
      fail(`anchor not found: ${JSON.stringify(item.anchor)}`);
      continue;
    }
    let index;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        fail(`nth out of range (${item.nth}) for anchor: ${JSON.stringify(item.anchor)} hits=${hits.length}`);
        continue;
      }
      index = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        fail(`anchor not unique (${hits.length} hits): ${JSON.stringify(item.anchor)}`);
        continue;
      }
      index = hits[0];
    }
    if (usedIndices.has(index)) {
      fail(`duplicate insertion index ${index} (anchors: ${JSON.stringify(usedIndices.get(index))} / ${JSON.stringify(item.anchor)})`);
      continue;
    }
    usedIndices.set(index, item.anchor);

    const indent = (lines[index].match(/^[\t ]*/) || [""])[0];
    let inserted;
    if (Array.isArray(item.raw)) {
      if (headerRaw !== null) fail("more than one raw item");
      headerRaw = item.raw;
      inserted = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`));
    } else {
      fail(`item has neither raw nor lines: ${JSON.stringify(item.anchor)}`);
      continue;
    }

    for (const l of inserted) {
      totalLines += 1;
      const t = l.trim();
      if (!t.startsWith("//")) fail(`inserted line does not start with //: ${JSON.stringify(l)}`);
      if (t.includes("*/")) fail(`inserted line contains */: ${JSON.stringify(l)}`);
      const body = t.slice(2).trim();
      if (body.length > 0) {
        const first = body.split(/[\s:：,，。]/)[0];
        if (BANNED.has(first)) fail(`inserted line starts with banned word ${first}: ${JSON.stringify(l)}`);
        if (CALL_RE.test(body)) fail(`inserted line looks like a call expression: ${JSON.stringify(l)}`);
      }
      if (t.endsWith(";")) fail(`inserted line ends with ;: ${JSON.stringify(l)}`);
      if (t.includes("=>")) fail(`inserted line contains =>: ${JSON.stringify(l)}`);
    }
    if (Array.isArray(item.lines) && (item.lines.length < 3 || item.lines.length > 6)) {
      fail(`block size out of range (${item.lines.length}) for anchor: ${JSON.stringify(item.anchor)}`);
    }
  }
}

if (headerRaw === null) {
  fail("missing header raw item");
} else {
  if (headerRaw.length !== 22) fail(`header raw length ${headerRaw.length} !== 22`);
  if (!headerRaw[0] || !headerRaw[0].startsWith("// INV-01")) fail(`header raw[0] not INV-01: ${JSON.stringify(headerRaw[0])}`);
  if (headerRaw[18] !== "//") fail(`header raw[18] !== "//": ${JSON.stringify(headerRaw[18])}`);
  headerRaw.forEach((l, i) => {
    if (i < 18 && !new RegExp(`^// INV-${String(i + 1).padStart(2, "0")} `).test(l)) {
      fail(`header raw[${i}] not INV-${String(i + 1).padStart(2, "0")}: ${JSON.stringify(l)}`);
    }
  });
}

if (totalLines !== 63) fail(`total inserted lines ${totalLines} !== 63`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalLines}`);
