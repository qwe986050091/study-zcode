import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b61-spec-05.json";
const targetPath = "d:/code/ZCode/apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = readFileSync(targetPath, "utf8").split(/\r?\n/);

const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let totalLines = 0;
const problems = [];

for (const file of spec.files) {
  if (file.file !== "apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts") {
    problems.push(`file 字段不匹配: ${file.file}`);
  }
  file.items.forEach((item, index) => {
    const payload = item.raw ?? item.lines;
    if (!Array.isArray(payload)) {
      problems.push(`#${index} 缺少 raw/lines`);
      return;
    }
    totalLines += payload.length;

    const anchor = String(item.anchor);
    const trimmedAnchor = anchor.trim();
    const occurrences = source.filter((line) => line.trim() === trimmedAnchor).length;

    if (occurrences === 0) {
      problems.push(`anchor 未命中 #${index}: ${trimmedAnchor}`);
    } else if (item.nth === undefined) {
      if (occurrences !== 1) problems.push(`anchor 不唯一(${occurrences}) #${index}: ${trimmedAnchor}`);
    } else if (occurrences < item.nth) {
      problems.push(`nth 越界(${occurrences} < ${item.nth}) #${index}: ${trimmedAnchor}`);
    }

    if (item.raw !== undefined) {
      if (index !== 0) problems.push(`raw 只允许文件头使用 #${index}`);
      payload.forEach((line, i) => {
        if (!line.startsWith("//")) problems.push(`raw 行非注释 #${index}.${i}: ${line}`);
      });
      return;
    }

    payload.forEach((line, i) => {
      if (typeof line !== "string") {
        problems.push(`#${index}.${i} 非字符串`);
        return;
      }
      if (line === "") return; // 空串由插入器输出为「缩进 + //」
      if (line.includes("*/")) problems.push(`含 */ #${index}.${i}: ${line}`);
      if (line.endsWith(";")) problems.push(`以分号结尾 #${index}.${i}: ${line}`);
      if (line.includes("=>")) problems.push(`含 => #${index}.${i}: ${line}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(line)) {
        problems.push(`疑似调用形态 #${index}.${i}: ${line}`);
      }
      const head = line.replace(/^\/\/\s?/, "");
      const first = head.match(/^[A-Za-z_$][\w$]*/);
      if (first && BANNED.includes(first[0])) {
        problems.push(`禁词开头(${first[0]}) #${index}.${i}: ${line}`);
      }
    });
  });
}

const itemCount = spec.files.reduce((acc, file) => acc + file.items.length, 0);

console.log(`items: ${itemCount}`);
console.log(`totalLines: ${totalLines}`);
console.log(`totalLines 在 71~73: ${totalLines >= 71 && totalLines <= 73}`);

if (problems.length) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log(` - ${p}`);
  process.exitCode = 1;
} else {
  console.log("ALL CHECKS PASSED");
}
