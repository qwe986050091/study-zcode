// 自有 weak 的批次归属：用 weakLines - 上游豁免集，再 git blame 到引入该行的提交
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'd:/code/opensource/valkey';
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-exemptions.json', 'utf8'));

const up = new Map();
for (const f of ex.files) up.set(f.file, new Set(f.items.map((i) => i.line)));

const own = [];
for (const r of q.rows) {
  if (!r.weakLines || !r.weakLines.length) continue;
  const upstream = up.get(r.path) || new Set();
  for (const w of r.weakLines) if (!upstream.has(w.line)) own.push({ path: r.path, line: w.line, reasons: w.reasons });
}
console.log(`own weak=${own.length}`);

const byFile = new Map();
for (const o of own) {
  if (!byFile.has(o.path)) byFile.set(o.path, []);
  byFile.get(o.path).push(o.line);
}

const commitCount = new Map();
const commitFiles = new Map();
for (const [file, lines] of byFile) {
  const out = execFileSync('git', ['blame', '--line-porcelain', '--', file], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const map = new Map();
  const arr = out.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const m = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(arr[i]);
    if (!m) continue;
    const start = Number(m[2]), count = Number(m[3]);
    for (let k = 0; k < count; k++) map.set(start + k, m[1]);
  }
  const wanted = new Set(lines);
  for (const ln of wanted) {
    const sha = map.get(ln) || 'unknown';
    commitCount.set(sha, (commitCount.get(sha) || 0) + 1);
    if (!commitFiles.has(sha)) commitFiles.set(sha, new Map());
    const fm = commitFiles.get(sha);
    fm.set(file, (fm.get(file) || 0) + 1);
  }
}

const rowsOut = [...commitCount.entries()].map(([sha, n]) => {
  let subject = '(unknown)';
  if (sha !== 'unknown') subject = execFileSync('git', ['log', '-1', '--format=%h %s', sha], { cwd: REPO, encoding: 'utf8' }).trim();
  return { sha, n, subject };
}).sort((a, b) => b.n - a.n);

console.log('commit\tweak\tfile\tfileWeak\tsubject');
for (const r of rowsOut) {
  const fm = commitFiles.get(r.sha);
  const top = [...fm.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`${r.sha.slice(0, 7)}\t${r.n}\t${top[0]}\t${top[1]}\t${r.subject}`);
}
