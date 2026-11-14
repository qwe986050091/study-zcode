import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const segs = [[1, 600], [601, 1184], [1185, lines.length]];
for (const [a, b] of segs) {
  let code = 0, comment = 0;
  for (let i = a - 1; i < b && i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('//')) comment++;
    else code++;
  }
  console.log(`${a}-${b} code=${code} comment=${comment} need=${Math.max(0, Math.ceil(0.3 * code) - comment)}`);
}
let code = 0, comment = 0;
for (const l of lines) {
  const t = l.trim();
  if (!t) continue;
  if (t.startsWith('//')) comment++; else code++;
}
console.log(`ALL code=${code} comment=${comment} need=${Math.max(0, Math.ceil(0.3 * code) - comment)} total=${lines.length}`);
