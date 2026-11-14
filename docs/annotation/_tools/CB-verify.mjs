// 批次注释校验脚本（Rust / crossbeam-rs/crossbeam）
// 用法：node D:\code\_annot_baseline\CB-verify.mjs <批次名>
//   例：CB-verify.mjs crossbeam-b1 或 CB-verify.mjs CB-crossbeam-b1
// 口径：
//   1) 基线 vs 工作区逐文件 git diff --no-index --numstat：统计新增/删除
//   2) deletedNonZero = 删除的“非空行”总数（空行删除不计），>0 即失败
//   3) 新增行必须是注释或空行（//、/*、* 开头），且新增行内不得出现 */
//   4) 语法校验用 rustfmt（只解析，不落盘、不改格式）：
//      rustfmt --edition 2021 --config-path <空配置> --emit stdout <file>
//      - 2021 取自仓库各级 Cargo.toml 的 edition
//      - --config-path 指向临时目录里的空 rustfmt.toml，避免读到仓库 .rustfmt.toml
//        里的 nightly-only 选项（否则 stable rustfmt 会告警/失败）
//      - 工作目录固定在系统临时目录，避免被仓库工具链配置劫持
//   5) fail-closed：rustfmt 缺失、执行异常都计入 skipped，并以非零码退出
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> skipped=<n> syntaxErr=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX = 'CB';
const DEFAULT_ROOT = 'd:\\code\\opensource\\crossbeam';
const DEFAULT_BASE = 'd:\\code\\_annot_baseline';
const ROOT = process.env.ANNOT_ROOT || DEFAULT_ROOT;
const BASE = process.env.ANNOT_BASE || DEFAULT_BASE;
const EDITION = '2021';

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node CB-verify.mjs <batch>');
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

// ---------- rustfmt 定位（fail-closed） ----------
function findRustfmt() {
  const cands = [];
  if (process.env.RUSTFMT) cands.push(process.env.RUSTFMT);
  cands.push('rustfmt');
  if (process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.cargo', 'bin', 'rustfmt.exe'));
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', cwd: NEUTRAL_CWD });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const rustfmt = findRustfmt();
if (!rustfmt) console.error('ERROR: rustfmt not found, Rust syntax check will be skipped (fail-closed)');

let rustfmtConfig = null;
function neutralConfig() {
  if (rustfmtConfig) return rustfmtConfig;
  rustfmtConfig = path.join(os.tmpdir(), 'annot-empty-rustfmt.toml');
  if (!fs.existsSync(rustfmtConfig)) fs.writeFileSync(rustfmtConfig, '');
  return rustfmtConfig;
}

const syntaxCache = new Map();
function syntaxCheck(rel) {
  if (syntaxCache.has(rel)) return syntaxCache.get(rel);
  const file = path.join(ROOT, rel.split('/').join(path.sep));
  if (!rustfmt) {
    const res = { status: 'skipped', msg: 'rustfmt not found' };
    syntaxCache.set(rel, res);
    return res;
  }
  const r = spawnSync(
    rustfmt,
    // skip_children=true：只解析当前文件，不去解析 mod 子模块
    // （仓库里 crossbeam-*/src/alloc_helper.rs 是符号链接，Windows 检出后变成一行路径文本）
    ['--edition', EDITION, '--config-path', neutralConfig(), '--config', 'skip_children=true', '--emit', 'stdout', file],
    { encoding: 'utf8', cwd: NEUTRAL_CWD, maxBuffer: 32 * 1024 * 1024 },
  );
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
