import { readFileSync } from "node:fs";

const ROOT = "d:/code/ZCode";
const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b63-spec-11.json";
const TARGET = "packages/ui/src/lib/zcodeSessionRestore.ts";
const EXPECTED_LINES = 67;

const KEYWORD_START =
  /^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const PROPERTY_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function die(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function checkText(label, text) {
  if (text.includes("*/")) die(`${label}: forbidden "*/" -> ${text}`);
  if (KEYWORD_START.test(text)) die(`${label}: forbidden leading keyword -> ${text}`);
  if (text.endsWith(";")) die(`${label}: forbidden trailing ";" -> ${text}`);
  if (text.includes("=>")) die(`${label}: forbidden "=>" -> ${text}`);
  if (PROPERTY_CALL.test(text)) die(`${label}: forbidden property call -> ${text}`);
}

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const entry = Array.isArray(spec.files) ? spec.files.find((f) => f.file === TARGET) : undefined;
if (!entry) die(`spec has no entry for ${TARGET}`);

const items = entry.items;
if (!Array.isArray(items) || items.length === 0) die("items is empty");

const sourceText = readFileSync(`${ROOT}/${TARGET}`, "utf8");
const sourceLines = sourceText.split(/\r?\n/);

let total = 0;
let anchorCount = 0;
let insertedChars = 0;
const seenAnchors = new Map();

items.forEach((item, idx) => {
  const anchor = typeof item.anchor === "string" ? item.anchor : "";
  if (!anchor.trim()) die(`item #${idx + 1}: empty anchor`);

  const normalized = anchor.trim();
  const matches = [];
  sourceLines.forEach((line, lineIdx) => {
    if (line.trim() === normalized) matches.push(lineIdx + 1);
  });
  if (matches.length === 0) die(`item #${idx + 1}: anchor not found -> ${normalized}`);

  const nth = item.nth === undefined ? 1 : item.nth;
  if (!Number.isInteger(nth) || nth < 1) die(`item #${idx + 1}: invalid nth -> ${item.nth}`);
  if (nth > matches.length) {
    die(`item #${idx + 1}: nth ${nth} out of range (matches ${matches.length}) -> ${normalized}`);
  }
  if (item.nth === undefined && matches.length !== 1) {
    die(`item #${idx + 1}: anchor not unique (${matches.length} matches) -> ${normalized}`);
  }
  const key = `${normalized}#${nth}`;
  if (seenAnchors.has(key)) {
    die(`item #${idx + 1}: duplicate anchor+nth (also item #${seenAnchors.get(key)}) -> ${normalized}`);
  }
  seenAnchors.set(key, idx + 1);
  anchorCount += 1;

  if (idx === 0) {
    if (!Array.isArray(item.raw) || item.raw.length === 0) die("first item must provide raw");
    if (item.lines !== undefined) die("first item must not provide lines");
    item.raw.forEach((rawLine, rawIdx) => {
      if (typeof rawLine !== "string") die(`raw[${rawIdx}] is not a string`);
      if (!rawLine.startsWith("// ") && rawLine !== "//") {
        die(`raw[${rawIdx}] must start with "// " or be "//" -> ${rawLine}`);
      }
      const body = rawLine === "//" ? "" : rawLine.slice(3);
      if (body) checkText(`raw[${rawIdx}]`, body);
    });
    const invLines = item.raw.filter((l) => /^\/\/ INV-\d\d /.test(l));
    if (invLines.length !== 18) die(`raw must contain INV-01..INV-18, got ${invLines.length}`);
    for (let n = 1; n <= 18; n += 1) {
      const tag = `INV-${String(n).padStart(2, "0")} `;
      const hit = invLines.find((l) => l.startsWith(`// ${tag}`));
      if (!hit) die(`raw missing ${tag.trim()}`);
      if (!hit.includes("守住位置：") || !hit.includes("改错故障：")) {
        die(`${tag.trim()} missing 守住位置/改错故障`);
      }
    }
    const separator = item.raw.indexOf("//");
    if (separator !== 18) die(`raw must put a "//" separator after INV-18 (at index ${separator})`);
    if (item.raw.length !== 22) die(`raw must be 22 lines, got ${item.raw.length}`);
    total += item.raw.length;
    insertedChars += item.raw.reduce((sum, l) => sum + l.length, 0);
    return;
  }

  if (item.raw !== undefined) die(`item #${idx + 1}: only first item may use raw`);
  if (!Array.isArray(item.lines) || item.lines.length === 0) {
    die(`item #${idx + 1}: missing lines`);
  }
  item.lines.forEach((line, lineIdx) => {
    if (typeof line !== "string" || !line.trim()) die(`item #${idx + 1} lines[${lineIdx}]: empty`);
    checkText(`item #${idx + 1} lines[${lineIdx}]`, line);
  });
  total += item.lines.length;
  insertedChars += item.lines.reduce((sum, l) => sum + l.length, 0);
});

if (total !== EXPECTED_LINES) die(`total comment lines ${total} !== ${EXPECTED_LINES}`);

const currentCommentChars = sourceLines
  .filter((line) => line.trim().startsWith("//"))
  .reduce((sum, line) => sum + line.length, 0);
const nextTotalChars = sourceText.length + insertedChars + total;
const nextCommentChars = currentCommentChars + insertedChars;
const ratio = (nextCommentChars / nextTotalChars) * 100;

console.log(`target: ${TARGET}`);
console.log(`total lines: ${total}, anchors: ${anchorCount}, items: ${items.length}`);
console.log(`inserted chars: ${insertedChars}, comment ratio: ${ratio.toFixed(2)}%`);
console.log(`OK ${total} lines / ${anchorCount} anchors / ${ratio.toFixed(2)}%`);
