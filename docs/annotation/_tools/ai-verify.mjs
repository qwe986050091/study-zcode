// vercel/ai 批次校验（TS/TSX）：零删除 + 新增行必须整行注释 + 新增注释无 */ + TS 语法自检 + 密度。
// 用法：node ai-verify.mjs <批次名> [--threshold 30]
//   读取 d:\code\_annot_baseline\<批次名>\_files.txt（相对仓库根，一行一个）
//   基线：d:\code\_annot_baseline\<批次名>\orig\<相对路径>
// fail-closed：缺基线/缺文件/缺 typescript/解析失败/删行/非注释新增/低于阈值 均非零退出。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'D:/code/opensource/ai';
const batch = process.argv[2];
const thrIdx = process.argv.indexOf('--threshold');
const threshold = thrIdx > 0 ? Number(process.argv[thrIdx + 1]) : 0;
if (!batch) {
  console.error('usage: node ai-verify.mjs <batchName> [--threshold 30]');
  process.exit(2);
}
const batchDir = path.join('D:/code/_annot_baseline', batch);
const origDir = path.join(batchDir, 'orig');
const listFile = path.join(batchDir, '_files.txt');
if (!fs.existsSync(listFile)) {
  console.error('FAIL: missing _files.txt at ' + listFile);
  process.exit(1);
}
const files = fs
  .readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
if (!files.length) {
  console.error('FAIL: empty _files.txt');
  process.exit(1);
}

// typescript 解析器：仓库自带优先，其次 _annot_baseline/tools；都找不到即失败（禁止跳过语法校验）
const tsCandidates = [
  path.join(REPO, 'node_modules/typescript/lib/typescript.js'),
  path.join('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js'),
];
let ts = null;
for (const cand of tsCandidates) {
  if (!fs.existsSync(cand)) continue;
  try {
    ts = (await import('file:///' + cand.replace(/\\/g, '/'))).default;
    break;
  } catch (e) {
    console.error('WARN: typescript load failed at ' + cand + ' :: ' + e.message);
  }
}
if (!ts) {
  console.error('FAIL: typescript compiler API 不可用（禁止跳过语法校验）');
  process.exit(1);
}

function density(file) {
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
    if (t.startsWith('*')) comment++;
  }
  const total = lines.length - (text.endsWith('\n') ? 1 : 0);
  const code = total - blank - comment;
  return { total, code, comment, ratio: code ? comment / code : 1 };
}

let deletedNonZero = 0;
let nonCommentAdded = 0;
let starSlash = 0;
let syntaxErrorFiles = 0;
let belowThreshold = 0;
let addedTotal = 0;

for (const rel of files) {
  const cur = path.join(REPO, rel);
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
      if (!t.startsWith('//')) {
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

  const d = density(cur);
  if (threshold && d.ratio * 100 < threshold) {
    belowThreshold++;
    console.error(`BELOW ${threshold}%: ${rel} = ${(d.ratio * 100).toFixed(2)}% (${d.comment}/${d.code})`);
  }
  console.log(`FILE ${rel} +${added} ${d.comment}/${d.code} = ${(d.ratio * 100).toFixed(2)}%`);

  const text = fs.readFileSync(cur, 'utf8');
  const sf = ts.createSourceFile(
    cur,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    syntaxErrorFiles++;
    for (const dg of sf.parseDiagnostics.slice(0, 3)) {
      const pos = sf.getLineAndCharacterOfPosition(dg.start || 0);
      console.error(`SYNTAX: ${rel}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(dg.messageText, ' ')}`);
    }
  }
}

console.log(
  `SUMMARY files=${files.length} deletedNonZero=${deletedNonZero} nonCommentAdded=${nonCommentAdded} starSlash=${starSlash} syntaxErrorFiles=${syntaxErrorFiles} belowThreshold=${belowThreshold} added=${addedTotal}`,
);
if (deletedNonZero || nonCommentAdded || starSlash || syntaxErrorFiles || belowThreshold) process.exit(1);
process.exit(0);
