// vercel/ai 深度注释范围测算：给定 include 规则，输出逐文件缺口、总量与批次建议。
// 用法：node ai-scope.mjs [--files] [--json]
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/ai';
const PKGS = path.join(REPO, 'packages');

// 核心范围：SDK 主干 + provider 抽象 + UI hooks/传输层 + 编排运行时
const INCLUDE = [
  'ai',
  'provider-utils',
  'provider',
  'react',
  'rsc',
  'svelte',
  'vue',
  'angular',
  'workflow',
  'workflow-harness',
  'mcp',
  'gateway',
  'open-responses',
  'otel',
  'langchain',
  'llamaindex',
  'harness',
];

const EXCL_DIR = /(^|[\\/])(node_modules|dist|build|\.next|coverage|__snapshots__|fixtures|__fixtures__|test|tests)([\\/]|$)/i;
const EXCL_FILE = /(\.test\.|\.spec\.|\.test-d\.|\.d\.ts$|\.stories\.|\.mdx?$|\.json$|\.snap$)/i;

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
    }
  }
  const total = lines.length - (text.endsWith('\n') ? 1 : 0);
  return { total, code: total - blank - comment, comment };
}

const rows = [];
for (const pkg of INCLUDE) {
  const root = path.join(PKGS, pkg);
  if (!fs.existsSync(root)) continue;
  const files = [];
  walk(path.join(root, 'src'), files);
  for (const f of files) {
    const s = stat(f);
    if (s.code === 0) continue;
    const need30 = Math.max(0, Math.ceil(s.code * 0.3) - s.comment);
    const need32 = Math.max(0, Math.ceil(s.code * 0.32) - s.comment);
    rows.push({ pkg, rel: path.relative(REPO, f).replace(/\\/g, '/'), ...s, need30, need32 });
  }
}

rows.sort((a, b) => a.pkg.localeCompare(b.pkg) || b.code - a.code);

const perPkg = new Map();
for (const r of rows) {
  const a = perPkg.get(r.pkg) || { files: 0, code: 0, comment: 0, need30: 0, need32: 0, below: 0, big: 0 };
  a.files++;
  a.code += r.code;
  a.comment += r.comment;
  a.need30 += r.need30;
  a.need32 += r.need32;
  if (r.need30 > 0) a.below++;
  if (r.total >= 800) a.big++;
  perPkg.set(r.pkg, a);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, perPkg: [...perPkg] }, null, 2));
} else if (process.argv.includes('--files')) {
  for (const r of rows) {
    if (r.need30 > 0) console.log(`${r.need30}\t${r.need32}\t${r.comment}/${r.code}\t${r.rel}`);
  }
} else {
  console.log('pkg'.padEnd(20) + 'files'.padEnd(7) + 'code'.padEnd(9) + 'cmt'.padEnd(9) + 'gap30'.padEnd(8) + 'gap32'.padEnd(8) + 'below'.padEnd(7) + '>=800');
  for (const [pkg, a] of perPkg) {
    console.log(pkg.padEnd(20) + String(a.files).padEnd(7) + String(a.code).padEnd(9) + String(a.comment).padEnd(9) + String(a.need30).padEnd(8) + String(a.need32).padEnd(8) + String(a.below).padEnd(7) + a.big);
  }
  const t = [...perPkg.values()].reduce((x, a) => ({
    files: x.files + a.files, code: x.code + a.code, comment: x.comment + a.comment,
    need30: x.need30 + a.need30, need32: x.need32 + a.need32, below: x.below + a.below, big: x.big + a.big,
  }), { files: 0, code: 0, comment: 0, need30: 0, need32: 0, below: 0, big: 0 });
  console.log(`TOTAL files=${t.files} code=${t.code} comment=${t.comment} ratio=${(t.comment / t.code * 100).toFixed(1)}% gap30=${t.need30} gap32=${t.need32} below=${t.below} big=${t.big} batches@5=${Math.ceil(t.below / 5)}`);
}
