import fs from 'node:fs';
// 1) own weak 的文件分布
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-exemptions.json', 'utf8'));
const up = new Map(ex.files.map((f) => [f.file, new Set(f.items.map((i) => i.line))]));
const per = [];
for (const r of q.rows) {
  const s = up.get(r.path) || new Set();
  const n = (r.weakLines || []).filter((w) => !s.has(w.line)).length;
  if (n) per.push({ path: r.path, n, total: (r.weakLines || []).length });
}
per.sort((a, b) => b.n - a.n);
console.log('OWN-WEAK FILES');
for (const p of per.slice(0, 12)) console.log(`${p.path}\t${p.n}\t${p.total}`);
console.log(`files=${per.length} sum=${per.reduce((s, x) => s + x.n, 0)}`);

// 2) 尾部文件里未覆盖最多的函数
for (const f of ['src/config.c', 'src/valkey-cli.c']) {
  const md = fs.readFileSync('d:/code/_annot_baseline/tail-inventory.md', 'utf8').split('\n');
  let on = false;
  const rows = [];
  for (const line of md) {
    if (line.startsWith('## ')) on = line.includes(f);
    if (!on || !line.startsWith('| `')) continue;
    const p = line.split('|').map((x) => x.trim());
    rows.push({ name: p[1].replace(/`/g, ''), span: p[2], units: +p[3], unc: +p[4] });
  }
  rows.sort((a, b) => b.unc - a.unc);
  console.log(`\nTOP FUNCS ${f}`);
  for (const r of rows.slice(0, 10)) console.log(`${r.name}\t${r.span}\t${r.units}\t${r.unc}`);
}
