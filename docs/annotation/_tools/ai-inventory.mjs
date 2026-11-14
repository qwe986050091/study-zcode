// vercel/ai 仓库度量：按包统计生产源文件、行数、800+ 行文件数、注释行/代码行中位数。
// 用法：node ai-inventory.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/ai';
const PKGS = path.join(REPO, 'packages');
const EXCL_DIR = /(^|[\\/])(node_modules|dist|build|\.next|coverage|__snapshots__|fixtures|__fixtures__|e2e|examples?|demo|docs)([\\/]|$)/i;
const EXCL_FILE = /(\.test\.|\.spec\.|\.d\.ts$|\.stories\.|\.mdx?$|\.json$|\.snap$)/i;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCL_DIR.test(path.relative(REPO, p) + '/')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !EXCL_FILE.test(e.name)) {
      out.push(p);
    }
  }
}

function stat(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let blank = 0;
  let comment = 0;
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      blank++;
      continue;
    }
    if (inBlock) {
      comment++;
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//')) {
      comment++;
      continue;
    }
    if (t.startsWith('/*')) {
      comment++;
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('*')) {
      comment++;
      continue;
    }
  }
  const total = lines.length - (text.endsWith('\n') ? 1 : 0);
  const code = total - blank - comment;
  return { total, blank, comment, code };
}

const rows = [];
for (const pkg of fs.readdirSync(PKGS, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const root = path.join(PKGS, pkg.name);
  const files = [];
  walk(root, files);
  if (!files.length) continue;
  let total = 0;
  let code = 0;
  let comment = 0;
  let big = 0;
  const ratios = [];
  for (const f of files) {
    const s = stat(f);
    total += s.total;
    code += s.code;
    comment += s.comment;
    if (s.total >= 800) big++;
    if (s.code > 0) ratios.push(s.comment / s.code);
  }
  ratios.sort((a, b) => a - b);
  const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
  rows.push({ pkg: pkg.name, files: files.length, total, code, comment, ratio: comment / code, med, big });
}

rows.sort((a, b) => b.code - a.code);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('package', 24) + pad('files', 7) + pad('lines', 9) + pad('code', 9) + pad('cmt', 9) + pad('cmt/code', 10) + pad('median', 9) + '>=800');
  for (const r of rows) {
    console.log(
      pad(r.pkg, 24) +
        pad(r.files, 7) +
        pad(r.total, 9) +
        pad(r.code, 9) +
        pad(r.comment, 9) +
        pad((r.ratio * 100).toFixed(1) + '%', 10) +
        pad((r.med * 100).toFixed(1) + '%', 9) +
        r.big,
    );
  }
  const sum = rows.reduce((a, r) => ({ files: a.files + r.files, code: a.code + r.code, comment: a.comment + r.comment }), { files: 0, code: 0, comment: 0 });
  console.log(`TOTAL packages=${rows.length} files=${sum.files} code=${sum.code} comment=${sum.comment} ratio=${(sum.comment / sum.code * 100).toFixed(1)}%`);
}
