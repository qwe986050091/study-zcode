// MCP Python SDK 批次校验：零删除 + 新增行必须整行 # 注释 + 新增注释无 */ + 逐文件密度 + python -S 语法解析。
// 用法：node mcp-py-verify.mjs <批次名>   （如 mcp-py-p01）
//   读取 d:\code\_annot_baseline\<批次名>\_files.txt
//   基线：d:\code\_annot_baseline\<批次名>\orig\<相对路径>
// fail-closed：缺基线、python 缺失、超时、解析失败、删行、非注释新增、密度 <30% 均非零退出。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'D:/code/opensource/mcp-python-sdk';
const checker = 'D:/code/_annot_baseline/py-syntax-check.py';
const batch = process.argv[2];
if (!batch) {
  console.error('usage: node mcp-py-verify.mjs <batchName>');
  process.exit(2);
}
const batchDir = path.join('D:/code/_annot_baseline', batch);
const origDir = path.join(batchDir, 'orig');
const listFile = path.join(batchDir, '_files.txt');
if (!fs.existsSync(listFile)) {
  console.error('FAIL: missing _files.txt at ' + listFile);
  process.exit(1);
}
if (!fs.existsSync(checker)) {
  console.error('FAIL: missing syntax checker ' + checker);
  process.exit(1);
}
const files = fs
  .readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const pyProbe = spawnSync('python', ['--version'], { encoding: 'utf8', timeout: 15000 });
if (pyProbe.error || pyProbe.status !== 0) {
  console.error('FAIL: python 不可用（禁止跳过语法校验）');
  console.error(`SUMMARY files=${files.length} deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=${files.length} lowDensity=0 added=0`);
  process.exit(1);
}

function measure(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let total = 0,
    blank = 0,
    comment = 0;
  for (const raw of lines) {
    total++;
    const t = raw.trim();
    if (!t) blank++;
    else if (t.startsWith('#')) comment++;
  }
  return { total, blank, comment, code: total - blank - comment };
}

let deletedNonZero = 0;
let nonCommentAdded = 0;
let starSlash = 0;
let syntaxErrorFiles = 0;
let lowDensity = 0;
let addedTotal = 0;

for (const rel of files) {
  const cur = path.join(repo, rel);
  const base = path.join(origDir, rel);
  if (!fs.existsSync(base)) {
    console.error('FAIL: baseline missing: ' + base);
    process.exit(1);
  }
  if (!fs.existsSync(cur)) {
    console.error('FAIL: current missing: ' + cur);
    process.exit(1);
  }
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = (r.stdout || '').split(/\r?\n/);
  let deleted = 0;
  let added = 0;
  let bad = 0;
  let hasStar = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const t = l.slice(1).trim();
      if (!t.startsWith('#')) {
        bad++;
        console.error('NON-COMMENT ADDED: ' + rel + ' :: ' + t.slice(0, 120));
      } else {
        added++;
        if (t.includes('*/')) {
          hasStar++;
          console.error('STAR-SLASH IN COMMENT: ' + rel + ' :: ' + t.slice(0, 120));
        }
      }
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      deleted++;
    }
  }
  if (deleted) {
    deletedNonZero++;
    console.error('DELETED LINES: ' + rel + ' = ' + deleted);
  }
  if (bad) nonCommentAdded += bad;
  if (hasStar) starSlash += hasStar;
  addedTotal += added;

  const syn = spawnSync('python', ['-S', checker, cur], { encoding: 'utf8', timeout: 30000 });
  if (syn.error || syn.status !== 0) {
    syntaxErrorFiles++;
    const why = syn.error ? syn.error.message : (syn.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' | ');
    console.error(`SYNTAX/TIMEOUT: ${rel} :: ${why.slice(0, 300)}`);
  }

  const text = fs.readFileSync(cur, 'utf8');
  const m = measure(text);
  const density = m.code ? m.comment / m.code : 1;
  if (density < 0.3) lowDensity++;
  console.log(
    `${(density * 100).toFixed(2)}%\tcode=${m.code}\tcomment=${m.comment}\t+${added}\t${rel}` +
      (density < 0.3 ? '\t<30%' : ''),
  );
}

console.log(
  `SUMMARY files=${files.length} deletedNonZero=${deletedNonZero} nonCommentAdded=${nonCommentAdded} starSlash=${starSlash} syntaxErrorFiles=${syntaxErrorFiles} lowDensity=${lowDensity} added=${addedTotal}`,
);
if (deletedNonZero || nonCommentAdded || starSlash || syntaxErrorFiles || lowDensity) process.exit(1);
process.exit(0);
