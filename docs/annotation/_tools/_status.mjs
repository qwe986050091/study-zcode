// 临时状态报表：按包/方言分组统计「未开工 / 已注未达标 / 达标」
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/opensource/drizzle-orm';
const EXD = new Set(['node_modules', 'dist', 'tests', 'type-tests', '__tests__', 'coverage', 'build', 'scripts', 'datasets']);
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src', 'drizzle-zod/src', 'drizzle-valibot/src', 'drizzle-typebox/src', 'drizzle-arktype/src', 'drizzle-seed/src', 'eslint-plugin-drizzle/src'];

function walk(d, o) {
  if (!fs.existsSync(d)) return;
  if (fs.statSync(d).isFile()) { o.push(d); return; }
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!EXD.has(e.name)) walk(p, o); }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) o.push(p);
  }
}

function stat(f) {
  const L = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  if (L[L.length - 1] === '') L.pop();
  let total = L.length, blank = 0, com = 0, cjk = 0, inB = false;
  for (const r of L) {
    const t = r.trim();
    if (/[\u4e00-\u9fff]/.test(r)) cjk++;
    if (!t) { blank++; continue; }
    let c = false;
    if (inB) { c = true; if (t.includes('*/')) inB = false; }
    else if (t.startsWith('//')) c = true;
    else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inB = true; }
    if (c) com++;
  }
  const code = total - blank - com;
  return { total, code, com, cjk, need: Math.max(0, Math.ceil(code * 0.32) - com), ratio: code ? (com / code) * 100 : 100 };
}

const all = [];
for (const r of ROOTS) walk(path.join(ROOT, r), all);
const groups = new Map();
for (const f of all) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const seg = rel.split('/');
  const g = seg[0] === 'drizzle-orm' ? (seg[2] === 'src' || seg.length === 4 ? `drizzle-orm/src/${seg[2] === 'src' ? '.' : seg[2]}` : seg.slice(0, 3).join('/')) : seg.slice(0, 2).join('/');
  const s = stat(f);
  const key = seg[0] === 'drizzle-orm' ? (seg[2].includes('.') ? 'drizzle-orm/src (root)' : `drizzle-orm/src/${seg[2]}`) : seg.slice(0, 2).join('/');
  if (!groups.has(key)) groups.set(key, { unstarted: [], partial: [], done: [], need: 0 });
  const G = groups.get(key);
  if (s.need === 0) G.done.push(rel);
  else if (s.cjk === 0) { G.unstarted.push({ rel, need: s.need, ratio: s.ratio, code: s.code }); G.need += s.need; }
  else { G.partial.push({ rel, need: s.need, ratio: s.ratio, code: s.code }); G.need += s.need; }
}

console.log('group\tunstarted\tpartial\tdone\ttotal\tneed');
const rows = [...groups.entries()].sort((a, b) => (b[1].unstarted.length + b[1].partial.length) - (a[1].unstarted.length + a[1].partial.length));
for (const [k, G] of rows) {
  console.log([k, G.unstarted.length, G.partial.length, G.done.length, G.unstarted.length + G.partial.length + G.done.length, G.need].join('\t'));
}
const tot = [...groups.values()].reduce((a, G) => ({ u: a.u + G.unstarted.length, p: a.p + G.partial.length, d: a.d + G.done.length, n: a.n + G.need }), { u: 0, p: 0, d: 0, n: 0 });
console.log(`TOTAL unstarted=${tot.u} partial=${tot.p} done=${tot.d} files=${tot.u + tot.p + tot.d} need=${tot.n}`);
if (process.argv[2] === '--detail') {
  for (const [k, G] of rows) {
    if (!G.unstarted.length && !G.partial.length) continue;
    console.log(`\n## ${k}`);
    for (const x of G.unstarted) console.log(`U\t${x.need}\t${x.ratio.toFixed(1)}%\t${x.rel}`);
    for (const x of G.partial) console.log(`P\t${x.need}\t${x.ratio.toFixed(1)}%\t${x.rel}`);
  }
}
