// ZCode 深注口径的快速测量器（与 deep-density.mjs 的 measure() 逐字符逻辑严格一致）。
// 用途：全仓规模下 deep-density 每文件 spawn 一次 git diff 过慢，这里只做「当前状态」度量，
// 不涉及基线 diff；批次验收仍必须回到 deep-density.mjs。
// 用法：node zc-measure.mjs [--repo D:/code/ZCode] [--out xxx.json] [--excludeDefaults 0]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {
  repo: 'D:/code/ZCode',
  out: '',
  threshold: 30,
  skipExclude: false,
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo') opt.repo = argv[++i];
  else if (argv[i] === '--out') opt.out = argv[++i];
  else if (argv[i] === '--threshold') opt.threshold = Number(argv[++i]);
  else if (argv[i] === '--skipExclude') opt.skipExclude = true;
}

const ROOTS = ['apps', 'packages', 'scripts', 'docs'];
const WALK_SKIP = new Set(['target', 'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.tmp']);

// 与任务书口径一致：仅生产代码。
const defaultExcludes = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /(^|\/)(__tests__|tests|test|fixtures|examples|__mocks__|mocks)(\/|$)/,
  /(^|\/)generated(\/|$)/,
  /\.generated\.tsx?$/,
  /\.gen\.tsx?$/,
  /\.d\.ts$/,
  /(^|\/)wdio\.conf\.ts$/,
];

function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') break;
    out += c;
    i++;
  }
  return out;
}

function measure(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let comment = 0;
  let blank = 0;
  let block = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') { blank++; continue; }
    if (block) { comment++; if (t.includes('*/')) block = false; continue; }
    if (t.startsWith('/*')) { comment++; if (!t.includes('*/')) block = true; continue; }
    if (t.startsWith('//') || t.startsWith('#')) { comment++; continue; }
    const stripped = stripStrings(t);
    if (stripped.includes('/*') && !stripped.includes('*/')) block = true;
  }
  const total = lines.length;
  const code = total - blank - comment;
  return { total, blank, comment, code };
}

const files = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (WALK_SKIP.has(ent.name)) continue;
      walk(p);
    } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) {
      const rel = path.relative(opt.repo, p).replace(/\\/g, '/');
      if (!opt.skipExclude && defaultExcludes.some((re) => re.test(rel))) continue;
      files.push({ abs: p, rel });
    }
  }
}
for (const r of ROOTS) walk(path.join(opt.repo, r));

const rows = [];
for (const f of files) {
  const m = measure(fs.readFileSync(f.abs, 'utf8'));
  const measured = (m.comment / m.code) * 100;
  const need = Math.max(0, Math.ceil((m.code * opt.threshold) / 100) - m.comment);
  rows.push({
    path: f.rel,
    total: m.total,
    blank: m.blank,
    comment: m.comment,
    code: m.code,
    ratio: (m.comment / m.total) * 100,
    codeRatio: m.code ? measured : 100,
    measured: m.code ? measured : 100,
    need,
  });
}

rows.sort((a, b) => a.measured - b.measured || a.path.localeCompare(b.path));
const below = rows.filter((r) => r.measured + 1e-9 < opt.threshold);
const needLines = below.reduce((n, r) => n + r.need, 0);
const ratios = rows.map((r) => r.measured).sort((a, b) => a - b);
const min = ratios.length ? ratios[0] : 0;
const median = ratios.length
  ? ratios.length % 2
    ? ratios[(ratios.length - 1) / 2]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
  : 0;

console.log(`SUMMARY files=${rows.length} coreBelow30=${below.length} needLines=${needLines} min=${min.toFixed(2)} median=${median.toFixed(2)}`);

if (opt.out) {
  fs.writeFileSync(opt.out, JSON.stringify({ threshold: opt.threshold, rows }, null, 2));
  console.log('json=' + opt.out);
}
