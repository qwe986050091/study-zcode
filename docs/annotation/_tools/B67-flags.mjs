import fs from 'node:fs';
const L = fs.readFileSync('d:/code/opensource/valkey/src/latency.c', 'utf8').split(/\r?\n/);
const gate = [333, 367, 402, 409, 425, 443, 455, 469, 471, 473, 487, 497, 503, 517, 567, 577, 600, 626, 628, 661, 666, 668, 675, 677, 724, 782, 797, 809, 819, 827, 833, 837, 841, 871, 873, 876, 895, 976, 980, 985, 1070, 1085, 1130];
for (const n of gate) console.log(n, L[n - 1]);
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_lat-now2.json', 'utf8')).rows[0];
console.log('--- deep weak', q.weakLines.length);
for (const w of q.weakLines) console.log(w.line, w.content);
