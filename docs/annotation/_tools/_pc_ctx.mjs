import fs from 'node:fs';
const L = fs.readFileSync('D:/code/_annot_baseline/ZC-lc51/orig/packages/desktop/src/main/index.ts', 'utf8').split(/\r?\n/);
for (const [a, b] of [[370, 377], [1769, 1776], [2265, 2272], [2505, 2512], [3139, 3145]]) {
  console.log('==== ' + a + '..' + b);
  for (let i = a - 1; i < b; i++) {
    const t = L[i].trim();
    const marks = [];
    if (/^(?:\[[^\]]{1,8}\]|INV-\d+|STEP\b|TODO\b|FIXME\b|NOTE\b|HACK\b|XXX\b)/.test(t.replace(/^\/\/\s?/, ''))) marks.push('STRUCT');
    if ((t.replace(/^\/\/\s?/, '').match(/[。；]/g) || []).length >= 2) marks.push('POEM2+');
    console.log(String(i + 1).padStart(5), marks.join(','), '|', L[i].slice(0, 90));
  }
}
