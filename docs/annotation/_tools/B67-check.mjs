import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/VK-B67/spec.json', 'utf8'));
const have = new Set(spec[0].ops.map((o) => o.line));
const L = fs.readFileSync('d:/code/opensource/valkey/src/latency.c', 'utf8').split(/\r?\n/);
const unc = fs.readFileSync('d:/code/_annot_baseline/_lat-uncov.txt', 'utf8').trim().split(/\r?\n/)
  .map((l) => +l.split('\t')[1]);
const str = new Set(unc.filter((n) => L[n - 1].trim().startsWith('"') && n !== 783));
console.log('unc', unc.length, 'have', have.size, 'string-exempt', str.size);
console.log('missing', unc.filter((l) => !have.has(l) && !str.has(l)).join(','));
console.log('extra', [...have].filter((l) => !unc.includes(l)).join(','));
