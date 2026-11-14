import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync('R52-claim-sample.json', 'utf8'));
const v = new Map(fs.readFileSync('R52-claim-results.tsv', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')));
const seen = new Set();
for (const c of plan.sample) {
  const x = v.get(c.key);
  if (!x || x === '成立' || seen.has(c.key)) continue;
  seen.add(c.key);
  console.log('| `' + c.key + '` | ' + c.file + ':' + c.line + ' | ' + c.seg + ' | ' + x + ' |');
}
