// 批量插入整行注释：保持原文件行尾（CRLF/LF），按锚点整行匹配，锚点必须唯一。
// 用法：node _ins.mjs <spec.json>
// spec: { "files": [ { "path": "<相对仓库根>", "edits": [ { "anchor": "<整行原文>", "before": true, "lines": ["// ..."] } ] } ] }
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node _ins.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let totalAdded = 0;
for (const f of spec.files) {
  const abs = path.join(repo, f.path);
  let text = fs.readFileSync(abs, 'utf8');
  const crlf = text.includes('\r\n');
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  for (const e of f.edits) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === e.anchor.trim()) hits.push(i);
    }
    if (hits.length !== 1) {
      console.error(`ANCHOR ${hits.length === 0 ? 'NOT FOUND' : 'AMBIGUOUS(' + hits.length + ')'} in ${f.path}: ${e.anchor}`);
      process.exit(1);
    }
    for (const l of e.lines) {
      if (l.includes('*/')) {
        console.error(`STAR-SLASH in ${f.path}: ${l}`);
        process.exit(1);
      }
    }
    const idx = hits[0] + (e.before ? 0 : 1);
    lines.splice(idx, 0, ...e.lines);
    totalAdded += e.lines.length;
  }
  const out = lines.join(crlf ? '\r\n' : '\n') + (trailingNewline ? (crlf ? '\r\n' : '\n') : '');
  fs.writeFileSync(abs, out);
  console.log(`OK ${f.path} +${f.edits.reduce((n, e) => n + e.lines.length, 0)}`);
}
console.log('TOTAL +' + totalAdded);
