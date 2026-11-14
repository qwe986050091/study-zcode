#!/usr/bin/env node
// claude-code-main 深度注释回炉校验
//
// 用法：node cc-rw-verify.mjs <baselineDir> <fileList>
//   baselineDir  基线快照根目录（保持相对路径）
//   fileList     每行一个相对 repo 根的文件路径
//
// 每文件校验：
//   1) deletedNonZero：diff 删除行数必须为 0
//   2) addedNonComment：新增行 trim 后必须全部以 // 开头
//   3) starSlash：新增注释内不得出现 */
//   4) codeTokenDiff：TypeScript scanner 逐 token 比较（跳过注释/空白/换行），必须逐字一致
//   5) syntaxErrorFiles：当前文件 parseDiagnostics 必须为 0
// 退出码：全部通过 0，否则 1。末行 SUMMARY 便于记账。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = 'd:\\code\\claude-code-main';
function loadTs() {
  const candidates = [
    'd:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js',
    'd:/code/ZCode/node_modules/typescript/lib/typescript.js',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return require(p);
  console.error('ERROR: 找不到 TypeScript 解析器');
  process.exit(1);
}
const ts = loadTs();

const [baseArg, listArg] = process.argv.slice(2);
if (!baseArg || !listArg) {
  console.error('usage: node cc-rw-verify.mjs <baselineDir> <fileList>');
  process.exit(2);
}
const baseDir = path.resolve(baseArg);
const rels = fs.readFileSync(path.resolve(listArg), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function diffNoIndex(a, b) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', a, b], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) throw new Error(String(r.error));
  return r.stdout || '';
}

// 解析 -U0 diff，返回 { added: string[], deleted: number }
function parseDiff(text) {
  const added = [];
  let deleted = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (raw.startsWith('+')) added.push(raw.slice(1));
    else if (raw.startsWith('-')) deleted++;
  }
  return { added, deleted };
}

// 代码 token 等价：用 TypeScript 转译并 removeComments，输出经 emitter 统一格式，
// 空白/注释增删不会造成差异，代码 token 变化才会。避免手写 scanner 在模板字符串
// 与 JSX 上的误判。
function codeOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: true,
    },
    fileName: file,
  }).outputText;
  return {
    code: out.replace(/^\/\/# sourceMappingURL=.*$/gm, '').trim(),
    diag: sf.parseDiagnostics.length,
  };
}

let deletedNonZero = 0;
let addedNonComment = 0;
let starSlash = 0;
let codeTokenDiff = 0;
let syntaxErrorFiles = 0;
let totalAdded = 0;
const rows = [];
for (const rel of rels) {
  const cur = path.join(REPO, rel);
  const base = path.join(baseDir, rel);
  if (!fs.existsSync(base)) {
    console.error('MISSING baseline: ' + base);
    process.exit(1);
  }
  const d = parseDiff(diffNoIndex(base, cur));
  if (d.deleted > 0) deletedNonZero++;
  let bad = 0;
  for (const line of d.added) {
    const t = line.trim();
    if (!t.startsWith('//')) bad++;
    if (t.includes('*/')) starSlash++;
  }
  if (bad) addedNonComment++;
  const a = codeOf(base);
  const b = codeOf(cur);
  const tokenSame = a.code === b.code;
  if (!tokenSame) codeTokenDiff++;
  if (b.diag > 0) syntaxErrorFiles++;
  totalAdded += d.added.length;
  rows.push({ rel, added: d.added.length, deleted: d.deleted, nonComment: bad, tokenSame, syntax: b.diag === 0 });
}
for (const r of rows) {
  console.log(`${r.rel}\tadded=${r.added}\tdeleted=${r.deleted}\tnonComment=${r.nonComment}\ttoken=${r.tokenSame ? 'ok' : 'DIFF'}\tsyntax=${r.syntax ? 'ok' : 'ERR'}`);
}
console.log(
  `SUMMARY files=${rels.length} added=${totalAdded} deletedNonZero=${deletedNonZero} addedNonComment=${addedNonComment} starSlash=${starSlash} codeTokenDiff=${codeTokenDiff} syntaxErrorFiles=${syntaxErrorFiles}`,
);
process.exit(deletedNonZero || addedNonComment || starSlash || codeTokenDiff || syntaxErrorFiles ? 1 : 0);
