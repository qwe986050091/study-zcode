// 双写检测：找出「本线插入的注释块」与「另一条线插在同一代码行上方」的叠加。
// 用法：node dup-scan.mjs <repo> <relPath> <ourEntries.json> [more.json ...]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [repo, rel, ...jsonFiles] = process.argv.slice(2);
if (!repo || !rel) {
  console.error('usage: node dup-scan.mjs <repo> <relPath> <ourEntries.json> [...]');
  process.exit(2);
}

const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', '--', rel], { encoding: 'utf8' });
const added = new Set();
for (const line of diff.split(/\r?\n/)) {
  const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!m) continue;
  let start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  for (let i = 0; i < count; i++) added.add(start + i);
}

const file = repo.replace(/\\+$/, '') + '\\' + rel.replace(/\//g, '\\');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const norm = (s) => s.replace(/\s+/g, '');

const ours = new Map(); // normalized block -> raw lines
for (const f of jsonFiles) {
  if (!fs.existsSync(f)) continue;
  const arr = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(arr)) continue;
  for (const e of arr) {
    const ls = e.lines || e.comment || e.text || [];
    const block = Array.isArray(ls) ? ls : String(ls).split(/\r?\n/);
    const key = block.map((x) => norm(String(x))).join('\u0000');
    if (key) ours.set(key, block);
  }
}

// 合并“只隔空行”的连续新增注释，视作同一个注释区
const runs = [];
let cur = null;
for (let i = 1; i <= lines.length; i++) {
  const isAddedComment = added.has(i) && /^\s*\/\//.test(lines[i - 1]);
  const isBlank = /^\s*$/.test(lines[i - 1] ?? '');
  if (isAddedComment) {
    if (cur && (i - cur.end <= 2)) {
      cur.end = i;
      cur.idx.push(i);
    } else {
      cur = { start: i, end: i, idx: [i] };
      runs.push(cur);
    }
  } else if (!isBlank && cur) {
    cur = null;
  }
}

let oursLines = 0;
let extraRuns = [];
for (const r of runs) {
  const text = r.idx.map((i) => norm(lines[i - 1])).join('\u0000');
  let matched = null;
  for (const [k] of ours) {
    if (text === k) { matched = k; break; }
  }
  if (matched) { oursLines += r.idx.length; continue; }
  // 含我们的块但更长 -> 叠加
  let contained = null;
  for (const [k, raw] of ours) {
    if (k && text.includes(k)) { contained = { k, raw }; break; }
  }
  if (contained) {
    oursLines += contained.raw.length;
    const ourSet = new Set(contained.k.split('\u0000'));
    const extras = r.idx.filter((i) => !ourSet.has(norm(lines[i - 1])));
    extraRuns.push({ ...r, extras, oursLen: contained.raw.length });
  }
}

const totalAdded = [...added].filter((i) => /^\s*\/\//.test(lines[i - 1])).length;
console.log(`FILE ${rel}`);
console.log(`addedCommentLines=${totalAdded} runs=${runs.length} oursLines=${oursLines} stackedRuns=${extraRuns.length}`);
for (const r of extraRuns) {
  console.log(`STACK L${r.start}-L${r.end} total=${r.idx.length} ours=${r.oursLen} extra=${r.extras.length}`);
  for (const i of r.idx) {
    const mark = r.extras.includes(i) ? '  EXTRA' : '       ';
    console.log(`  ${mark} L${i}: ${lines[i - 1].trim().slice(0, 100)}`);
  }
}
