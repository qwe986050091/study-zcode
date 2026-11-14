// 批次注释校验脚本
// 用法：node d:\code\_annot_baseline\cc-verify.mjs <批次名>
//   批次名可带或不带 CC- 前缀，例如 L1-C1-入口与Turn循环 / CC-L1-C1-入口与Turn循环
// 口径：
//   1) 逐文件 git --no-pager diff --no-index --numstat <基线> <工作区>，删除列必须为 0
//   2) 逐文件 ts.createSourceFile 解析，parseDiagnostics 必须为 0
// 输出末行：SUMMARY files=<n> added=<sum> deletedNonZero=<count> syntaxErr=<count>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = 'd:\\code\\claude-code-main';
const BASE = 'd:\\code\\_annot_baseline';

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node cc-verify.mjs <batch>');
  process.exit(2);
}
const batch = rawArg.replace(/^CC-/, '');
const batchDir = path.join(BASE, 'CC-' + batch);
if (!fs.existsSync(batchDir)) {
  console.error('baseline not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
const rels = fs.existsSync(manifest)
  ? fs.readFileSync(manifest, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  : [];

// TypeScript 解析器：优先本地，其次 ZCode 的 node_modules
function loadTs() {
  const candidates = [
    'typescript',
    path.join(BASE, 'node_modules', 'typescript'),
    'd:\\code\\ZCode\\node_modules\\typescript',
    'd:\\code\\node_modules\\typescript',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  return null;
}
const ts = loadTs();
if (!ts) {
  console.error('ERROR: typescript not resolvable, syntax check unavailable');
}

function numstat(baseFile, curFile) {
  const r = spawnSync(
    'git',
    ['--no-pager', 'diff', '--no-index', '--numstat', '--', baseFile, curFile],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const text = (r.stdout || '') + (r.stderr || '');
  let added = 0;
  let deleted = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^([\d-]+)\t([\d-]+)\t/.exec(line);
    if (!m) continue;
    added += m[1] === '-' ? 0 : Number(m[1]);
    deleted += m[2] === '-' ? 0 : Number(m[2]);
  }
  if (r.error) return { added: NaN, deleted: NaN, err: String(r.error) };
  return { added, deleted, err: text.trim() ? '' : '' };
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel);
  const curFile = path.join(ROOT, rel);
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    deletedNonZero++;
    continue;
  }
  const { added, deleted } = numstat(baseFile, curFile);
  addedSum += added;
  checked++;
  if (deleted > 0) {
    deletedNonZero++;
    problems.push(`DELETED ${deleted}  ${rel}`);
  }
  if (ts) {
    const text = fs.readFileSync(curFile, 'utf8');
    const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    const diags = sf.parseDiagnostics || [];
    if (diags.length > 0) {
      syntaxErr++;
      const d = diags[0];
      problems.push(`SYNTAX ${rel}(${d.start}): ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
}

for (const p of problems) console.log(p);
console.log(`SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr}`);
process.exit(deletedNonZero === 0 && syntaxErr === 0 ? 0 : 1);
