// 扫描并清理「字符串 / 模板字符串字面量内部、以 // 开头的行」。
// 判据：
//   1) 该行落在某个字符串字面量（含模板分片）的行区间内 —— 它不是注释。
//   2) 该行相对 HEAD 是新增的（trim 后在 HEAD 中不存在）—— 即本注释线自己写进去的。
// 只删除第 2 类；删后用 TypeScript 提取字面量内文，逐字面量与 HEAD 比对。
// 用法：node _scan-string-comments.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringLiteralLineRanges } from './zc-gate.mjs';

const REPO = 'D:/code/ZCode';
const LIST = 'D:/code/_annot_baseline/ZC-lc-adjacent.txt';
const APPLY = process.argv.includes('--apply');
const ts = (await import('file:///D:/code/ZCode/node_modules/typescript/lib/typescript.js')).default;

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
const literalTexts = (text, fileName) => {
  const norm = text.replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile(fileName, norm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const walk = (node) => {
    if (LITERAL_KINDS.has(node.kind)) out.push(node.getText(sf));
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
};
const firstMismatch = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};

const files = fs.readFileSync(LIST, 'utf8').trim().split(/\r?\n/);
let totalOwn = 0;
let totalUpstream = 0;
const perFile = [];

for (const rel of files) {
  const abs = path.join(REPO, rel);
  const curText = fs.readFileSync(abs, 'utf8');
  const headText = spawnSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  if (headText === '' || headText == null) {
    console.error(`FAIL head: ${rel}`);
    process.exit(1);
  }
  const ranges = stringLiteralLineRanges(curText, rel);
  if (!ranges) {
    console.error(`SKIP parse: ${rel}`);
    continue;
  }
  const headSet = new Set(headText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()));
  const lines = curText.replace(/\r\n/g, '\n').split('\n');
  const own = [];
  const up = [];
  for (const ln of ranges) {
    const body = lines[ln - 1] ?? '';
    if (!body.trim().startsWith('//')) continue;
    if (headSet.has(body.trim())) up.push(ln);
    else own.push(ln);
  }
  if (own.length || up.length) perFile.push({ rel, own: own.length, upstream: up.length, ownLines: own });
  totalOwn += own.length;
  totalUpstream += up.length;

  if (APPLY && own.length) {
    const keep = lines.filter((_, i) => !own.includes(i + 1));
    fs.writeFileSync(abs, keep.join('\n') + (curText.endsWith('\n') ? '\n' : ''));
    const after = literalTexts(keep.join('\n'), rel);
    const headLits = literalTexts(headText, rel);
    const k = firstMismatch(headLits, after);
    if (k !== -1) {
      console.error(`STRING DRIFT after clean: ${rel} lit#${k}`);
      console.error('  head=' + JSON.stringify(headLits[k] ?? '<eof>').slice(0, 200));
      console.error('  cur =' + JSON.stringify(after[k] ?? '<eof>').slice(0, 200));
      process.exit(1);
    }
  }
}

for (const p of perFile) console.log(`${p.rel}\town=${p.own}\tupstream=${p.upstream}\tlines=${p.ownLines.join(',')}`);
console.log(`SUMMARY files=${files.length} filesHit=${perFile.length} ownStringCommentLines=${totalOwn} upstreamStringLines=${totalUpstream} applied=${APPLY}`);
