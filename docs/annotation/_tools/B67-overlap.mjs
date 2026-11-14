import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/VK-B67/spec.json', 'utf8'));
const have = new Set(spec[0].ops.map((o) => o.line));
const L = fs.readFileSync('d:/code/opensource/valkey/src/latency.c', 'utf8').split(/\r?\n/);
const unc = fs.readFileSync('d:/code/_annot_baseline/_lat-uncov.txt', 'utf8').trim().split(/\r?\n/)
  .map((l) => +l.split('\t')[1]);
for (const n of unc) if (L[n - 1].trim().startsWith('"') && have.has(n)) console.log('overlap', n, JSON.stringify(L[n - 1]));
