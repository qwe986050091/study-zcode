import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b71-spec-01.json";
const TARGET = "d:/code/ZCode/packages/ui/src/git-graph/GitGraphDialog.tsx";
const EXPECTED_LINES = 61;

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const fileText = readFileSync(TARGET, "utf8");
const src = fileText.split(/\r?\n/);

const failures = [];
const fail = (msg) => failures.push(msg);

const entry = spec.files[0];
if (entry.file !== "packages/ui/src/git-graph/GitGraphDialog.tsx") {
  fail(`unexpected file field: ${entry.file}`);
}

const FORBIDDEN_HEAD = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[\w$]+\.[\w$]+\s*\(/;

const usedIndexes = new Set();
let total = 0;

const items = entry.items;
items.forEach((item, i) => {
  const anchorTrim = String(item.anchor).trim();
  const hits = [];
  src.forEach((line, idx) => {
    if (line.trim() === anchorTrim) hits.push(idx);
  });

  let insertAt = null;
  if (item.nth !== undefined) {
    const n = Number(item.nth);
    if (!Number.isInteger(n) || n < 1) fail(`item#${i}: invalid nth ${item.nth}`);
    else if (hits.length < n) fail(`item#${i}: nth=${n} but only ${hits.length} hits for anchor`);
    else insertAt = hits[n - 1];
  } else {
    if (hits.length === 0) fail(`item#${i}: anchor not found -> ${JSON.stringify(item.anchor)}`);
    else if (hits.length > 1) fail(`item#${i}: anchor not unique (${hits.length} hits) -> ${JSON.stringify(item.anchor)}`);
    else insertAt = hits[0];
  }

  if (insertAt !== null) {
    if (usedIndexes.has(insertAt)) fail(`item#${i}: duplicate insertion index ${insertAt}`);
    usedIndexes.add(insertAt);
  }

  let emitted;
  if (Array.isArray(item.raw)) {
    if (item.lines !== undefined) fail(`item#${i}: both raw and lines present`);
    emitted = item.raw.map((s) => String(s));
  } else if (Array.isArray(item.lines)) {
    const rawAnchor = insertAt === null ? "" : src[insertAt];
    const indent = (rawAnchor.match(/^\s*/) || [""])[0];
    emitted = item.lines.map((s) => {
      const t = String(s);
      return t === "" ? `${indent}//` : `${indent}// ${t}`;
    });
  } else {
    fail(`item#${i}: neither raw nor lines`);
    emitted = [];
  }

  total += emitted.length;

  emitted.forEach((line, j) => {
    const t = line.trim();
    if (!t.startsWith("//")) fail(`item#${i} line#${j}: not a // comment -> ${JSON.stringify(line)}`);
    if (t.includes("*/")) fail(`item#${i} line#${j}: contains */`);
    if (t.endsWith(";")) fail(`item#${i} line#${j}: ends with ;`);
    if (t.includes("=>")) fail(`item#${i} line#${j}: contains =>`);
    if (CALL_RE.test(t)) fail(`item#${i} line#${j}: looks like a call expression -> ${JSON.stringify(t)}`);

    const body = t.replace(/^\/\/\s?/, "");
    const first = (body.match(/^[A-Za-z]+/) || [""])[0].toLowerCase();
    if (FORBIDDEN_HEAD.includes(first)) {
      fail(`item#${i} line#${j}: forbidden leading word ${first}`);
    }
  });
});

// Header shape
const header = items[0];
if (!Array.isArray(header.raw)) fail("item#0 is not a raw header block");
else {
  if (header.raw.length !== 22) fail(`header raw length ${header.raw.length} !== 22`);
  if (!String(header.raw[0]).startsWith("// INV-01")) fail("header first line does not start with // INV-01");
  if (String(header.raw[18]) !== "//") fail(`header line 19 is ${JSON.stringify(header.raw[18])}, expected "//"`);
  if (!String(header.raw[1]).startsWith("// INV-02")) fail("header line 2 is not // INV-02");
  if (!String(header.raw[17]).startsWith("// INV-18")) fail("header line 18 is not // INV-18");
  if (!String(header.raw[19]).includes("模块职责")) fail("header line 20 is not 模块职责");
  if (!String(header.raw[20]).includes("状态所有权")) fail("header line 21 is not 状态所有权");
  if (!String(header.raw[21]).includes("阅读顺序")) fail("header line 22 is not 阅读顺序");
}

if (total !== EXPECTED_LINES) fail(`inserted line total ${total} !== ${EXPECTED_LINES}`);

// Simulate insertion and assert original lines survive intact.
const plan = [];
items.forEach((item, i) => {
  const anchorTrim = String(item.anchor).trim();
  const hits = [];
  src.forEach((line, idx) => {
    if (line.trim() === anchorTrim) hits.push(idx);
  });
  const at = item.nth !== undefined ? hits[Number(item.nth) - 1] : hits[0];
  const count = Array.isArray(item.raw) ? item.raw.length : item.lines.length;
  plan.push({ at, i, count });
});
plan.sort((a, b) => b.at - a.at);
const out = src.slice();
for (const p of plan) {
  if (p.at === undefined) continue;
  const item = items[p.i];
  const rawAnchor = src[p.at];
  const indent = (rawAnchor.match(/^\s*/) || [""])[0];
  const emitted = Array.isArray(item.raw)
    ? item.raw.map(String)
    : item.lines.map((s) => (String(s) === "" ? `${indent}//` : `${indent}// ${s}`));
  out.splice(p.at, 0, ...emitted);
}
const stripComments = out.filter((line, idx) => !idx || true);
const originalKept = out.filter((line) => !line.trim().startsWith("//") || src.includes(line));
if (originalKept.length === 0) fail("simulation sanity failed");
const removed = src.filter((line) => !out.includes(line));
if (removed.length > 0) fail(`original lines missing after simulation: ${removed.length}`);
if (out.length !== src.length + total) fail(`simulated length ${out.length} !== ${src.length + total}`);
if (out.length - src.length !== EXPECTED_LINES) fail("delta mismatch");
void stripComments;

if (failures.length > 0) {
  console.error("FAILED");
  failures.forEach((m) => console.error("- " + m));
  process.exit(1);
}
console.log(`OK blocks=${items.length} lines=${total}`);
