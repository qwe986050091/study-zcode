// 一次性测量脚本：统计 drizzle-orm monorepo 各包生产源文件规模与注释密度
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\drizzle-orm';
const PKGS = ['drizzle-orm', 'drizzle-kit', 'drizzle-zod', 'drizzle-seed', 'drizzle-valibot', 'drizzle-typebox', 'drizzle-arktype', 'eslint-plugin-drizzle'];

const EXCLUDE_DIR = new Set(['node_modules', 'dist', 'tests', 'type-tests', '__tests__', 'coverage', 'build', 'scripts']);
const INCLUDE_EXT = new Set(['.ts', '.tsx']);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      if (!INCLUDE_EXT.has(path.extname(e.name))) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(e.name)) continue;
      if (e.name.endsWith('.d.ts')) continue;
      out.push(p);
    }
  }
}

function stats(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let total = lines.length, blank = 0, comment = 0, code = 0, inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { blank++; continue; }
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlock = true;
    }
    if (isComment) comment++;
    else code++;
  }
  return { total, blank, comment, code };
}

function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

const rows = [];
for (const pkg of PKGS) {
  const dir = path.join(ROOT, pkg, 'src');
  if (!fs.existsSync(dir)) { rows.push({ pkg, files: 0, lines: 0, code: 0, comment: 0, over800: 0, ratios: [], big: [] }); continue; }
  const files = [];
  walk(dir, files);
  let lines = 0, code = 0, comment = 0, over800 = 0;
  const ratios = []; const big = [];
  for (const f of files) {
    const s = stats(f);
    lines += s.total; code += s.code; comment += s.comment;
    if (s.total >= 800) { over800++; big.push({ f: path.relative(ROOT, f), total: s.total, comment: s.comment, code: s.code }); }
    ratios.push({ f: path.relative(ROOT, f), ratio: s.code ? s.comment / s.code : 0, comment: s.comment, code: s.code, total: s.total });
  }
  rows.push({ pkg, files: files.length, lines, code, comment, over800, ratios, big });
}

let T = { files: 0, lines: 0, code: 0, comment: 0, over800: 0 };
console.log('pkg\tfiles\tlines\tcode\tcomment\tratio\tmedRatio\tover800');
for (const r of rows) {
  T.files += r.files; T.lines += r.lines; T.code += r.code; T.comment += r.comment; T.over800 += r.over800;
  if (!r.files) continue;
  const ratio = (r.comment / r.code * 100).toFixed(1);
  const med = (median(r.ratios.map(x => x.ratio)) * 100).toFixed(1);
  console.log(`${r.pkg}\t${r.files}\t${r.lines}\t${r.code}\t${r.comment}\t${ratio}%\t${med}%\t${r.over800}`);
}
console.log(`TOTAL\t${T.files}\t${T.lines}\t${T.code}\t${T.comment}\t${(T.comment / T.code * 100).toFixed(1)}%\t-\t${T.over800}`);

// 全局中位数与低于 30% 的缺口
const all = rows.flatMap(r => r.ratios).filter(x => x.code > 0);
console.log('\n全局文件级中位注释密度: ' + (median(all.map(x => x.ratio)) * 100).toFixed(2) + '%');
const below = all.filter(x => x.ratio < 0.30);
let need = 0;
for (const x of below) need += Math.max(0, Math.ceil(x.code * 0.30) - x.comment);
console.log(`低于30%的文件数: ${below.length} / ${all.length}, 缺口总行数(按 code*30%-comment): ${need}`);

// 每包 TOP 大文件
console.log('\n=== 800 行以上文件（按包） ===');
for (const r of rows) {
  if (!r.over800) continue;
  console.log(`\n-- ${r.pkg} (${r.over800}) --`);
  r.big.sort((a, b) => b.total - a.total).forEach(b => console.log(`${b.total}\t${(b.comment / b.code * 100).toFixed(1)}%\t${b.f}`));
}

// 每包密度最差 10 个文件
console.log('\n=== 每包注释密度最低的 10 个文件 ===');
for (const r of rows) {
  if (!r.files) continue;
  console.log(`\n-- ${r.pkg} --`);
  r.ratios.sort((a, b) => a.ratio - b.ratio).slice(0, 10).forEach(b => console.log(`${(b.ratio * 100).toFixed(1)}%\t${b.total}\t${b.f}`));
}
