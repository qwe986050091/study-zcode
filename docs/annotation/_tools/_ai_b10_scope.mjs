import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/AI-deep-b10/_files.txt';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const kept = lines.filter(l => l.trim() !== 'packages/ai/src/generate-object/stream-object.ts');
fs.writeFileSync(p, kept.join('\n'));
console.log('KEPT', kept.filter(Boolean).length);
