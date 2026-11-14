import { readFile } from "node:fs/promises";

const specPath = "d:/code/_annot_baseline/ZC-deep-b59-spec-09.json";
const targetPath = "d:/code/ZCode/packages/desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts";

const spec = JSON.parse(await readFile(specPath, "utf8"));
const source = await readFile(targetPath, "utf8");
const lines = source.split(/\r?\n/).map((l) => l.trim());

const entry = spec.files[0];
const items = entry.items;

const banned = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const problems = [];
let total = 0;

for (const [index, item] of items.entries()) {
  const body = item.raw ?? item.lines;
  total += body.length;

  const matches = lines
    .map((text, lineIndex) => ({ text, lineIndex }))
    .filter((row) => row.text === item.anchor);

  if (matches.length === 0) {
    problems.push(`item#${index + 1} anchor 未命中: ${item.anchor}`);
  }
  const nth = item.nth ?? 1;
  if (item.nth !== undefined) {
    if (matches.length < nth) problems.push(`item#${index + 1} nth=${nth} 超出命中数 ${matches.length}`);
  } else if (matches.length !== 1) {
    problems.push(`item#${index + 1} anchor 重复 ${matches.length} 次但未给 nth: ${item.anchor}`);
  }
  if (item.raw && index !== 0) problems.push(`item#${index + 1} raw 只允许用于文件头`);

  for (const rawLine of body) {
    if (rawLine.includes("*/")) problems.push(`item#${index + 1} 含 */: ${rawLine}`);
    const stripped = rawLine.replace(/^\s*\/\/\s?/, "").replace(/^\s*\/\/$/, "");
    if (item.raw && rawLine.trim() !== "" && !rawLine.trim().startsWith("//")) {
      problems.push(`item#${index + 1} raw 非整行注释: ${rawLine}`);
    }
    for (const word of banned) {
      if (stripped === word || stripped.startsWith(word + " ") || stripped.startsWith(word + "(") || stripped.startsWith(word + ":")) {
        problems.push(`item#${index + 1} 禁词开头 ${word}: ${stripped}`);
      }
    }
    if (/;\s*$/.test(rawLine)) problems.push(`item#${index + 1} 以分号结尾: ${rawLine}`);
    if (rawLine.includes("=>")) problems.push(`item#${index + 1} 含箭头: ${rawLine}`);
    if (/[\w$)\]]\.[\w$]+\s*\(/.test(stripped)) problems.push(`item#${index + 1} 含调用形态: ${stripped}`);
  }
}

const invCount = (items[0].raw ?? []).filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) problems.push(`INV 条数 ${invCount} 不在 18~20`);
if (total !== 67) problems.push(`总行数 ${total} 不等于 67`);

console.log("items:", items.length);
console.log("INV:", invCount);
console.log("total lines:", total);
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "ALL CHECKS PASSED");
