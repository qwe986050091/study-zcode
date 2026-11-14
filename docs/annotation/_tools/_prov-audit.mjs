#!/usr/bin/env node
// 溯源审计：相对指定副本，逐文件列出
//   1) 删除行（内容 + 位置）
//   2) 新增但非 // 开头的行（分类：块注释行 / 空行 / 其它）
//   3) 新增行中含 */ 的行
// 用法：node _prov-audit.mjs <baseDir> <fileList>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'd:\\code\\claude-code-main';
const [baseArg, listArg] = process.argv.slice(2);
const baseDir = path.resolve(baseArg);
const rels = fs.readFileSync(path.resolve(listArg), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function diffHunks(a, b) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', a, b], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const out = [];
  let cur = null;
  for (const raw of (r.stdout || '').split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      cur = { baseLine: m ? Number(m[1]) : 0, curLine: m ? Number(m[3]) : 0, dels: [], adds: [] };
      out.push(cur);
    } else if (cur && raw.startsWith('-') && !raw.startsWith('---')) {
      cur.dels.push(raw.slice(1));
    } else if (cur && raw.startsWith('+') && !raw.startsWith('+++')) {
      cur.adds.push(raw.slice(1));
    }
  }
  return out;
}

const delRows = [];
const nonCommentRows = [];
const starRows = [];
for (const rel of rels) {
  const cur = path.join(REPO, rel);
  const base = path.join(baseDir, rel);
  if (!fs.existsSync(base) || !fs.existsSync(cur)) continue;
  for (const h of diffHunks(base, cur)) {
    for (const line of h.dels) delRows.push({ rel, baseLine: h.baseLine, text: line });
    let b = h.baseLine;
    let c = h.curLine;
    for (const line of h.adds) {
      const t = line.trim();
      if (!t.startsWith('//')) {
        const kind = t === '' ? 'blank' : t.startsWith('/*') || t.startsWith('*') || t === '*/' ? 'block' : 'other';
        nonCommentRows.push({ rel, line: c, kind, text: line });
      }
      if (t.includes('*/')) starRows.push({ rel, line: c, text: line });
      c++;
    }
  }
}

console.log('=== DELETED ===');
for (const r of delRows) console.log(`${r.rel}\tbase:${r.baseLine}\t[${r.text}]`);

const byKind = {};
for (const r of nonCommentRows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
console.log('=== ADDED NON-// by kind ===');
console.log(JSON.stringify(byKind));

const byFile = {};
for (const r of nonCommentRows) (byFile[r.rel] ||= []).push(r);
console.log('=== ADDED NON-// by file ===');
for (const [rel, list] of Object.entries(byFile)) {
  const k = {};
  for (const r of list) k[r.kind] = (k[r.kind] || 0) + 1;
  const sample = list.slice(0, 2).map((r) => `${r.line}:[${r.text.trim().slice(0, 60)}]`).join(' | ');
  console.log(`${rel}\tn=${list.length}\t${JSON.stringify(k)}\t${sample}`);
}

const starByFile = {};
for (const r of starRows) (starByFile[r.rel] ||= []).push(r);
console.log('=== STAR-SLASH by file ===');
for (const [rel, list] of Object.entries(starByFile)) {
  console.log(`${rel}\tn=${list.length}\t${list.slice(0, 2).map((r) => `${r.line}:[${r.text.trim()}]`).join(' | ')}`);
}
console.log(`SUMMARY del=${delRows.length} nonComment=${nonCommentRows.length} star=${starRows.length}`);
