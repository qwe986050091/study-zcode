import fs from 'node:fs';
const files = [
  'libs/langgraph/langgraph/pregel/_runner.py',
  'libs/langgraph/langgraph/pregel/_executor.py',
  'libs/langgraph/langgraph/pregel/_retry.py',
];
const ROOT = 'd:/code/opensource/langgraph';
function measure(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let blank = 0, comment = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') { blank++; continue; }
    if (t.startsWith('#')) { comment++; continue; }
  }
  const total = lines.length;
  const code = total - blank - comment;
  const density = code === 0 ? 0 : comment / code;
  const need30 = Math.max(0, Math.ceil(code * 0.30) - comment);
  const target32 = Math.max(0, Math.ceil(code * 0.32) - comment);
  return { total, blank, comment, code, density, need30, target32 };
}
const out = [];
let rows = [];
for (const rel of files) {
  const m = measure(`${ROOT}/${rel}`);
  rows.push({ rel: rel.split('/').pop(), ...m, d: (m.density * 100).toFixed(2) + '%' });
  out.push(`${rel}\t${m.total}`);
}
console.table(rows);
fs.writeFileSync('d:/code/_annot_baseline/LG-deep-b07/_files.txt', out.join('\n') + '\n', 'utf8');
