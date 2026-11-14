import fs from 'node:fs';
const L = fs.readFileSync('d:/code/opensource/valkey/src/latency.c', 'utf8').split(/\r?\n/);
const ranges = [[399, 403], [405, 410], [421, 426], [441, 444], [453, 456], [467, 474], [485, 488], [495, 498], [501, 504], [565, 568], [575, 578], [598, 601], [624, 629], [659, 662], [664, 669], [673, 678], [780, 783], [830, 842], [869, 877], [893, 896], [974, 986], [1068, 1071], [1083, 1086], [1128, 1131]];
for (const [a, b] of ranges) { for (let i = a; i <= b; i++) console.log(`${i}: ${L[i - 1]}`); console.log('--'); }
