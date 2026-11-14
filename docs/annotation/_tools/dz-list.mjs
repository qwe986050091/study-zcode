// 输出指定阶段/前缀的文件明细，用于选批
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/opensource/drizzle-orm';
const EXD = new Set(['node_modules', 'dist', 'tests', 'type-tests', '__tests__', 'coverage', 'build', 'scripts', 'datasets']);
function walk(d, o) {
  if (fs.statSync(d).isFile()) { o.push(d); return; }
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!EXD.has(e.name)) walk(p, o); } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) o.push(p); } }
function st(f) {
  const L = fs.readFileSync(f, 'utf8').split(/\r?\n/); if (L[L.length - 1] === '') L.pop();
  let total = L.length, blank = 0, com = 0, inB = false;
  for (const r of L) { const t = r.trim(); if (!t) { blank++; continue; } let c = false; if (inB) { c = true; if (t.includes('*/')) inB = false; } else if (t.startsWith('//')) c = true; else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inB = true; } if (c) com++; }
  const code = total - blank - com;
  return { total, code, com, need: Math.max(0, Math.ceil(code * 0.32) - com), ratio: code ? com / code * 100 : 0 };
}
const prefix = process.argv[2] || 'drizzle-orm/src/';
const dirs = process.argv.slice(3);
const files = [];
for (const d of dirs.length ? dirs : [process.argv[2]]) { const p = path.join(ROOT, d); if (fs.existsSync(p)) walk(p, files); }
const rows = files.map(f => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), ...st(f) })).filter(r => r.rel.startsWith(prefix) || !prefix);
rows.sort((a, b) => a.rel.localeCompare(b.rel));
for (const r of rows) console.log(`${r.need}\t${r.total}\t${r.code}\t${r.ratio.toFixed(1)}%\t${r.rel}`);
console.log('files', rows.length, 'need32', rows.reduce((a, b) => a + b.need, 0));
