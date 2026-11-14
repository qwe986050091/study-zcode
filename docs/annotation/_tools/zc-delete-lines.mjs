// 按行号删除指定行（仅允许删除 trim 后以 // 或 # 开头的行），保留原换行风格。
// 用法：node zc-delete-lines.mjs <file> 2026,2027,...
import fs from 'node:fs';
const file = process.argv[2];
const targets = new Set(process.argv[3].split(',').map((s) => Number(s.trim())).filter(Boolean));
const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const kept = [];
let removed = 0;
for (let i = 0; i < lines.length; i++) {
  const lineNo = i + 1;
  if (targets.has(lineNo)) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('//') && !trimmed.startsWith('#')) {
      throw new Error(`line ${lineNo} is not a comment: ${lines[i]}`);
    }
    removed += 1;
    continue;
  }
  kept.push(lines[i]);
}
if (removed !== targets.size) throw new Error(`expected ${targets.size} removals, got ${removed}`);
fs.writeFileSync(file, kept.join(eol));
console.log(`removed=${removed} file=${file}`);
