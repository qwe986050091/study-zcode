import fs from 'node:fs';
const base = 'd:/code/_annot_baseline/';
const q = JSON.parse(fs.readFileSync(base + 'quality-now.json', 'utf8'));
for (const f of ['_zstd-now4.json', '_aof-now4.json']) {
  const j = JSON.parse(fs.readFileSync(base + f, 'utf8'));
  const r = (j.rows || [j])[0];
  const i = q.rows.findIndex((x) => x.path === r.path);
  if (i < 0) throw new Error('row not found: ' + r.path);
  q.rows[i] = r;
  console.log(`update ${r.path}: ${r.coverage.toFixed(1)}% / ${r.branchCoverage}%`);
}
fs.writeFileSync(base + 'quality-now.json', JSON.stringify(q, null, 1));
console.log('quality-now.json written');
