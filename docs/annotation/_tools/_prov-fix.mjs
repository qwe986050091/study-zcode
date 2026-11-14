#!/usr/bin/env node
// 溯源口径修复：
//   1) 把「相对 S 新增的整段块注释（/** ... */）」逐行改写为 // 行（同内容、同行数）
//   2) 删除「相对 S 新增的空白行」（不属于块注释内部的）
//   3) 仅打印，不触碰基线行；遇到段内含非新增行的块直接跳过并报告
// 用法：node _prov-fix.mjs <baseDir> <fileList> [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'd:\\code\\claude-code-main';
const [baseArg, listArg, flag] = process.argv.slice(2);
const dry = flag === '--dry';
const baseDir = path.resolve(baseArg);
const rels = fs.readFileSync(path.resolve(listArg), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function addedLines(base, cur) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const set = new Set();
  let curLine = 0;
  let inHunk = false;
  for (const raw of (r.stdout || '').split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      curLine = m ? Number(m[1]) : 0;
      inHunk = true;
    } else if (!inHunk) continue;
    else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      set.add(curLine);
      curLine++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      // 删除行不占当前行号
    } else if (raw.startsWith(' ')) {
      curLine++;
    }
  }
  return set;
}

const isBlockStart = (t) => t.startsWith('/*');
const isBlockEnd = (t) => t.endsWith('*/') && t !== '/*';
const isStar = (t) => t.startsWith('*');

const report = [];
let convTotal = 0;
let blankTotal = 0;
for (const rel of rels) {
  const cur = path.join(REPO, rel);
  const base = path.join(baseDir, rel);
  if (!fs.existsSync(cur) || !fs.existsSync(base)) continue;
  const added = addedLines(base, cur);
  if (!added.size) continue;
  const lines = fs.readFileSync(cur, 'utf8').split(/\r?\n/);
  let changed = 0;

  // 1) 块注释整段改写
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isBlockStart(t) || !added.has(i + 1)) continue;
    // 找闭合行
    let j = i;
    let ok = true;
    while (j < lines.length) {
      const tt = lines[j].trim();
      if (!added.has(j + 1) && tt !== '') { ok = false; break; }
      if (isBlockEnd(tt)) break;
      if (!isStar(tt) && !isBlockStart(tt) && tt !== '') { ok = false; break; }
      j++;
    }
    if (j >= lines.length) { ok = false; }
    if (!ok) {
      report.push(`SKIP-BLOCK ${rel} line ${i + 1} (含非新增行)`);
      continue;
    }
    const indent = lines[i].match(/^\s*/)[0];
    for (let k = i; k <= j; k++) {
      const tt = lines[k].trim();
      let body;
      if (tt === '/**' || tt === '/*' || tt === '*/' || tt === '') body = '';
      else if (isStar(tt)) body = tt.slice(1).replace(/^\s?/, '');
      else body = tt;
      lines[k] = indent + '//' + (body ? ' ' + body.replace(/\s+$/, '') : '');
      changed++;
    }
    i = j;
  }

  // 2) 删除新增空白行（重新计算 added，因为行数未变，集合仍准确）
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' && added.has(i + 1)) {
      changed++;
      blankTotal++;
      continue;
    }
    out.push(lines[i]);
  }

  if (changed) {
    convTotal += changed;
    report.push(`FIX ${rel} changed=${changed}`);
    if (!dry) fs.writeFileSync(cur, out.join('\n'), 'utf8');
  }
}

for (const r of report) console.log(r);
console.log(`SUMMARY changed=${convTotal} blankRemoved=${blankTotal} dry=${dry}`);
