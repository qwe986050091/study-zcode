import fs from 'node:fs';
const file = 'd:/code/_annot_baseline/_unc-hooks.txt';
const pats = process.argv.slice(2);
const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(l => l.split('\t'));
for (const r of rows) {
  const code = r[3] ?? '';
  if (!pats.length || pats.some(p => code.includes(p))) console.log(r[1] + '\t' + code);
}
