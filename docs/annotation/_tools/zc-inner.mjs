// 内文率度量：函数体内部「中文注释整行」行数 ÷ 函数体内部「代码行」行数。
// 目的：识别「文件头写满、函数体几乎无注释」的虚高密度文件。
// 用法：
//   node zc-inner.mjs [--repo D:/code/ZCode] [--roots packages/services/src]
//                     [--threshold 15] [--out x.json] [--top 40]
// 口径：
//   - 函数体 = FunctionDeclaration / Method / Constructor / Accessor / FunctionExpression / ArrowFunction 的 Block
//   - 注释行 = 该行只含注释 trivia（整行注释），行尾注释不计（与 deep-density 一致）
//   - 中文注释 = 注释文本含 CJK 字符；英文注释不计入分子
//   - 代码行 = 该行含至少一个非 trivia token；空行不计
//   - 嵌套函数按「行集合的并集」统计，避免同一行重复计数
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {
  repo: 'D:/code/ZCode',
  roots: 'packages/services/src',
  threshold: 15,
  out: '',
  top: 40,
  fns: 3,
  only: [],
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo') opt.repo = argv[++i];
  else if (argv[i] === '--roots') opt.roots = argv[++i];
  else if (argv[i] === '--threshold') opt.threshold = Number(argv[++i]);
  else if (argv[i] === '--out') opt.out = argv[++i];
  else if (argv[i] === '--top') opt.top = Number(argv[++i]);
  else if (argv[i] === '--fns') opt.fns = Number(argv[++i]);
  else if (argv[i] === '--only') opt.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else {
    console.error('unknown arg: ' + argv[i]);
    process.exit(2);
  }
}

const tsPath = path.join(opt.repo, 'node_modules/typescript/lib/typescript.js');
// 允许测量快照目录（--repo 指向 orig 快照）时回落到主仓库的 typescript。
const tsFallback = 'D:/code/ZCode/node_modules/typescript/lib/typescript.js';
if (!fs.existsSync(tsPath) && !fs.existsSync(tsFallback)) {
  console.error('FAIL: typescript not found at ' + tsPath);
  process.exit(1);
}
const ts = (await import('file:///' + (fs.existsSync(tsPath) ? tsPath : tsFallback).replace(/\\/g, '/'))).default;

const WALK_SKIP = new Set(['target', 'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.tmp']);
const fileExclude = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /(^|\/)(__tests__|tests|test|fixtures|examples|__mocks__|mocks)(\/|$)/, /\.d\.ts$/];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (WALK_SKIP.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
}

function analyze(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineCount = lineStarts.length;
  const hasCode = new Uint8Array(lineCount);
  const hasComment = new Uint8Array(lineCount);
  const hasZhComment = new Uint8Array(lineCount);

  // 注释范围取自 AST 的 leading/trailing trivia（含标点 token，块尾与联合类型成员间的
  // 注释才不漏），不用裸 scanner：scanner 在模板字面量 `${}` 之后会与解析器状态失步。
  const covered = new Uint8Array(text.length);
  const addRanges = (rs) => {
    if (!rs) return;
    for (const r of rs) for (let i = r.pos; i < r.end; i++) covered[i] = 1;
  };
  addRanges(ts.getLeadingCommentRanges(text, 0));
  const coverVisit = (node) => {
    addRanges(ts.getLeadingCommentRanges(text, node.getFullStart()));
    addRanges(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const kid of node.getChildren(sf)) coverVisit(kid);
  };
  coverVisit(sf);

  // 逐行判定：非空白字符全在注释范围内 = 整行注释；有任一在范围外 = 代码行。
  for (let l = 0; l < lineCount; l++) {
    const start = lineStarts[l];
    const end = l + 1 < lineCount ? lineStarts[l + 1] : text.length;
    for (let i = start; i < end; i++) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
      if (covered[i]) {
        hasComment[l] = 1;
        if (/[\u4e00-\u9fff]/.test(ch)) hasZhComment[l] = 1;
      } else {
        hasCode[l] = 1;
      }
    }
  }

  // 收集所有函数体行区间（嵌套函数取并集）。
  const inner = new Uint8Array(lineCount);
  const fns = [];
  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node);
    if (isFn && node.body && ts.isBlock(node.body)) {
      const start = node.body.getStart(sf) + 1;
      const end = Math.max(start, node.body.getEnd() - 1);
      const sLine = lineOf(start);
      const eLine = lineOf(end);
      const name = node.name?.getText?.(sf) || (ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>');
      let code = 0;
      let zh = 0;
      for (let l = sLine; l <= eLine; l++) {
        inner[l] = 1;
        if (hasCode[l]) code++;
        else if (hasComment[l] && hasZhComment[l]) zh++;
      }
      fns.push({ name, line: sLine + 1, code, zh, ratio: code ? (zh / code) * 100 : 100 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let innerCode = 0;
  let innerZh = 0;
  for (let l = 0; l < lineCount; l++) {
    if (!inner[l]) continue;
    if (hasCode[l]) innerCode++;
    else if (hasComment[l] && hasZhComment[l]) innerZh++;
  }
  return { innerCode, innerZh, ratio: innerCode ? (innerZh / innerCode) * 100 : 100, fns };
}

const roots = opt.roots.split(',').map((s) => s.trim()).filter(Boolean);
const files = [];
for (const r of roots) walk(path.join(opt.repo, r), files);

const rows = [];
for (const abs of files) {
  const rel = path.relative(opt.repo, abs).replace(/\\/g, '/');
  if (opt.only.length && !opt.only.includes(rel)) continue;
  if (fileExclude.some((re) => re.test(rel))) continue;
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.error('ERROR: cannot read ' + rel + ': ' + e.message);
    process.exit(1);
  }
  let res;
  try {
    res = analyze(text, rel);
  } catch (e) {
    console.error('ERROR: parse failed ' + rel + ': ' + e.message);
    process.exit(1);
  }
  rows.push({ path: rel, ...res });
}

rows.sort((a, b) => a.ratio - b.ratio || a.path.localeCompare(b.path));
const below = rows.filter((r) => r.ratio < opt.threshold && r.innerCode > 0);

console.log(`SUMMARY files=${rows.length} innerCode=${rows.reduce((n, r) => n + r.innerCode, 0)} innerZh=${rows.reduce((n, r) => n + r.innerZh, 0)} below${opt.threshold}=${below.length} min=${(rows[0]?.ratio ?? 0).toFixed(2)} median=${(rows.length ? rows[(rows.length / 2) | 0].ratio : 0).toFixed(2)}`);
console.log('');
console.log(`低于 ${opt.threshold}% 的文件（innerZh/innerCode）：`);
for (const r of below) {
  console.log(`${r.ratio.toFixed(2)}%\t${r.innerZh}/${r.innerCode}\t${r.path}`);
}

console.log('');
console.log(`最差的 ${Math.min(opt.top, rows.length)} 个文件（含函数明细前 3）：`);
for (const r of rows.slice(0, opt.top)) {
  console.log(`${r.ratio.toFixed(2)}%\t${r.innerZh}/${r.innerCode}\t${r.path}`);
  const worst = r.fns
    .filter((f) => f.code >= 5)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, opt.fns);
  for (const f of worst) console.log(`\t  ${f.name}@${f.line}  ${f.ratio.toFixed(1)}% ${f.zh}/${f.code}`);
}

if (opt.out) {
  fs.writeFileSync(opt.out, JSON.stringify({ threshold: opt.threshold, rows }, null, 2));
  console.log('json=' + opt.out);
}
