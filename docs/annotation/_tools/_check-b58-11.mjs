import fs from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b58-spec-11.json";
const TARGET = "d:\\code\\ZCode\\packages\\ui\\src\\i18n\\IntlProvider.tsx";

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const src = fs.readFileSync(TARGET, "utf8").split(/\r?\n/);
const trimmed = src.map((l) => l.trim());

let errors = [];
let total = 0;

const entry = spec.files[0];
if (entry.file !== "packages/ui/src/i18n/IntlProvider.tsx") {
  errors.push(`bad file field: ${entry.file}`);
}

const BANNED_START = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const DOT_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const items = entry.items;

// 首个 item 必须是 raw 文件头
if (!items[0].raw) errors.push("first item is not raw");

items.forEach((item, i) => {
  const anchor = item.anchor;
  const count = trimmed.filter((l) => l === anchor).length;
  const nth = item.nth ?? 1;
  if (count === 0) {
    errors.push(`[${i}] anchor not found: ${anchor}`);
  } else if (!item.nth && count !== 1) {
    errors.push(`[${i}] anchor appears ${count} times but no nth: ${anchor}`);
  } else if (item.nth && count < nth) {
    errors.push(`[${i}] anchor has only ${count} occurrences, nth=${nth}`);
  }

  const arr = item.raw ?? item.lines;
  if (!Array.isArray(arr) || arr.length === 0) {
    errors.push(`[${i}] empty lines/raw`);
    return;
  }
  total += arr.length;

  arr.forEach((line, j) => {
    let text;
    if (item.raw) {
      if (!line.startsWith("//")) errors.push(`[${i}.${j}] raw line lacks //: ${line}`);
      text = line.replace(/^\/\/\s?/, "");
    } else {
      text = line;
      if (line.startsWith("//")) errors.push(`[${i}.${j}] lines entry should not carry //: ${line}`);
    }

    if (line.includes("*/")) errors.push(`[${i}.${j}] contains */ : ${line}`);
    if (text.includes("=>")) errors.push(`[${i}.${j}] contains => : ${line}`);
    const t = text.trim();
    if (t.endsWith(";")) errors.push(`[${i}.${j}] ends with ; : ${line}`);
    if (BANNED_START.test(t)) errors.push(`[${i}.${j}] banned start word: ${line}`);
    if (DOT_CALL.test(t)) errors.push(`[${i}.${j}] dot-call pattern: ${line}`);
  });
});

const rawTotal = items[0].raw.length;
console.log(`items = ${items.length}`);
console.log(`total inserted lines = ${total} (header ${rawTotal})`);
console.log(`raw header present = ${!!items[0].raw}`);

if (total !== 75) errors.push(`total lines ${total} != 75`);

const header = items[0].raw;
const blankIdx = header.lastIndexOf("//");
if (blankIdx === -1) errors.push("header missing trailing // line");
else {
  const tail = header.length - blankIdx - 1;
  console.log(`header summary lines after trailing // = ${tail}`);
  if (tail < 2 || tail > 4) errors.push(`header summary tail ${tail} out of 2..4`);
}

const invCount = items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
console.log(`INV lines = ${invCount}`);
if (invCount < 18 || invCount > 20) errors.push(`INV count ${invCount} out of 18..20`);

if (errors.length) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" - " + e));
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
