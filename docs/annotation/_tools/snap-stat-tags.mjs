import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let inSnap = false;
let snapCode = 0;
let outCode = 0;
let outComment = 0;
let starts = 0;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (inSnap) {
    snapCode++;
    if (t === '"' || t === '");' || t.endsWith('"') && (t === '"' || t.endsWith('");'))) inSnap = false;
    if (t.endsWith('"') && !t.includes('@"')) inSnap = false;
    continue;
  }
  if (t.includes('@"') && !/@"[^"]*"$/.test(t)) {
    inSnap = true;
    starts++;
    snapCode++;
    continue;
  }
  if (!t) continue;
  if (t.startsWith('//')) outComment++;
  else outCode++;
}
console.log({ starts, snapCode, outCode, outComment, total: lines.length });
