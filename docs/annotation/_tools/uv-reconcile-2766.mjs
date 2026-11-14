// 逐块核对回填新增的注释行：每块是否「新覆盖」了一个产品单元，以及 2,766 - 2,753 = 13 行差在哪里。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'd:/code/opensource/uv';
const files = fs.readFileSync('d:/code/_annot_baseline/uv-rework/b2-files.txt', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.startsWith('crates/'));
const pre = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/dq-key123-s108.json', 'utf8')).rows;
const preUnc = new Map(); // file -> Set(line) product uncovered
for (const r of pre) {
  const rel = r.path.split(path.sep).join('/');
  preUnc.set(rel, new Set((r.uncoveredUnits ?? []).map((u) => u.line)));
}

let totalLines = 0;
let blocks = 0;
let coverBlocks = 0;
let multiBlocks = 0;
let multiExtra = 0;
let redundantBlocks = 0;
let redundantLines = 0;
const samples = [];

for (const rel of files) {
  const diff = spawnSync('git', ['-C', repo, 'diff', '-U0', '3d5c8d7', '--', rel], { encoding: 'utf8' }).stdout;
  let off = 0;
  const added = [];
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { off = Number(m[2]) - Number(m[1]); continue; }
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+') && /^\+\s*\/\//.test(l)) added.push({ newLine: null, text: l.slice(1), off });
  }
  // 重新扫一遍拿到新增行号（上面为了简单记录 off，行号需另算）
  const added2 = [];
  let newLine = 0;
  let off2 = 0;
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { newLine = Number(m[2]); off2 = Number(m[2]) - Number(m[1]); continue; }
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) {
      if (/^\+\s*\/\//.test(l)) added2.push({ newLine, off: off2 });
      newLine++;
    }
  }
  totalLines += added2.length;
  if (process.argv.includes('--per-file')) console.log(`${rel}\t${added2.length}`);
  // 连续新增行分块
  let i = 0;
  while (i < added2.length) {
    let j = i;
    while (j + 1 < added2.length && added2[j + 1].newLine === added2[j].newLine + 1) j++;
    const a = added2[i].newLine, b = added2[j].newLine, offb = added2[j].off;
    const len = j - i + 1;
    // 找块下方第一条非空代码行（允许最多 2 行空行），映射回快照行号
    const cur = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
    let target = null;
    for (let k = b; k < Math.min(cur.length, b + 3); k++) {
      if (cur[k].trim() !== '') { target = k + 1; break; }
    }
    const snap = target - offb;
    const isNewUnit = preUnc.get(rel)?.has(snap) ?? false;
    blocks++;
    if (isNewUnit) {
      coverBlocks++;
      if (len > 1) { multiBlocks++; multiExtra += len - 1; samples.push(`MULTI ${rel}:${a}-${b} len=${len} -> unit ${snap}`); }
    } else {
      redundantBlocks++; redundantLines += len;
      samples.push(`REDUNDANT ${rel}:${a}-${b} len=${len} -> next ${snap}${preUnc.get(rel)?.has(snap) ? ' (uncovered?)' : ''}`);
    }
    i = j + 1;
  }
}
console.log(`addedCommentLines=${totalLines} blocks=${blocks} coverBlocks=${coverBlocks} multiBlocks=${multiBlocks} multiExtra=${multiExtra} redundantBlocks=${redundantBlocks} redundantLines=${redundantLines}`);
console.log(`check: lines - coverBlocks = ${totalLines - coverBlocks} (期望 ${totalLines - 2753})`);
for (const s of samples.slice(0, 40)) console.log(s);
