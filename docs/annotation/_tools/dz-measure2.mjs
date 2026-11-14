// 二次测量：排除项后缺口 + 方言同构盘点
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\drizzle-orm';
const EXCLUDE_FILES = new Set([
  'drizzle-seed/src/datasets/lastNames.ts',
  'drizzle-seed/src/datasets/cityNames.ts',
  'drizzle-seed/src/datasets/firstNames.ts',
  'drizzle-seed/src/datasets/adjectives.ts',
  'drizzle-seed/src/datasets/loremIpsumSentences.ts',
  'drizzle-seed/src/datasets/phonesInfo.ts',
  'drizzle-seed/src/datasets/companyNameSuffixes.ts',
  'drizzle-seed/src/datasets/emailDomains.ts',
  'drizzle-seed/src/datasets/states.ts',
  'drizzle-kit/src/utils/words.ts',
]);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'tests', 'type-tests', '__tests__', 'coverage', 'build', 'scripts', 'datasets']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
}
function stats(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  let total = lines.length, blank = 0, comment = 0, inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { blank++; continue; }
    let c = false;
    if (inBlock) { c = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) c = true;
    else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inBlock = true; }
    if (c) comment++;
  }
  return { total, blank, comment, code: total - blank - comment };
}

const groups = ['drizzle-orm', 'drizzle-kit', 'drizzle-zod', 'drizzle-valibot', 'drizzle-typebox', 'drizzle-arktype', 'drizzle-seed', 'eslint-plugin-drizzle'];
let agg = { files: 0, lines: 0, code: 0, comment: 0, need: 0, below: 0, ok: 0 };
const perGroup = [];
for (const g of groups) {
  const dir = path.join(ROOT, g, 'src');
  if (!fs.existsSync(dir)) continue;
  const files = []; walk(dir, files);
  const row = { g, files: 0, lines: 0, code: 0, comment: 0, need: 0, below: 0, ok: 0, small: 0, tiny: 0 };
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (EXCLUDE_FILES.has(rel)) continue;
    const s = stats(f);
    row.files++; row.lines += s.total; row.code += s.code; row.comment += s.comment;
    if (s.total <= 15) row.tiny++;
    else if (s.total <= 60) row.small++;
    const need = Math.max(0, Math.ceil(s.code * 0.30) - s.comment);
    if (need > 0) { row.below++; row.need += need; } else row.ok++;
  }
  perGroup.push(row);
  for (const k of ['files', 'lines', 'code', 'comment', 'need', 'below', 'ok']) agg[k] += row[k];
}
console.log('group\tfiles\tlines\tcode\tcomment\tneedLines\tbelow30\tok\t<=15行\t16-60行');
for (const r of perGroup) console.log(`${r.g}\t${r.files}\t${r.lines}\t${r.code}\t${r.comment}\t${r.need}\t${r.below}\t${r.ok}\t${r.tiny}\t${r.small}`);
console.log(`TOTAL\t${agg.files}\t${agg.lines}\t${agg.code}\t${agg.comment}\t${agg.need}\t${agg.below}\t${agg.ok}`);

// 方言同构盘点：对比四个方言 core 的文件名集合
const dialects = ['pg-core', 'mysql-core', 'sqlite-core', 'singlestore-core', 'gel-core'];
const sets = {};
for (const d of dialects) {
  const dir = path.join(ROOT, 'drizzle-orm', 'src', d);
  const files = []; if (fs.existsSync(dir)) walk(dir, files);
  sets[d] = new Set(files.map(f => path.relative(dir, f).replace(/\\/g, '/')));
}
const all = new Set(); for (const d of dialects) for (const f of sets[d]) all.add(f);
console.log('\n=== 方言 core 文件交集（>=3 个方言同名） ===');
const shared = [];
for (const f of [...all]) {
  const who = dialects.filter(d => sets[d].has(f));
  if (who.length >= 3) shared.push({ f, who });
}
shared.sort((a, b) => a.f.localeCompare(b.f));
for (const s of shared) console.log(`${s.f}\t${s.who.join(',')}`);
console.log('共享文件名数:', shared.length, '/ 并集', all.size);
