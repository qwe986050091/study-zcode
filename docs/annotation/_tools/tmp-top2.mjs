import fs from 'node:fs';
const md = fs.readFileSync('d:/code/_annot_baseline/tail-inventory.md', 'utf8').split('\n');
let on = false;
const rows = [];
for (const l of md) {
  if (l.startsWith('## ')) on = l.includes('valkey-cli');
  if (!on) continue;
  const m = /^\| `([^`]+)` \| ([\d–]+) \| (\d+) \| (\d+) \|/.exec(l);
  if (m) rows.push({ n: m[1], span: m[2], u: +m[3], unc: +m[4] });
}
rows.sort((a, b) => b.unc - a.unc);
for (const r of rows.slice(0, 8)) console.log(`${r.n}\t${r.span}\t${r.u}\t${r.unc}`);
