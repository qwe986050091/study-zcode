// 按 {行号: 新正文} 原地改写注释行正文，保留缩进与 `//`，不改代码、不增删行。
import fs from 'node:fs';

const FILE = 'd:/code/ZCode/packages/services/src/oauth/oauthService.ts';
const MAP = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_oa-fix.json', 'utf8'));
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
for (const [k, text] of Object.entries(MAP)) {
  const idx = Number(k) - 1;
  const m = lines[idx].match(/^(\s*)\/\//);
  if (!m) throw new Error(`line ${k} 不是注释行: ${lines[idx]}`);
  lines[idx] = `${m[1]}//${text.startsWith(' ') ? '' : ' '}${text}`;
}
fs.writeFileSync(FILE, lines.join('\n'));
console.log('rewrote', Object.keys(MAP).length, 'lines');
