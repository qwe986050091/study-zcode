// Drizzle ORM 深度注释批次校验（TS/TSX，CRLF 源）：零删除 + 新增行必须整行 // + 新增注释无 */ + 语法 parseDiagnostics + 逐文件密度 >= 30%。
// 用法：node dz-verify.mjs <批次名> [--repo <仓库根>] [--threshold 30]
//   读取 d:\code\_annot_baseline\<批次名>\_files.txt（相对仓库根，一行一个）
//   基线：d:\code\_annot_baseline\<批次名>\orig\<相对路径>
// fail-closed：缺基线、缺 typescript、解析失败、删行、非注释新增、密度不足 均非零退出。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const batch = args[0];
if (!batch || batch.startsWith('--')) {
  console.error('usage: node dz-verify.mjs <batchName> [--repo <root>] [--threshold 30]');
  process.exit(2);
}
const repo = (args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'D:/code/opensource/drizzle-orm').replace(/\\/g, '/');
const threshold = Number(args.includes('--threshold') ? args[args.indexOf('--threshold') + 1] : 30);
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

// typescript 解析器：按 仓库 node_modules → _annot_baseline/tools/node_modules 顺序查找；找不到 fail-closed
const tsCandidates = [
  path.join(repo, 'node_modules/typescript/lib/typescript.js'),
  'D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js',
];
let ts = null;
let tsFrom = '';
for (const p of tsCandidates) {
  if (!fs.existsSync(p)) continue;
  try {
    ts = (await import('file:///' + p.replace(/\\/g, '/'))).default;
    tsFrom = p;
    break;
  } catch (e) {
    console.error('WARN: typescript 加载失败 ' + p + ' :: ' + e.message);
  }
}
if (!ts) {
  console.error('FAIL: typescript compiler API 不可用（禁止跳过语法校验）；已尝试: ' + tsCandidates.join(' | '));
  console.log(`SUMMARY files=${files.length} deletedNonZero=-1 nonCommentAdded=-1 starSlash=-1 syntaxErrorFiles=${files.length} belowThreshold=-1 added=0 typescript=missing`);
  process.exit(1);
}

// 行级口径：整行注释计入，行尾注释不计
function measure(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let total = lines.length;
  let blank = 0;
  let comment = 0;
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      blank++;
      continue;
    }
    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (t.includes('*/')) inBlock = false;
    } else if (t.startsWith('//')) {
      isComment = true;
    } else if (t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlock = true;
    }
    if (isComment) comment++;
  }
  return { total, blank, comment, code: total - blank - comment };
}

let deletedNonZero = 0;
let nonCommentAdded = 0;
let starSlash = 0;
let syntaxErrorFiles = 0;
let belowThreshold = 0;
let addedTotal = 0;
let crlfMixed = 0;
const rows = [];

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

  // 1) 基线 diff：删除行 / 新增行是否为整行注释 / 注释内是否含 */
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const diffLines = (r.stdout || '').split(/\r?\n/);
  let deleted = 0;
  let added = 0;
  let bad = 0;
  let hasStar = 0;
  for (const l of diffLines) {
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

  // 2) 语法：TS compiler API 解析当前文件
  const text = fs.readFileSync(cur, 'utf8');
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : rel.endsWith('.js') ? ts.ScriptKind.JS : rel.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(cur, text, ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    syntaxErrorFiles++;
    for (const d of sf.parseDiagnostics.slice(0, 3)) {
      const pos = sf.getLineAndCharacterOfPosition(d.start || 0);
      console.error(`SYNTAX: ${rel}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }

  // 3) 密度（当前文件口径）
  const m = measure(cur);
  const ratio = m.code ? (m.comment / m.code) * 100 : Infinity;
  if (ratio < threshold) belowThreshold++;
  // 4) CRLF 混用探测（插入时漏 \r 会让新增行变成 LF-only）
  if (text.includes('\r\n') && /(^|[^\r])\n/.test(text)) crlfMixed++;
  rows.push({ rel, added, total: m.total, code: m.code, comment: m.comment, ratio });
}

rows.sort((a, b) => a.ratio - b.ratio);
console.log('\nfile\tadded\ttotal\tcode\tcomment\tratio');
for (const row of rows) {
  console.log(`${(row.ratio === Infinity ? 'n/a' : row.ratio.toFixed(2) + '%')}\t+${row.added}\t${row.total}\t${row.code}\t${row.comment}\t${row.rel}`);
}
const band = rows.filter((x) => x.ratio >= 31 && x.ratio <= 33).length;
console.log(
  `\nSUMMARY files=${files.length} deletedNonZero=${deletedNonZero} nonCommentAdded=${nonCommentAdded} starSlash=${starSlash} syntaxErrorFiles=${syntaxErrorFiles} belowThreshold=${belowThreshold} added=${addedTotal} inBand31_33=${band} crlfMixed=${crlfMixed} threshold=${threshold}% typescript=${tsFrom}`,
);
if (deletedNonZero || nonCommentAdded || starSlash || syntaxErrorFiles || belowThreshold) process.exit(1);
process.exit(0);
