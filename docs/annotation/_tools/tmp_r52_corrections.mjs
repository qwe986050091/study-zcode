import fs from 'node:fs';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const all = [...load('R52-claim-sample.json').sample, ...load('R52-layer-biran.json'), ...load('R52-layer-yilv-orm.json'), ...load('R52-layer-yilv-kit.json')];
const v = new Map();
for (const f of ['R52-claim-results.tsv', 'R52-layer-results.tsv']) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const [k, x] = line.split('\t');
    if (!k) continue;
    if (x === '不成立') v.set(k, '不成立');
    else if (!v.has(k)) v.set(k, x);
  }
}
const seen = new Set();
const bad = [];
for (const c of all) {
  if (v.get(c.key) !== '不成立') continue;
  const id = c.file + ':' + c.line;
  if (seen.has(id)) continue;
  seen.add(id);
  bad.push({ key: c.key, file: c.file, line: c.line, seg: c.seg });
}
bad.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
fs.writeFileSync('R52-errors.json', JSON.stringify(bad, null, 2), 'utf8');
console.log('error occurrences', bad.length, 'distinct keys', new Set(bad.map((b) => b.key)).size);
for (const b of bad) console.log(`${b.key}\t${b.file}:${b.line}\t${b.seg.slice(0, 40)}`);
