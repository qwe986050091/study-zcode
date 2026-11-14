import fs from 'node:fs';
const B = 'd:/code/_annot_baseline/';
const edits = JSON.parse(fs.readFileSync(B + 'R57/edits.json', 'utf8'));
const revert = fs.readFileSync(B + 'R57/revert-dup.mjs', 'utf8');
const texts = [...revert.matchAll(/'([^']*[\u4e00-\u9fff][^']*)'/g)].map((m) => m[1]);
const flat = [];
for (const f of edits.files) for (const e of f.edits) for (const c of e.comments) flat.push({ file: f.path, line: e.line, anchor: e.anchor, text: c });
const targets = flat.filter((x) => texts.includes(x.text));
console.log('matched', targets.length);
for (const t of targets) {
  const p = B + 'R57/orig/' + t.file;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = t.line - 1;
  console.log('\n### ' + t.file + ':' + t.line + '  ' + t.anchor);
  for (let k = Math.max(0, i - 3); k <= i + 1; k++) {
    const mark = k === i ? '>>' : (k === i - 1 ? '  ' : '  ');
    console.log(mark + String(k + 1).padStart(5) + ' ' + lines[k]);
  }
  console.log('   + ' + t.text);
}
