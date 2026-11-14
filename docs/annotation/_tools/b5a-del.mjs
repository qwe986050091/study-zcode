// 仅用于删除本次新增的多余注释行（基线里不存在的行），保留原文件行尾。
// 用法：node b5a-del.mjs <spec.json>
// spec: { "files": [ { "path": "...", "lines": ["// xxx"] } ] }
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const f of spec.files) {
  const abs = path.join(repo, f.path);
  const text = fs.readFileSync(abs, 'utf8');
  const crlf = text.includes('\r\n');
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  for (const want of f.lines) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === want.trim()) hits.push(i);
    if (hits.length !== 1) {
      console.error(`LINE ${hits.length === 0 ? 'NOT FOUND' : 'AMBIGUOUS'} in ${f.path}: ${want}`);
      process.exit(1);
    }
    lines.splice(hits[0], 1);
  }
  fs.writeFileSync(abs, lines.join(crlf ? '\r\n' : '\n') + (trailingNewline ? (crlf ? '\r\n' : '\n') : ''));
  console.log(`OK ${f.path} -${f.lines.length}`);
}
