// uv 侧的 zc-gate 适配器：复用 zc-gate.mjs 的 judgeEntries 判据（poem run / 短句堆叠 / 单行无信息 / 无信息列举），
// 只把输入从「JSX 插入结果」换成本仓「快照 -> 当前」新增的 // 行。
// 用法：node uv-zc-gate.mjs --snapshot <dir> --files a,b [--json]
import fs from 'node:fs';
import path from 'node:path';
import { addedCommentEntries, judgeEntries } from './zc-gate.mjs';

const ROOT = 'd:\\code\\opensource\\uv';
const argv = process.argv.slice(2);
const snapIdx = argv.indexOf('--snapshot');
const SNAP = snapIdx >= 0 ? argv[snapIdx + 1] : '';
const filesIdx = argv.indexOf('--files');
const only = filesIdx >= 0 ? argv[filesIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
const jsonOut = argv.includes('--json');

if (!SNAP || !only.length) {
  console.error('usage: node uv-zc-gate.mjs --snapshot <dir> --files a,b [--json]');
  process.exit(2);
}

const detail = [];
let badFiles = 0;
let added = 0;
let water = 0;

for (const rel of only) {
  const preFile = path.join(SNAP, rel.split('/').join(path.sep));
  const postFile = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(postFile)) {
    console.error(`FAIL ${rel}: 仓库内文件不存在`);
    process.exit(2);
  }
  const before = fs.readFileSync(preFile, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const after = fs.readFileSync(postFile, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const entries = addedCommentEntries(before, after);
  const findings = judgeEntries(entries);
  added += entries.length;
  const lines = new Set();
  for (const f of findings) for (let l = f.line; l <= f.endLine; l++) lines.add(l);
  water += lines.size;
  if (findings.length) {
    badFiles++;
    for (const f of findings) {
      console.log(`${f.kind} ${rel}:${f.line}${f.endLine > f.line ? '-' + f.endLine : ''} ${f.reason} :: ${f.lines.join(' | ')}`);
    }
  }
  detail.push({ rel, addedCommentLines: entries.length, findings });
}

const rate = added ? ((water / added) * 100).toFixed(2) : '0.00';
console.log(`SUMMARY files=${only.length} badFiles=${badFiles} addedCommentLines=${added} waterLines=${water} waterRate=${rate}%`);
if (jsonOut) fs.writeFileSync(path.join('d:\\code\\_annot_baseline', 'uv-zc-gate.json'), JSON.stringify({ detail }, null, 2));
process.exit(badFiles ? 1 : 0);
