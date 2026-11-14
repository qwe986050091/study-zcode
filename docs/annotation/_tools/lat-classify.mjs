import fs from 'node:fs';
const REPO = 'd:/code/opensource/valkey';
const L = fs.readFileSync(`${REPO}/src/latency.c`, 'utf8').split(/\r?\n/);
const nums = fs.readFileSync('d:/code/_annot_baseline/_lat-uncov.txt', 'utf8').trim().split(/\r?\n/)
  .map((l) => +l.split('\t')[1]);
const str = nums.filter((n) => L[n - 1].trim().startsWith('"'));
const tern = nums.filter((n) => /^[?:]/.test(L[n - 1].trim()));
console.log('uncovered', nums.length, 'stringfrag', str.length, 'ternary', tern.length);
console.log('string:', str.join(','));
console.log('ternary:', tern.join(','));
