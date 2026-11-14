import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-07.json";
const targetPath =
  "d:/code/ZCode/packages/desktop/src/renderer/src/plugin-sandbox/aliasRuntime.ts";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const src = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmed = src.map((l) => l.trim());

const bannedStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const callForm = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let total = 0;
const errors = [];

for (const file of spec.files) {
  for (let i = 0; i < file.items.length; i++) {
    const item = file.items[i];
    const body = item.raw ?? item.lines;
    if (!Array.isArray(body) || body.length === 0) {
      errors.push(`#${i} 缺少 raw/lines`);
      continue;
    }
    total += body.length;

    const nth = item.nth ?? 1;
    const hits = trimmed.filter((l) => l === item.anchor).length;
    if (hits === 0) errors.push(`#${i} anchor 不存在: ${item.anchor}`);
    if (hits < nth) errors.push(`#${i} nth=${nth} 超出出现次数 ${hits}: ${item.anchor}`);
    if (hits > 1 && !item.nth) errors.push(`#${i} anchor 重复 ${hits} 次但未给 nth: ${item.anchor}`);

    for (let j = 0; j < body.length; j++) {
      const line = body[j];
      const content = item.raw ? line : `// ${line}`;
      const plain = content.replace(/^\/\/ ?/, "");
      if (content.includes("*/")) errors.push(`#${i}.${j} 含 */`);
      if (item.raw && !line.startsWith("//")) errors.push(`#${i}.${j} raw 未以 // 开头`);
      if (/:$/.test(line.trim())) errors.push(`#${i}.${j} 以冒号结尾`);
      if (/;$/.test(line.trim())) errors.push(`#${i}.${j} 以分号结尾`);
      if (line.includes("=>")) errors.push(`#${i}.${j} 含 =>`);
      if (callForm.test(plain)) errors.push(`#${i}.${j} 命中调用形态: ${plain}`);
      const first = plain.split(/[\s，、；]/)[0];
      if (bannedStart.includes(first)) errors.push(`#${i}.${j} 以禁词开头: ${first}`);
    }
  }
}

if (total < 71 || total > 73) errors.push(`总行数 ${total} 不在 71~73`);

console.log(`items=${spec.files[0].items.length} total=${total}`);
if (errors.length) {
  console.log("FAIL");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("PASS");
