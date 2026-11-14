import fs from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b62-spec-03.json";
const TARGET = "d:/code/ZCode/packages/ui/src/project-sidebar/useProjectUnreadSignals.ts";

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const src = fs.readFileSync(TARGET, "utf8");
const srcLines = src.split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const problems = [];
let total = 0;
let itemCount = 0;

for (const file of spec.files) {
  if (file.file !== "packages/ui/src/project-sidebar/useProjectUnreadSignals.ts") {
    problems.push(`unexpected file entry: ${file.file}`);
  }
  for (const [idx, item] of file.items.entries()) {
    itemCount += 1;
    const lines = item.raw ? item.raw : item.lines;
    total += lines.length;
    if (!item.raw && !item.lines) problems.push(`item ${idx}: missing lines/raw`);

    // anchor 校验
    const hits = trimmed.reduce((acc, l, i) => (l === item.anchor.trim() ? [...acc, i] : acc), []);
    if (hits.length === 0) problems.push(`item ${idx}: anchor NOT FOUND -> ${JSON.stringify(item.anchor)}`);
    const nth = item.nth ?? 1;
    if (hits.length > 0 && nth > hits.length) problems.push(`item ${idx}: nth ${nth} > occurrences ${hits.length}`);
    if (hits.length > 1 && item.nth == null) problems.push(`item ${idx}: anchor appears ${hits.length}x but no nth -> ${JSON.stringify(item.anchor)}`);
    if (hits.length === 1 && item.nth != null) problems.push(`item ${idx}: nth given but anchor unique`);

    // 注释内容校验
    for (const [li, raw] of lines.entries()) {
      let text = raw;
      if (item.raw) {
        if (!text.startsWith("//")) problems.push(`item ${idx} line ${li}: raw not starting with //`);
        text = text.slice(2);
      }
      if (text.includes("*/")) problems.push(`item ${idx} line ${li}: contains */`);
      if (text.includes("=>")) problems.push(`item ${idx} line ${li}: contains =>`);
      if (/;\s*$/.test(text)) problems.push(`item ${idx} line ${li}: ends with ;`);
      if (text.includes(";")) problems.push(`item ${idx} line ${li}: contains ascii ;`);
      const body = text.replace(/^\s+/, "");
      const first = body.split(/[\s，。、：；「」（）[\]()]+/).filter(Boolean)[0] ?? "";
      if (BANNED_START.includes(first)) problems.push(`item ${idx} line ${li}: starts with banned word "${first}"`);
      if (body.startsWith("//")) problems.push(`item ${idx} line ${li}: double comment marker`);
      if (/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(text)) {
        problems.push(`item ${idx} line ${li}: call-shaped identifier.identifier( -> ${text.trim()}`);
      }
    }
  }
}

// 文件头：首个 item 必须是 raw，且锚点为首个 import
const first = spec.files[0].items[0];
if (!first.raw) problems.push("first item is not raw header");
if (!first.anchor.startsWith("import ")) problems.push("header anchor is not an import line");
const headerInvs = first.raw.filter((l) => /^\/\/ INV-\d{2} /.test(l)).length;
if (headerInvs < 18 || headerInvs > 20) problems.push(`header INV count ${headerInvs} not in 18..20`);
if (first.raw[first.raw.length - 1].trim() !== "//") problems.push("header does not end with bare //");

console.log(`items=${itemCount} totalLines=${total} headerINV=${headerInvs}`);
if (total < 69 || total > 71) problems.push(`total lines ${total} out of 69..71`);
if (problems.length) {
  console.log("FAIL");
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
console.log("PASS: all checks green");
