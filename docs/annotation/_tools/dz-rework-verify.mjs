// 回炉门禁：只允许删除「我们自己新增的整行 // 注释」，代码 token 流必须与 HEAD 逐字一致
// 用法: node dz-rework-verify.mjs <batchName>
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';
const batch = process.argv[2];
if (!batch) { console.error('usage: node dz-rework-verify.mjs <batchName>'); process.exit(2); }
const dir = path.join(BASE, batch);
const rels = fs.readFileSync(path.join(dir, '_files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);

function lcs(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 25_000_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ai === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i] }); i++; }
    else { out.push({ t: 'add', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', s: a[i++] });
  while (j < m) out.push({ t: 'add', s: b[j++] });
  return out;
}

const isComment = (s) => /^\s*\/\//.test(s) || /^\s*\/\*/.test(s) || /^\s*\*/.test(s);

// 说明：这里不能用裸 ts.createScanner 逐个 scan() 取 token。裸扫描器在遇到带 ${} 的模板串时，
// 没有在表达式结束的 } 之后 reScanTemplateToken，会把闭合反引号之后到下一个反引号之间的全部源码
// （含注释）吞进同一个 token 的文本里，导致「只加注释」也被判 tokenDrift。
// 改用解析器 + 去注释打印：注释被剥离，代码结构与字面量原文一致时输出逐字相同。
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function codeFingerprint(text) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return printer.printFile(sf).replace(/\s+/g, ' ');
}

let deletedNonZero = 0, nonCommentAdded = 0, deletedUpstream = 0, tokenDrift = 0, syntaxErrorFiles = 0, crlfMixed = 0;
const detail = [];

for (const rel of rels) {
  const origPath = path.join(dir, 'orig', rel);
  const curPath = path.join(REPO, rel);
  if (!fs.existsSync(origPath) || !fs.existsSync(curPath)) {
    detail.push(`MISSING ${rel}`); deletedNonZero++; continue;
  }
  const orig = fs.readFileSync(origPath, 'utf8').replace(/\r\n/g, '\n');
  const curRaw = fs.readFileSync(curPath, 'utf8');
  const cur = curRaw.replace(/\r\n/g, '\n');
  const head = execSync(`git -C "${REPO}" show HEAD:${rel}`, { encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\r\n/g, '\n');

  const A = orig.split('\n'), B = cur.split('\n');
  const d = lcs(A, B);
  if (!d) { detail.push(`TOO_LARGE ${rel}`); continue; }

  const headLines = new Set(head.split('\n'));
  let dn = 0, nca = 0, du = 0;
  for (const it of d) {
    if (it.t === 'del') {
      if (!isComment(it.s)) { if (it.s.trim() !== '') { dn++; detail.push(`DEL_CODE ${rel}: ${it.s.trim().slice(0, 80)}`); } else { dn++; detail.push(`DEL_BLANK ${rel}`); } }
      else if (headLines.has(it.s)) { du++; detail.push(`DEL_UPSTREAM_COMMENT ${rel}: ${it.s.trim().slice(0, 80)}`); }
    } else if (it.t === 'add') {
      if (it.s.trim() !== '' && !isComment(it.s)) { nca++; detail.push(`ADD_CODE ${rel}: ${it.s.trim().slice(0, 80)}`); }
    }
  }
  // 代码指纹
  const same = codeFingerprint(head) === codeFingerprint(cur);
  if (!same) { tokenDrift++; detail.push(`TOKEN_DRIFT ${rel}`); }
  // 语法
  // 解析 kind 必须跟扩展名一致：.ts 用 TSX 解析会把 `<T> v` 角度断言当成 JSX 起点，产生一整串假语法错。
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, cur, ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) { syntaxErrorFiles++; detail.push(`SYNTAX ${rel}: ${sf.parseDiagnostics.length}`); }
  // CRLF
  const bareLF = (curRaw.match(/(?<!\r)\n/g) || []).length;
  if (bareLF) { crlfMixed++; detail.push(`CRLF ${rel}: bareLF=${bareLF}`); }

  deletedNonZero += dn; nonCommentAdded += nca; deletedUpstream += du;
}

console.log(`SUMMARY batch=${batch} files=${rels.length} deletedNonZero=${deletedNonZero} nonCommentAdded=${nonCommentAdded} deletedUpstream=${deletedUpstream} tokenDrift=${tokenDrift} syntaxErrorFiles=${syntaxErrorFiles} crlfMixed=${crlfMixed}`);
if (detail.length) console.log(detail.slice(0, 40).join('\n'));
