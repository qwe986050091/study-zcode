// 产品口径未覆盖单元抽样审计：按预登记规则（audit-rules-20261110.md）执行。
// 用法：node uv-prod-audit.mjs <dq-json> <repo-root> <out.csv>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { testLineSet } = await import(pathToFileURL('d:/code/_annot_baseline/uv-test-blocks.mjs').href);

const [jsonPath, repoRoot, outCsv] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const rows = data.rows;

function testBoundary(lines) {
  let boundary = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[cfg\(.*\btest\b.*\)\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 200, lines.length - 1); j++) {
      const t = lines[j].trim();
      if (/^#\[/.test(t) || t === '' || t.startsWith('//')) continue;
      if (/^(pub\s+)?mod\s+\w+\s*\{\s*$/.test(t) || /^(pub\s+)?mod\s+\w+\s*;/.test(t)) boundary = j + 1;
      break;
    }
    if (boundary !== null) break;
  }
  return boundary;
}

const skeleton = (text) => {
  let s = String(text);
  s = s.replace(/r#*"[^"]*"#*/g, 'STR').replace(/"(?:[^"\\]|\\.)*"/g, 'STR');
  s = s.replace(/\b\d[\d_.]*\b/g, 'NUM');
  s = s.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, 'ID');
  return s.replace(/\s+/g, ' ').trim();
};

const CONTROL = /\b(if|else|match|for|while|loop|return|break|continue|await|unsafe)\b|\?|=>|panic!|unwrap|expect\(|Err\(|Ok\(|map_err/;
const hasControl = (t) => CONTROL.test(t);

// 1) 产品口径未覆盖总体 + 每文件骨架频次
const units = [];
const boundaryOf = {};
const fileSkel = new Map(); // file -> Map(skel -> count)
const globalSkelFiles = new Map(); // skel -> Set(files)

for (const r of rows) {
  const rel = r.path.split(path.sep).join('/');
  const abs = path.join(repoRoot, rel.split('/').join(path.sep));
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const inTest = testLineSet(lines);
  const b = inTest.size ? Math.min(...inTest) : null;
  boundaryOf[rel] = b;
  const m = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (inTest.has(i + 1)) continue;
    const t = lines[i].trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    const sk = skeleton(t);
    m.set(sk, (m.get(sk) || 0) + 1);
    if (!globalSkelFiles.has(sk)) globalSkelFiles.set(sk, new Set());
    globalSkelFiles.get(sk).add(rel);
  }
  fileSkel.set(rel, m);
  for (const u of r.uncoveredUnits ?? []) {
    if (inTest.has(u.line)) continue;
    units.push({ file: rel, line: u.line, text: u.text, branch: !!u.branch });
  }
}

units.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
const N = units.length;

// 2) 等距系统抽样 60
const samples = [];
for (let i = 0; i < 60; i++) {
  const idx = Math.floor((N * (i + 0.5)) / 60);
  const u = units[idx];
  const sk = skeleton(u.text);
  const d1 = (fileSkel.get(u.file).get(sk) || 0) >= 2;
  const d2 = (globalSkelFiles.get(sk)?.size || 0) >= 3;
  const ctrl = hasControl(u.text);
  const dup = (d1 || d2) && !ctrl;
  samples.push({
    i: i + 1,
    idx,
    file: u.file,
    line: u.line,
    branch: u.branch ? 'B' : '',
    text: u.text.replace(/"/g, '""'),
    d1: d1 ? 1 : 0,
    d2: d2 ? 1 : 0,
    ctrl: ctrl ? 1 : 0,
    kind: dup ? '属实' : '不属实',
  });
}

const ok = samples.filter((s) => s.kind === '属实').length;
const bad = samples.length - ok;

const header = 'i,idx,file,line,branch,text,d1,d2,ctrl,kind';
const lines = [header, ...samples.map((s) => [s.i, s.idx, s.file, s.line, s.branch, `"${s.text}"`, s.d1, s.d2, s.ctrl, s.kind].join(','))];
fs.writeFileSync(outCsv, lines.join('\n') + '\n', 'utf8');

console.log(`N=${N} sampled=${samples.length} 属实=${ok} 不属实=${bad} badRate=${((bad / samples.length) * 100).toFixed(2)}%`);
console.log(`files=${rows.length} withBoundary=${Object.values(boundaryOf).filter((x) => x).length}`);
console.log(`estBad=${Math.round((bad / samples.length) * N)} (0/60 单侧 95% 上界 4.88%)`);
