import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const files = execSync('git ls-files src', { cwd: REPO, encoding: 'utf8' })
  .split(/\r?\n/).filter((p) => p.endsWith('.c') && !p.startsWith('src/unit/'));
const isC = (s) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(s);
const isB = (s) => s.trim() === '';
let w = 0, u = 0;
const rows = [];
for (const p of files) {
  const L = fs.readFileSync(`${REPO}/${p}`, 'utf8').split(/\r?\n/);
  let a = 0, b = 0;
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim();
    if (!t.startsWith('"') || isC(L[i])) continue;
    let j = i - 1, g = 0;
    while (j >= 0 && isB(L[j]) && g < 2) { j--; g++; }
    if (j >= 0 && isC(L[j])) { a++; w++; } else { b++; u++; }
  }
  if (a + b) rows.push(`${p}\tw=${a}\tu=${b}`);
}
console.log(`string-frag lines with comment above=${w} without=${u}`);
rows.sort((x, y) => +y.split('u=')[1] - +x.split('u=')[1]);
console.log(rows.slice(0, 12).join('\n'));
