// 三次测量：分阶段缺口、TOP 文件、同构族明细
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\drizzle-orm';
const EX = new Set([
  'drizzle-seed/src/datasets/lastNames.ts', 'drizzle-seed/src/datasets/cityNames.ts',
  'drizzle-seed/src/datasets/firstNames.ts', 'drizzle-seed/src/datasets/adjectives.ts',
  'drizzle-seed/src/datasets/loremIpsumSentences.ts', 'drizzle-seed/src/datasets/phonesInfo.ts',
  'drizzle-seed/src/datasets/companyNameSuffixes.ts', 'drizzle-seed/src/datasets/emailDomains.ts',
  'drizzle-seed/src/datasets/states.ts',
]);
const EXD = new Set(['node_modules', 'dist', 'tests', 'type-tests', '__tests__', 'coverage', 'build', 'scripts', 'datasets']);
function walk(d, o) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!EXD.has(e.name)) walk(p, o); } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) o.push(p); } }
function st(f) {
  const L = fs.readFileSync(f, 'utf8').split(/\r?\n/); if (L[L.length - 1] === '') L.pop();
  let total = L.length, blank = 0, com = 0, inB = false;
  for (const r of L) { const t = r.trim(); if (!t) { blank++; continue; } let c = false; if (inB) { c = true; if (t.includes('*/')) inB = false; } else if (t.startsWith('//')) c = true; else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inB = true; } if (c) com++; }
  return { total, code: total - blank - com, com };
}
const recs = [];
for (const g of ['drizzle-orm', 'drizzle-kit', 'drizzle-zod', 'drizzle-valibot', 'drizzle-typebox', 'drizzle-arktype', 'drizzle-seed', 'eslint-plugin-drizzle']) {
  const dir = path.join(ROOT, g, 'src'); if (!fs.existsSync(dir)) continue;
  const fsx = []; walk(dir, fsx);
  for (const f of fsx) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (EX.has(rel)) continue;
    const s = st(f);
    recs.push({ rel, ...s, need30: Math.max(0, Math.ceil(s.code * 0.30) - s.com), need32: Math.max(0, Math.ceil(s.code * 0.32) - s.com) });
  }
}
const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
console.log(`FILES=${recs.length} LINES=${sum(recs, 'total')} CODE=${sum(recs, 'code')} COMMENT=${sum(recs, 'com')}`);
console.log(`need@30=${sum(recs, 'need30')} need@32=${sum(recs, 'need32')} below30=${recs.filter(r => r.need30 > 0).length} ok=${recs.filter(r => r.need30 === 0).length}`);

function phase(rel) {
  if (rel.startsWith('drizzle-kit/')) return 'P5 drizzle-kit 迁移生成';
  if (rel.startsWith('drizzle-zod/') || rel.startsWith('drizzle-valibot/') || rel.startsWith('drizzle-typebox/') || rel.startsWith('drizzle-arktype/')) return 'P6 校验集成';
  if (rel.startsWith('drizzle-seed/') || rel.startsWith('eslint-plugin-drizzle/')) return 'P7 附属包';
  if (/drizzle-orm\/src\/(sql|query-builders)\//.test(rel) || /drizzle-orm\/src\/(table|column|relations|session|migrator|entity|utils|subquery|alias|casing|errors|logger|operations|primary-key|view-common|selection-proxy|query-promise|runnable-query|column-builder|table\.utils|tracing|batch|version)\.ts$/.test(rel)) return 'P1 SQL/核心抽象';
  if (/drizzle-orm\/src\/(pg-core|mysql-core|sqlite-core|singlestore-core|gel-core)\//.test(rel)) return 'P2 方言 core';
  return 'P4 驱动适配层';
}
const byPhase = {};
for (const r of recs) { const p = phase(r.rel); (byPhase[p] ??= []).push(r); }
const order = ['P1 SQL/核心抽象', 'P2 方言 core', 'P4 驱动适配层', 'P5 drizzle-kit 迁移生成', 'P6 校验集成', 'P7 附属包'];
console.log('\nphase\tfiles\tlines\tcode\tcomment\tneed30\tneed32\tbelow30');
for (const p of order) { const a = byPhase[p] || []; console.log(`${p}\t${a.length}\t${sum(a, 'total')}\t${sum(a, 'code')}\t${sum(a, 'com')}\t${sum(a, 'need30')}\t${sum(a, 'need32')}\t${a.filter(r => r.need30 > 0).length}`); }

console.log('\n=== 缺口最大的 40 个文件 ===');
[...recs].sort((a, b) => b.need32 - a.need32).slice(0, 40).forEach(r => console.log(`${r.need32}\t${r.total}\t${r.code}\t${(r.com / r.code * 100).toFixed(1)}%\t${r.rel}`));

console.log('\n=== 方言 core 中 已达标(免注) 文件 ===');
for (const r of recs.filter(r => /-core\//.test(r.rel) && r.need30 === 0)) console.log(`${r.total}\t${(r.com / r.code * 100).toFixed(0)}%\t${r.rel}`);

console.log('\n=== 方言 core 缺口合计 ===');
const dc = recs.filter(r => /-core\//.test(r.rel));
console.log(`files=${dc.length} need30=${sum(dc, 'need30')} need32=${sum(dc, 'need32')}`);

// 同构族：同名文件跨方言
console.log('\n=== 同构族（同名文件，>=3 方言）缺口 ===');
const fam = {};
for (const r of dc) { const m = r.rel.match(/drizzle-orm\/src\/(\w+-core)\/(.+)$/); if (!m) continue; (fam[m[2]] ??= []).push({ d: m[1], ...r }); }
for (const [name, arr] of Object.entries(fam).sort((a, b) => sum(b[1], 'need32') - sum(a[1], 'need32'))) {
  if (arr.length < 3) continue;
  console.log(`${name}\t${arr.map(a => `${a.d}:${a.need32}`).join(' ')}`);
}
