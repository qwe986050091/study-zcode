import fs from 'node:fs';

const files = fs.readFileSync('ZC-deep-b167-files.txt', 'utf8').trim().split(/\r?\n/).filter(Boolean);
let total = 0;
for (const f of files) {
  const p = 'D:/code/ZCode/' + f;
  const src = fs.readFileSync(p, 'utf8').split('\n');
  let code = 0;
  let comment = 0;
  for (const line of src) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) comment += 1;
    else code += 1;
  }
  const target = Math.round(code * 0.314) - comment;
  total += target;
  console.log(String(target).padStart(4), 'code=', String(code).padStart(4), 'comment=', String(comment).padStart(4), 'pct=', ((comment / code) * 100).toFixed(2), f);
}
console.log('TOTAL', total);






