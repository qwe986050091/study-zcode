// LangGraph 深度注释：范围测量脚本
// 用法: node lg-measure.mjs [--root d:\code\opensource\langgraph] [--json]
// 口径与 DEEP-SPEC 5.1 一致：注释行=trim 后以 # 开头的整行；docstring/行尾注释不计。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : 'd:\\code\\opensource\\langgraph';

const EXCLUDE_DIR = new Set([
  'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', '.git', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', 'site-packages', '.tox', 'htmlcov', '.eggs',
]);
const EXCLUDE_FILE = [
  /(^|[\\/])(test_[^\\/]*\.py)$/,
  /_test\.py$/,
  /(^|[\\/])conftest\.py$/,
  /(^|[\\/])setup\.py$/,
];

function listPy(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIR.has(ent.name)) continue;
      listPy(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.py')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function measure(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let blank = 0, comment = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') { blank++; continue; }
    if (t.startsWith('#')) { comment++; continue; }
  }
  const total = lines.length;
  const code = total - blank - comment;
  const density = code === 0 ? 0 : comment / code;
  const need = Math.max(0, Math.ceil(code * 0.30) - comment);
  return { total, blank, comment, code, density, need };
}

const all = listPy(ROOT);
const groups = new Map();
const files = [];
for (const f of all) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (EXCLUDE_FILE.some((re) => re.test(rel))) continue;
  const m = measure(f);
  // 分组：libs/<pkg>/<langgraph|src 下的一级目录>
  const parts = rel.split('/');
  let group;
  if (parts[0] === 'libs') {
    const pkg = parts[1];
    const srcIdx = parts.findIndex((p, i) => i > 1 && (p === 'langgraph' || p === 'src'));
    group = srcIdx > 0 && parts[srcIdx + 1] ? `${pkg}/${parts[srcIdx]}/${parts[srcIdx + 1]}` : `${pkg}/${srcIdx > 0 ? parts[srcIdx] : '(root)'}`;
  } else {
    group = parts[0];
  }
  files.push({ rel, ...m });
  const g = groups.get(group) || { files: 0, lines: 0, comment: 0, code: 0, need: 0, big: 0 };
  g.files++; g.lines += m.total; g.comment += m.comment; g.code += m.code; g.need += m.need;
  if (m.total >= 800) g.big++;
  groups.set(group, g);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ root: ROOT, files }, null, 2));
} else {
  console.log(`root = ${ROOT}`);
  console.log(`python files (excl tests) = ${files.length}`);
  const rows = [...groups.entries()].map(([group, g]) => ({
    group,
    files: g.files,
    lines: g.lines,
    comment: g.comment,
    code: g.code,
    密度: (g.comment / Math.max(1, g.code) * 100).toFixed(2) + '%',
    need30: g.need,
    big800: g.big,
  })).sort((a, b) => b.lines - a.lines);
  console.table(rows);
  const tot = rows.reduce((a, r) => ({
    files: a.files + r.files, lines: a.lines + r.lines, comment: a.comment + r.comment,
    code: a.code + r.code, need30: a.need30 + r.need30, big800: a.big800 + r.big800,
  }), { files: 0, lines: 0, comment: 0, code: 0, need30: 0, big800: 0 });
  console.log('TOTAL', tot, 'medianDensity=',
    (() => { const d = files.map((f) => f.density).sort((a, b) => a - b); return d.length ? (d[Math.floor(d.length / 2)] * 100).toFixed(2) + '%' : 'n/a'; })());
  const below = files.filter((f) => f.density < 0.30);
  console.log(`files below 30% = ${below.length}, total need = ${below.reduce((a, f) => a + f.need, 0)}`);
}
