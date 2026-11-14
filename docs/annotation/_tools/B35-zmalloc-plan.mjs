// 一次性脚本：把 zmalloc.c 的未覆盖单元按顶层函数归组（与 B33-plan.mjs 同口径）
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/zmalloc.c';
const UNCOV = 'd:/code/_annot_baseline/_zmalloc-uncov.txt';
const src = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const uncov = new Map();
for (const ln of fs.readFileSync(UNCOV, 'utf8').split(/\r?\n/)) {
  if (!ln.trim()) continue;
  const parts = ln.split('\t');
  if (parts.length < 4) continue;
  uncov.set(Number(parts[1]), parts[3]);
}

const depthAtStart = new Array(src.length).fill(0);
let depth = 0;
let inBlock = false;
for (let i = 0; i < src.length; i++) {
  depthAtStart[i] = depth;
  const s = src[i];
  let j = 0;
  while (j < s.length) {
    if (inBlock) {
      const e = s.indexOf('*/', j);
      if (e === -1) { j = s.length; break; }
      inBlock = false; j = e + 2; continue;
    }
    if (s[j] === '/' && s[j + 1] === '*') { inBlock = true; j += 2; continue; }
    if (s[j] === '"' || s[j] === "'") {
      const q = s[j]; j++;
      while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
      j++; continue;
    }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') depth--;
    j++;
  }
}

const funcs = [];
for (let i = 0; i < src.length; i++) {
  if (depthAtStart[i] !== 0) continue;
  const line = src[i];
  if (!line.trim()) continue;
  if (/^\s/.test(line)) continue;
  if (/^(#|\}|\/\*|\*|\/\/)/.test(line)) continue;
  let braceLine = -1;
  for (let k = i; k < Math.min(src.length, i + 12); k++) {
    if (src[k].includes('{')) { braceLine = k; break; }
    if (src[k].trim().endsWith(';')) break;
  }
  if (braceLine === -1) continue;
  const head = src.slice(i, braceLine + 1).join(' ');
  if (!head.includes('(')) continue;
  let name = '';
  for (let k = braceLine; k >= i && !name; k--) {
    const before = src[k].slice(0, src[k].indexOf('{') === -1 ? src[k].length : src[k].indexOf('{'));
    const ms = [...before.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
    if (ms.length) name = ms[ms.length - 1][1];
  }
  if (!name) continue;
  let end = braceLine;
  for (let m = braceLine; m < src.length; m++) {
    const next = m + 1 < src.length ? depthAtStart[m + 1] : 0;
    if (next === 0) { end = m; break; }
  }
  funcs.push({ name, start: i + 1, end: end + 1 });
  i = end;
}

const writable = new Map();
let inBlk = false;
for (let i = 0; i < src.length; i++) {
  const s = src[i];
  const t = s.trim();
  let ok = !t.startsWith('#') && !t.startsWith('/*') && !t.startsWith('*') && t !== '' && !inBlk;
  if (i > 0 && src[i - 1].trimEnd().endsWith('\\')) ok = false;
  let j = 0;
  while (j < s.length) {
    if (inBlk) { const e = s.indexOf('*/', j); if (e === -1) { j = s.length; break; } inBlk = false; j = e + 2; continue; }
    if (s[j] === '/' && s[j + 1] === '*') { inBlk = true; j += 2; continue; }
    if (s[j] === '"' || s[j] === "'") { const q = s[j]; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } j++; continue; }
    j++;
  }
  writable.set(i + 1, ok);
}

const rows = [];
const outside = [];
let assigned = 0;
for (const [line, code] of uncov) {
  const f = funcs.find((x) => line >= x.start && line <= x.end);
  if (!f) { outside.push({ line, code }); continue; }
  assigned++;
  let r = rows.find((x) => x.name === f.name);
  if (!r) { r = { name: f.name, start: f.start, end: f.end, n: 0, w: 0 }; rows.push(r); }
  r.n++;
  if (writable.get(line)) r.w++;
}
rows.sort((a, b) => b.n - a.n);

console.log(`FUNCS=${funcs.length} UNCOV=${uncov.size} ASSIGNED=${assigned} OUTSIDE=${outside.length}`);
console.log('name\tuncovered\twritable\tplan\tspan');
let tn = 0, tw = 0;
for (const r of rows) {
  tn += r.n; tw += r.w;
  const plan = r.w + 3;
  console.log(`${r.name}\t${r.n}\t${r.w}\t${plan}\t${r.start}-${r.end}`);
}
console.log(`TOTAL uncovered=${tn} writable=${tw} plan=${tw + rows.length * 3}`);
console.log('--- OUTSIDE ---');
for (const o of outside) console.log(`${o.line}\t${writable.get(o.line) ? 'W' : '-'}\t${o.code}`);
