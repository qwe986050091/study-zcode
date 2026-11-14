import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b58-spec-09.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const file = spec.files[0];
const srcPath = "d:/code/ZCode/" + file.file;
const src = fs.readFileSync(srcPath, "utf8");
const srcLines = src.split(/\r?\n/);

const bannedFirst = new Set(
  "const let var function class import export return if else for while switch try catch await async throw new interface type enum".split(" "),
);
const callRe = /[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\(/;

let total = 0;
const errors = [];

for (const [idx, item] of file.items.entries()) {
  const inserted = item.raw
    ? item.raw
    : item.lines.map((line) => (line === "" ? "//" : "// " + line));
  total += inserted.length;
  if (!item.raw) total -= 0;

  const matches = srcLines
    .map((line, i) => ({ line: line.trim(), i }))
    .filter((entry) => entry.line === item.anchor);
  const nth = item.nth ?? 1;
  if (matches.length === 0) {
    errors.push(`item#${idx + 1} anchor 未匹配: ${JSON.stringify(item.anchor)}`);
  } else if (item.nth) {
    if (item.nth < 1 || item.nth > matches.length) {
      errors.push(`item#${idx + 1} nth 越界: ${item.nth} > ${matches.length}`);
    }
  } else if (matches.length > 1) {
    errors.push(`item#${idx + 1} anchor 重复 ${matches.length} 次但未声明 nth: ${JSON.stringify(item.anchor)}`);
  }

  for (const raw of inserted) {
    if (!raw.startsWith("//")) {
      errors.push(`item#${idx + 1} 非法注释行: ${JSON.stringify(raw)}`);
      continue;
    }
    const body = raw.slice(2);
    if (body.includes("*/")) errors.push(`item#${idx + 1} 含 */: ${JSON.stringify(raw)}`);
    if (body.includes("=>")) errors.push(`item#${idx + 1} 含 =>: ${JSON.stringify(raw)}`);
    if (/;\s*$/.test(body)) errors.push(`item#${idx + 1} 以分号结尾: ${JSON.stringify(raw)}`);
    if (callRe.test(body)) errors.push(`item#${idx + 1} 调用样式: ${JSON.stringify(raw)}`);
    const trimmed = body.trim();
    if (trimmed) {
      const first = trimmed.split(/\s+/)[0];
      if (bannedFirst.has(first)) {
        errors.push(`item#${idx + 1} 禁用开头词 ${first}: ${JSON.stringify(raw)}`);
      }
    }
  }
}

console.log("items:", file.items.length);
console.log("total inserted lines:", total);
console.log("target 74 ->", total === 74 ? "OK" : "FAIL");
if (errors.length) {
  console.log("ERRORS:", errors.length);
  for (const e of errors) console.log(" -", e);
  process.exitCode = 1;
} else {
  console.log("all checks passed");
}
