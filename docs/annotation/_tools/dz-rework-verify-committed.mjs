// 按「批次产出状态」重跑六项门禁：cur 取该批提交内的 blob，head 取该提交的父提交，
// 不再用当前工作树。用法: node dz-rework-verify-committed.mjs <batch> [commit]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';

// 批次 → 提交（R01–R13 共用一个提交，R19–R21 共用一个提交）
const MAP = {
  'R01': '8bb5a0d', 'R02': '8bb5a0d', 'R03': '8bb5a0d', 'R04': '8bb5a0d', 'R05': '8bb5a0d',
  'R06': '8bb5a0d', 'R07': '8bb5a0d', 'R08': '8bb5a0d', 'R09': '8bb5a0d', 'R10': '8bb5a0d',
  'R11': '8bb5a0d', 'R12': '8bb5a0d', 'R13': '8bb5a0d',
  'R14': '205fdb9', 'R15': '24699ee', 'R16': '238743f', 'R17': '36c35c8', 'R18': 'a798c85',
  'R19': '28b4caf', 'R20': '28b4caf', 'R21': '28b4caf',
  'R22': '1510d58', 'R23': '7e8b53d', 'R24': '9eabd6d', 'R25': 'd338bb6', 'R26': '35cda2e',
  'R27': '90390ff', 'R28': '7c80dc3', 'R29': 'd070dc1', 'R30': 'f359efa', 'R31': 'bfd4af4',
  'R32': '1d78082', 'R33': 'd9e5e68', 'R34': '2c94f96', 'R35': '987b465', 'R36': 'e869b0c',
  'R37': 'd1ee1dd', 'R38': '7dc071d', 'R39': '2d2ba58', 'R40': '91f01fa', 'R41': 'fa1ac62',
  'R42': '1bb31ad', 'R43': 'd8cacf9', 'R44': '1124c78', 'R45': 'aeeb32b', 'R46': '9db4a23',
  'R47': 'fcc8ebb', 'R48': '7800e34', 'R49': 'b3be767', 'R50': '83e1e8a', 'R51': '01209b0',
  'R52c': 'd3a99a8', 'R52': 'eb41d68', 'R53': '0f37526', 'R54': 'e86bc6a', 'R55': 'c3ecd4d',
  'R56': 'bf31acf',
  'R57': '047ba36',
  'R57b': 'd5a4676',
  'R58a': 'b558a7c',
  'R58c': '9be6881',
};

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
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function codeFingerprint(text, rel) {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  return printer.printFile(sf).replace(/\s+/g, ' ');
}

// 一次性批量取 blob：spec 形如 <commit>:<rel>
function batchCat(specs) {
  const uniq = [...new Set(specs)];
  const input = uniq.map((s) => s + '\n').join('');
  const buf = execSync(`git -C "${REPO}" cat-file --batch`, {
    input: Buffer.from(input, 'utf8'),
    maxBuffer: 1 << 30,
    encoding: 'buffer',
  });
  const out = new Map();
  let pos = 0;
  for (const spec of uniq) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) { out.set(spec, null); continue; }
    const size = Number(header.split(' ')[2]);
    out.set(spec, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

const batches = process.argv[2] ? [process.argv[2]] : Object.keys(MAP);
if (process.argv[3]) MAP[batches[0]] = process.argv[3];

// 预取
const specs = [];
const plan = [];
for (const b of batches) {
  const dir = path.join(BASE, b);
  const rels = fs.readFileSync(path.join(dir, '_files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  const commit = MAP[b];
  plan.push({ b, dir, rels, commit });
  for (const rel of rels) {
    specs.push(`${commit}:${rel}`);
    specs.push(`${commit}^:${rel}`);
  }
}
const blobs = batchCat(specs);

const rows = [];
for (const { b, dir, rels, commit } of plan) {
  let deletedNonZero = 0, nonCommentAdded = 0, deletedUpstream = 0, tokenDrift = 0, syntaxErrorFiles = 0, crlfMixed = 0;
  const detail = [];
  for (const rel of rels) {
    const origRaw = fs.readFileSync(path.join(dir, 'orig', rel), 'utf8');
    const orig = origRaw.replace(/\r\n/g, '\n');
    const curBlob = blobs.get(`${commit}:${rel}`);
    const headBlob = blobs.get(`${commit}^:${rel}`);
    if (curBlob == null) { detail.push(`MISSING_IN_COMMIT ${rel}`); deletedNonZero++; continue; }
    const curRaw = curBlob;
    const cur = curRaw.replace(/\r\n/g, '\n');
    const head = (headBlob ?? '').replace(/\r\n/g, '\n');

    const A = orig.split('\n'), B = cur.split('\n');
    const d = lcs(A, B);
    if (!d) { detail.push(`TOO_LARGE ${rel}`); continue; }
    const headLines = new Set(head.split('\n'));
    let dn = 0, nca = 0, du = 0;
    for (const it of d) {
      if (it.t === 'del') {
        if (!isComment(it.s)) {
          if (it.s.trim() !== '') { dn++; detail.push(`DEL_CODE ${rel}: ${it.s.trim().slice(0, 80)}`); }
          else { dn++; detail.push(`DEL_BLANK ${rel}`); }
        } else if (headLines.has(it.s)) { du++; detail.push(`DEL_UPSTREAM_COMMENT ${rel}: ${it.s.trim().slice(0, 80)}`); }
      } else if (it.t === 'add') {
        if (it.s.trim() !== '' && !isComment(it.s)) { nca++; detail.push(`ADD_CODE ${rel}: ${it.s.trim().slice(0, 80)}`); }
      }
    }
    if (codeFingerprint(head, rel) !== codeFingerprint(cur, rel)) { tokenDrift++; detail.push(`TOKEN_DRIFT ${rel}`); }
    const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, cur, ts.ScriptTarget.Latest, true, kind);
    if (sf.parseDiagnostics && sf.parseDiagnostics.length) { syntaxErrorFiles++; detail.push(`SYNTAX ${rel}: ${sf.parseDiagnostics.length}`); }
    const bareLF = (curRaw.match(/(?<!\r)\n/g) || []).length;
    if (bareLF && curRaw.includes('\r\n')) { crlfMixed++; detail.push(`CRLF ${rel}: bareLF=${bareLF}`); }
    deletedNonZero += dn; nonCommentAdded += nca; deletedUpstream += du;
  }
  rows.push({ b, commit, files: rels.length, deletedNonZero, nonCommentAdded, deletedUpstream, tokenDrift, syntaxErrorFiles, crlfMixed });
  const bad = rows[rows.length - 1];
  const ok = !bad.deletedNonZero && !bad.nonCommentAdded && !bad.deletedUpstream && !bad.tokenDrift && !bad.syntaxErrorFiles && !bad.crlfMixed;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${b} commit=${commit} files=${bad.files} deletedNonZero=${bad.deletedNonZero} nonCommentAdded=${bad.nonCommentAdded} deletedUpstream=${bad.deletedUpstream} tokenDrift=${bad.tokenDrift} syntaxErrorFiles=${bad.syntaxErrorFiles} crlfMixed=${bad.crlfMixed}`);
  if (detail.length) console.log('  ' + detail.slice(0, 12).join('\n  '));
}
const pass = rows.filter((r) => !r.deletedNonZero && !r.nonCommentAdded && !r.deletedUpstream && !r.tokenDrift && !r.syntaxErrorFiles && !r.crlfMixed).length;
console.log(`TOTAL pass=${pass}/${rows.length}`);
