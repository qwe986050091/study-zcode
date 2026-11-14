import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const files = execSync('git ls-files "src"', { cwd: REPO, encoding: 'utf8' })
  .split(/\r?\n/).filter((p) => p.endsWith('.c') && !p.startsWith('src/unit/'));
const touched = new Set(execSync('git diff --name-only c96bdec -- src', { cwd: REPO, encoding: 'utf8' })
  .split(/\r?\n/).filter((p) => p.endsWith('.c')));
const isC = (s) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(s);
const isBlank = (s) => s.trim() === '';
let tot = 0, written = 0, unwritten = 0;
const rows = [];
for (const p of files) {
  const L = fs.readFileSync(`${REPO}/${p}`, 'utf8').split(/\r?\n/);
  let w = 0, u = 0;
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim();
    if (!/^[?:]/.test(t) || t.length < 2) continue;
    if (isC(L[i])) continue;
    let j = i - 1, gaps = 0;
    while (j >= 0 && isBlank(L[j]) && gaps < 2) { j--; gaps++; }
    const ok = j >= 0 && isC(L[j]);
    if (ok) w++; else u++;
  }
  if (w + u === 0) continue;
  tot += w + u; written += w; unwritten += u;
  rows.push({ p, w, u, touched: touched.has(p) });
}
rows.sort((a, b) => b.u - a.u);
console.log(`ternary-arm lines=${tot} written=${written} unwritten=${unwritten}`);
console.log('--- touched files with unwritten arms ---');
for (const r of rows.filter((r) => r.touched && r.u > 0)) console.log(`${r.p}\twritten=${r.w}\tunwritten=${r.u}`);
console.log('--- untouched files with unwritten arms (top 15) ---');
for (const r of rows.filter((r) => !r.touched && r.u > 0).slice(0, 15)) console.log(`${r.p}\twritten=${r.w}\tunwritten=${r.u}`);
const tw = rows.filter((r) => r.touched).reduce((s, r) => s + r.w, 0);
const tu = rows.filter((r) => r.touched).reduce((s, r) => s + r.u, 0);
console.log(`touched-total written=${tw} unwritten=${tu}`);
