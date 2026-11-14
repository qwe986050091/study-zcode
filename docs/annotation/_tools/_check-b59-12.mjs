import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b59-spec-12.json";
const ROOT = "d:/code/ZCode/";
const TARGET = "packages/ui/src/hooks/useClaudeSessionMigration.ts";

const BAN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const fileEntry = spec.files[0];
const srcLines = readFileSync(ROOT + fileEntry.file, "utf8").split(/\r?\n/);
const errorList = [];
let total = 0;
let itemCount = 0;

for (const [idx, item] of fileEntry.items.entries()) {
  const tag = `item#${idx + 1}`;
  itemCount += 1;
  const body = item.raw ? item.raw : item.lines;
  total += body.length;

  const rawText = srcLines.join("\n");
  const anchor = item.anchor;
  if (anchor !== anchor.trim()) errorList.push(`${tag} anchor 未 trim: ${JSON.stringify(anchor)}`);

  let occurrences = 0;
  for (const line of srcLines) if (line.trim() === anchor) occurrences += 1;
  if (occurrences === 0) {
    errorList.push(`${tag} anchor 不匹配: ${JSON.stringify(anchor)}`);
  } else if (occurrences > 1) {
    if (typeof item.nth !== "number") errorList.push(`${tag} anchor 重复 ${occurrences} 次却缺 nth`);
    else if (item.nth < 1 || item.nth > occurrences) errorList.push(`${tag} nth=${item.nth} 越界（共 ${occurrences}）`);
  } else if (item.nth !== undefined && item.nth !== 1) {
    errorList.push(`${tag} anchor 唯一却给了 nth=${item.nth}`);
  }

  if (item.raw && idx !== 0) errorList.push(`${tag} raw 仅允许用于文件头`);

  for (const [li, line] of body.entries()) {
    const where = `${tag} L${li + 1}`;
    let content;
    if (item.raw) {
      if (!line.startsWith("//")) {
        errorList.push(`${where} raw 行非整行注释: ${line.slice(0, 40)}`);
        continue;
      }
      content = line.length > 2 ? line.slice(3) : "";
    } else {
      if (line.startsWith("//")) errorList.push(`${where} lines 不应自带 //: ${line.slice(0, 40)}`);
      content = line;
    }
    if (line.includes("*/")) errorList.push(`${where} 含 */`);
    if (content.endsWith(";")) errorList.push(`${where} 以 ; 结尾: ${content}`);
    if (content.includes("=>")) errorList.push(`${where} 含 =>`);
    if (/[A-Za-z0-9_$][.]\s*[A-Za-z0-9_$]+\s*\(/.test(content)) {
      errorList.push(`${where} 形如 标识符.标识符( 调用: ${content}`);
    }
    const first = content.split(/[\s，。；：、]/)[0];
    if (BAN_START.includes(first)) errorList.push(`${where} 以禁词开头(${first}): ${content}`);
    if (item.raw && line !== "//" && content.trim() === "") {
      errorList.push(`${where} raw 空注释格式异常: ${JSON.stringify(line)}`);
    }
  }
}

const invCount = fileEntry.items[0].raw.filter((l) => l.startsWith("// INV-")).length;
if (invCount < 18 || invCount > 20) errorList.push(`INV 条数 ${invCount} 不在 18~20`);

if (total !== 68) errorList.push(`总行数 ${total} !== 68`);

console.log(JSON.stringify({ items: itemCount, total, invCount, errors: errorList }, null, 2));
if (errorList.length > 0) process.exitCode = 1;
