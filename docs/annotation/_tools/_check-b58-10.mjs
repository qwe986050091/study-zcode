import fs from "node:fs";
import path from "node:path";

const specPath = "d:/code/_annot_baseline/ZC-deep-b58-spec-10.json";
const repoRoot = "d:/code/ZCode";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const bannedStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let errors = [];
let total = 0;
let itemCount = 0;

for (const entry of spec.files) {
  if (entry.file.startsWith("ZCode/") || path.isAbsolute(entry.file)) {
    errors.push(`file 字段不合规: ${entry.file}`);
  }
  const abs = path.join(repoRoot, entry.file);
  const rawLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const trimmed = rawLines.map((l) => l.trim());

  entry.items.forEach((item, idx) => {
    itemCount += 1;
    const lines = item.raw ? item.raw : item.lines;
    total += lines.length;

    const hits = trimmed.filter((l) => l === item.anchor).length;
    const idx1 = item.nth ?? null;
    if (hits === 0) errors.push(`#${idx} anchor 不存在: ${item.anchor}`);
    else if (hits > 1 && !idx1) errors.push(`#${idx} anchor 出现 ${hits} 次但缺 nth: ${item.anchor}`);
    else if (idx1 && (idx1 < 1 || idx1 > hits)) errors.push(`#${idx} nth=${idx1} 超出范围 ${hits}`);

    lines.forEach((line, li) => {
      const effective = item.raw ? line : `// ${line}`;
      if (item.raw && !line.startsWith("//")) errors.push(`#${idx}.${li} raw 非注释行: ${line}`);
      if (effective.includes("*/")) errors.push(`#${idx}.${li} 含 */: ${line}`);
      if (effective.includes("=>")) errors.push(`#${idx}.${li} 含 =>: ${line}`);
      const body = effective.replace(/^\/\/\s?/, "");
      const body2 = line.replace(/^\/\/\s?/, "");
      const target = item.raw ? body : body2;
      if (/^\s*$/.test(target)) return;
      if (/;$/.test(effective) || /;$/.test(line)) errors.push(`#${idx}.${li} 以 ; 结尾: ${line}`);
      const first = target.trim().split(/[\s(（:：,，]/)[0];
      if (bannedStart.includes(first)) errors.push(`#${idx}.${li} 禁词开头(${first}): ${line}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(target))
        errors.push(`#${idx}.${li} 调用样式: ${line}`);
    });

    if (item.raw && idx !== 0) errors.push(`#${idx} raw 只允许用于文件头`);
  });
}

console.log(`items = ${itemCount}`);
console.log(`total comment lines = ${total}`);
if (errors.length) {
  console.log("FAIL");
  errors.forEach((e) => console.log(" - " + e));
  process.exitCode = 1;
} else {
  console.log("ALL CHECKS PASSED");
}
