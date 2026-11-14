// top30 模板的全量 264 行做机械对照：注释 vs 紧随代码行，找出模板内“漂移”的行
import fs from 'node:fs';

const REPO = 'd:/code/opensource/valkey';
const json = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-templates-22aa802.json', 'utf8'));
const cache = new Map();
const lines = (p) => {
  if (!cache.has(p)) cache.set(p, fs.readFileSync(REPO + '/' + p, 'utf8').split('\n'));
  return cache.get(p);
};
const out = [];
for (const t of json) {
  out.push(`## ${t.tpl} (${t.n})`);
  for (const it of t.items) {
    const L = lines(it.path);
    // 找紧随其后的第一条代码行
    let nxt = '';
    for (let i = it.line; i < Math.min(L.length, it.line + 4); i++) {
      const s = L[i].trim();
      if (!s || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) continue;
      nxt = s;
      break;
    }
    out.push(`${it.path}:${it.line}\t${it.text}\t${nxt.slice(0, 110)}`);
  }
}
fs.writeFileSync('d:/code/_annot_baseline/weak-templates-all264.txt', out.join('\n'));
console.error('lines=' + out.length);
