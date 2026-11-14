// 批次注释校验脚本（TypeScript / mobxjs/mobx）
// 用法：node D:\code\_annot_baseline\MX-verify.mjs <批次名>
//   例：MX-verify.mjs mobx-b1 或 MX-verify.mjs MX-mobx-b1
// 口径：
//   1) 基线 vs 工作区逐文件 git diff --no-index --numstat：统计新增/删除
//   2) deletedNonZero = 删除的“非空行”总数（空行删除不计），>0 即失败
//   3) 新增行必须是注释或空行（//、/*、* 开头），且新增行内不得出现 */
//   4) 语法校验用 Node 内置解析器：node --check <file>
//      - 本机 Node v26 默认做 TypeScript 类型擦除，实测可解析 mobx core 全部 .ts
//      - 不读取 tsconfig、不解析 import，纯语法检查；工作目录固定在系统临时目录
//      - 说明：仓库里的 global.d.ts 不纳入批次（类型声明不注释）；若误纳入，node --check
//        会因 declare 语法失败并被计为 syntaxErr，不会被放过
//   5) fail-closed：node 缺失、执行异常都计入 skipped，并以非零码退出
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> skipped=<n> syntaxErr=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX = 'MX';
const DEFAULT_ROOT = 'd:\\code\\opensource\\mobx';
const DEFAULT_BASE = 'd:\\code\\_annot_baseline';
const ROOT = process.env.ANNOT_ROOT || DEFAULT_ROOT;
const BASE = process.env.ANNOT_BASE || DEFAULT_BASE;

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node MX-verify.mjs <batch>');
  process.exit(2);
}
const batch = rawArg.startsWith(PREFIX + '-') ? rawArg : PREFIX + '-' + rawArg;
const batchDir = path.join(BASE, batch);
if (!fs.existsSync(batchDir)) {
  console.error('baseline not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
if (!fs.existsSync(manifest)) {
  console.error('manifest not found: ' + manifest);
  process.exit(2);
}
const rels = fs
  .readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(/\s+/)[0]);

if (rels.length === 0) {
  console.error('empty manifest: ' + manifest);
  process.exit(2);
}

const NEUTRAL_CWD = os.tmpdir();

// ---------- node 定位（fail-closed） ----------
function findNode() {
  const cands = [];
  if (process.env.NODE) cands.push(process.env.NODE);
  cands.push('node');
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', cwd: NEUTRAL_CWD });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const node = findNode();
if (!node) console.error('ERROR: node not found, TypeScript syntax check will be skipped (fail-closed)');

const syntaxCache = new Map();
function syntaxCheck(rel) {
  if (syntaxCache.has(rel)) return syntaxCache.get(rel);
  const file = path.join(ROOT, rel.split('/').join(path.sep));
  if (!node) {
    const res = { status: 'skipped', msg: 'node not found' };
    syntaxCache.set(rel, res);
    return res;
  }
  const r = spawnSync(node, ['--check', file], {
    encoding: 'utf8',
    cwd: NEUTRAL_CWD,
    maxBuffer: 16 * 1024 * 1024,
  });
  let res;
  if (r.error) res = { status: 'skipped', msg: String(r.error) };
  else if (r.status !== 0) res = { status: 'err', msg: firstLine(r.stderr) || 'exit ' + r.status };
  else res = { status: 'ok' };
  syntaxCache.set(rel, res);
  return res;
}

function firstLine(s) {
  return (s || '').trim().split(/\r?\n/)[0] || '';
}

// ---------- diff ----------
function runGit(args) {
  return spawnSync('git', ['--no-pager', ...args], {
    encoding: 'utf8',
    cwd: NEUTRAL_CWD,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function numstat(baseFile, curFile) {
  const r = runGit(['diff', '--no-index', '--numstat', '--', baseFile, curFile]);
  let added = 0;
  let deleted = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    added += m[1] === '-' ? 0 : Number(m[1]);
    deleted += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { added, deleted };
}

function diffLines(baseFile, curFile) {
  const r = runGit(['diff', '--no-index', '-U0', '--', baseFile, curFile]);
  const added = [];
  const deleted = [];
  let newLine = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added.push({ text: line.slice(1), line: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      deleted.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return { added, deleted };
}

const COMMENT_PREFIXES = ['//', '/*', '*'];
function isCommentOrBlank(text) {
  const t = text.trim();
  if (t === '') return true;
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let skipped = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel.split('/').join(path.sep));
  const curFile = path.join(ROOT, rel.split('/').join(path.sep));
  const bExists = fs.existsSync(baseFile);
  const cExists = fs.existsSync(curFile);
  if (!bExists || !cExists) {
    problems.push(`MISSING ${rel} (baseline=${bExists}, current=${cExists})`);
    deletedNonZero++;
    continue;
  }
  const ns = numstat(baseFile, curFile);
  addedSum += ns.added;
  checked++;

  const dl = diffLines(baseFile, curFile);
  deletedNonZero += dl.deleted.filter((s) => s.trim() !== '').length;
  for (const a of dl.added) {
    if (a.text.includes('*/')) {
      problems.push(`CLOSER ${rel}:${a.line} 新增行含 */`);
    } else if (!isCommentOrBlank(a.text)) {
      problems.push(`NONCOMMENT ${rel}:${a.line} ${a.text.slice(0, 80)}`);
    }
  }

  const sc = syntaxCheck(rel);
  if (sc.status === 'skipped') {
    skipped++;
    problems.push(`SKIPPED ${rel}: ${sc.msg}`);
  } else if (sc.status === 'err') {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} skipped=${skipped} syntaxErr=${syntaxErr}`,
);
process.exit(
  checked > 0 && deletedNonZero === 0 && syntaxErr === 0 && skipped === 0 && problems.length === 0 ? 0 : 1,
);
