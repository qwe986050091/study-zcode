import fs from 'node:fs';

const file = process.argv[2];
const win = Number(process.argv[3] ?? 80);
const step = Number(process.argv[4] ?? 40);
const lines = fs.readFileSync(file, 'utf8').split('\n');

const isComment = (l) => /^\s*\/\//.test(l);
const isBlank = (l) => l.trim() === '';
const codeLines = lines.filter((l) => !isBlank(l) && !isComment(l)).length;

const rows = [];
for (let start = 0; start < lines.length; start += step) {
  const slice = lines.slice(start, start + win);
  if (slice.length < Math.min(win, 40)) break;
  let c = 0;
  let n = 0;
  for (const l of slice) {
    if (isComment(l)) c += 1;
    else if (!isBlank(l)) n += 1;
  }
  if (n < 15) continue;
  rows.push({ start: start + 1, end: start + slice.length, ratio: c / n, c, n });
}
rows.sort((a, b) => a.ratio - b.ratio);
console.log(`total lines=${lines.length} code=${codeLines}`);
for (const r of rows.slice(0, 25)) {
  console.log(`${r.start}-${r.end}\tratio=${(r.ratio * 100).toFixed(1)}%\tc=${r.c}\tn=${r.n}`);
}
