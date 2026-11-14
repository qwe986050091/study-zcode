// 撤销本批插入：按 b1.json 的注释原文逐行删除，保留其余字节与 EOL 不变。
// 用途：锚点文件在开工前已带未提交改动时，退回本批改动而不动他人的工作区状态。
import fs from 'node:fs';

const [batch, file] = process.argv.slice(2);
const E = JSON.parse(fs.readFileSync(batch, 'utf8'));
const mine = new Set();
for (const arr of Object.values(E)) for (const s of arr) mine.add(s.trim());

const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
const kept = lines.filter((l) => !mine.has(l.trim()));
console.log('removed', lines.length - kept.length, 'of', mine.size, 'expected');
fs.writeFileSync(file, kept.join(eol));
