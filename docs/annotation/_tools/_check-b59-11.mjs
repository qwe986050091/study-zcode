import { readFileSync } from "node:fs";

const SRC = "d:/code/ZCode/packages/shared/src/conversation-message-projection-policy.ts";
const SPEC = "d:/code/_annot_baseline/ZC-deep-b59-spec-11.json";

const srcLines = readFileSync(SRC, "utf8").split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());
const spec = JSON.parse(readFileSync(SPEC, "utf8"));

const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errors = [];
let total = 0;
let itemCount = 0;
let anchorCount = 0;

for (const f of spec.files) {
  for (const item of f.items) {
    itemCount += 1;
    const body = item.raw ?? item.lines;
    total += body.length;
    const occ = trimmed.filter((l) => l === item.anchor).length;
    anchorCount += 1;
    if (occ !== 1) errors.push(`anchor 出现 ${occ} 次: ${item.anchor}`);
    const nth = item.nth;
    if (nth !== undefined && (nth < 1 || nth > occ)) errors.push(`nth 越界: ${item.anchor}`);

    for (const line of body) {
      if (item.raw) {
        if (!line.startsWith("//")) errors.push(`raw 行未以 // 开头: ${line}`);
      }
      const content = line.replace(/^\s*\/\/\s?/, "").trim();
      if (content === "") continue;
      if (content.includes("*/")) errors.push(`含 */: ${line}`);
      if (content.includes("=>")) errors.push(`含 =>: ${line}`);
      if (content.endsWith(";")) errors.push(`以 ; 结尾: ${line}`);
      const first = content.split(/[\s（，、：]/)[0];
      if (BANNED.includes(first)) errors.push(`禁词开头 [${first}]: ${line}`);
      if (/^[A-Za-z_$][\w$]*\.[\w$]+\(/.test(content)) errors.push(`调用形态: ${line}`);
    }
  }
}

console.log(`items = ${itemCount} (含 raw 头), anchors = ${anchorCount}`);
console.log(`总行数 = ${total} (目标 69)`);
if (total !== 69) errors.push(`总行数 ${total} !== 69`);
if (errors.length) {
  console.log("FAIL");
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log("ALL PASS");
