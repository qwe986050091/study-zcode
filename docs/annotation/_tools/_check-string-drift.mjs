// 全量校验：每个文件的字符串 / 模板字符串 / 正则字面量内文必须与 HEAD 逐字面量一致。
// 收尾六件套第六件（见 DEEP-SPEC.md §5.1 与 ZC-legacy-cleanup-queue.md §43）：
//   check-code-tokens 只比 token 种类，往字符串里加字看不见；本脚本才看得见。
// 用法：node _check-string-drift.mjs [files.txt]
// 判据：stringDriftFiles=0 且 parseFailed=0；任一非零即 exit 1（fail-closed）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'file:///D:/code/ZCode/node_modules/typescript/lib/typescript.js';

const REPO = 'D:/code/ZCode';
const LIST = process.argv[2] || 'D:/code/_annot_baseline/ZC-lc-adjacent.txt';
const KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
const lits = (text, fileName) => {
  const norm = text.replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile(
    fileName,
    norm,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) return null;
  const out = [];
  const walk = (n) => {
    if (KINDS.has(n.kind)) out.push(n.getText(sf));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
};
const first = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};

const files = fs.readFileSync(LIST, 'utf8').trim().split(/\r?\n/);
let drift = 0;
let parseFailed = 0;
for (const rel of files) {
  const cur = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const head = spawnSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  const a = lits(head, rel);
  const b = lits(cur, rel);
  if (a === null || b === null) {
    parseFailed++;
    console.log(`PARSE FAIL ${rel} head=${a === null} cur=${b === null}`);
    continue;
  }
  const k = first(a, b);
  if (k !== -1) {
    drift++;
    console.log(`DRIFT ${rel} lit#${k}`);
    console.log('  head=' + JSON.stringify(a[k] ?? '<eof>').slice(0, 160));
    console.log('  cur =' + JSON.stringify(b[k] ?? '<eof>').slice(0, 160));
  }
}
console.log(
  `SUMMARY files=${files.length} stringDriftFiles=${drift} parseFailed=${parseFailed}`,
);
if (drift || parseFailed) process.exit(1);
