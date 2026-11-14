#!/usr/bin/env node
/**
 * cc-token-strict.mjs —— 含类型节点的完整 AST 代码等价校验
 *
 * 与 transpileModule / 纯正则 token 比较的区别：本工具用 TypeScript parser 建 AST，
 * 再用 ts.Printer({ removeComments: true }) 重新打印，比较打印结果。类型别名、
 * interface、泛型、import type 等会被 type-erasure 抹掉的节点同样参与比较，
 * 因此能发现「重复声明了一个 type」「删了一个 interface 字段」这类 transpile 看不见的改动。
 *
 * 用法 A（快照目录 + 文件清单）：
 *   node cc-token-strict.mjs <baseDir> <fileList>
 *   例：node cc-token-strict.mjs d:\code\_backup_claude-code-main_20261102 d:\code\_annot_baseline\cc-rework-all.txt
 *
 * 用法 B（git 仓库，对任意 rev 比较工作区）：
 *   node cc-token-strict.mjs --git <repoDir> <rev> [pathPrefix]
 *   例：node cc-token-strict.mjs --git d:\code\ZCode HEAD
 *       node cc-token-strict.mjs --git d:\code\opensource\drizzle-orm HEAD src
 *
 * 输出（每行一条差异，TSV 风格，可直接 grep）：
 *   <path>\tDIFF\tline <n>\tbase=[<首处不同行>]\tcur=[<首处不同行>]\tlen <base行数> vs <cur行数>
 *   <path>\tPARSE-ERROR\t<diagnostic 摘要>
 *   末行固定：SUMMARY files=<n> strictCodeDiff=<m> parseErrors=<k>
 *
 * 退出码：strictCodeDiff=0 且 parseErrors=0 → 0；否则 1。
 * 依赖：typescript（优先本地 node_modules，其次 DEEP-SPEC 工作区内置副本）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function loadTs() {
  const candidates = [
    'typescript',
    'd:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 继续找下一个 */
    }
  }
  console.error('FATAL: 找不到 typescript。请 npm i -D typescript，或设置 TS 路径。');
  process.exit(2);
}
const ts = loadTs();

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

// 归一化行尾：模板字面量与 JSX 文本会原样保留源文件里的 \r，若一侧是 CRLF、
// 另一侧是 LF（git show 常见），会被误报成代码差异。行尾不是代码语义，统一成 LF。
const normalize = (text) => text.replace(/\r\n?/g, '\n');

function printedFromText(fileName, text) {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, normalize(text), ts.ScriptTarget.Latest, false, kind);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    const d = diags[0];
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    return { error: `line ${sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${msg}` };
  }
  return { text: printer.printFile(sf) };
}

const printedFromFile = (file) => printedFromText(file, fs.readFileSync(file, 'utf8'));

function compare(label, baseText, curText) {
  const a = printedFromText(label, baseText);
  const b = printedFromText(label, curText);
  if (a.error || b.error) {
    console.log(`${label}\tPARSE-ERROR\tbase=${a.error ?? 'ok'}\tcur=${b.error ?? 'ok'}`);
    return { diff: true, parseError: true };
  }
  if (a.text === b.text) return { diff: false, parseError: false };
  const la = a.text.split('\n');
  const lb = b.text.split('\n');
  let i = 0;
  for (; i < Math.min(la.length, lb.length); i++) if (la[i] !== lb[i]) break;
  const show = (arr) => (i < arr.length ? arr[i].trim().slice(0, 90) : '<eof>');
  console.log(`${label}\tDIFF\tline ${i + 1}\tbase=[${show(la)}]\tcur=[${show(lb)}]\tlen ${la.length} vs ${lb.length}`);
  return { diff: true, parseError: false };
}

const argv = process.argv.slice(2);
let files = [];
let parseErrors = 0;
let diffFiles = 0;

if (argv[0] === '--git') {
  const [, repo, rev, prefix = ''] = argv;
  if (!repo || !rev) {
    console.error('用法：node cc-token-strict.mjs --git <repoDir> <rev> [pathPrefix]');
    process.exit(2);
  }
  const ls = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', rev], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (ls.status !== 0) {
    console.error(`FATAL: git ls-tree 失败：${(ls.stderr || '').trim()}`);
    process.exit(2);
  }
  const tracked = ls.stdout.split(/\r?\n/).filter((f) => /\.(ts|tsx)$/i.test(f) && f.startsWith(prefix));
  for (const rel of tracked) {
    const curPath = path.join(repo, rel);
    if (!fs.existsSync(curPath)) continue;
    const show = spawnSync('git', ['-C', repo, 'show', `${rev}:${rel}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (show.status !== 0) continue;
    const r = compare(rel, show.stdout, fs.readFileSync(curPath, 'utf8'));
    if (r.diff) diffFiles++;
    if (r.parseError) parseErrors++;
    files.push(rel);
  }
} else {
  const [baseArg, listArg] = argv;
  if (!baseArg || !listArg) {
    console.error('用法：node cc-token-strict.mjs <baseDir> <fileList>');
    process.exit(2);
  }
  const baseDir = path.resolve(baseArg);
  const rels = fs.readFileSync(path.resolve(listArg), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const rel of rels) {
    const a = path.join(baseDir, rel);
    const b = path.join('d:\\code\\claude-code-main', rel);
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
    const r = compare(rel, fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
    if (r.diff) diffFiles++;
    if (r.parseError) parseErrors++;
    files.push(rel);
  }
}

console.log(`SUMMARY files=${files.length} strictCodeDiff=${diffFiles} parseErrors=${parseErrors}`);
process.exit(diffFiles === 0 && parseErrors === 0 ? 0 : 1);
