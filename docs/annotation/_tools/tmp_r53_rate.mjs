// R53 内文率前后对照：对 orig 与工作区各跑一次同样的函数体口径。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';
const batch = process.argv[2] ?? 'R53';
const CJK = /[\u4e00-\u9fff]/;

const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const bodyLines = new Set();
  const visit = (node) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      for (let i = s; i <= e; i++) bodyLines.add(i);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let inBlock = false, com = 0, code = 0;
  for (const i of [...bodyLines].sort((a, b) => a - b)) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock = true; }
    if (isComment) { if (CJK.test(t)) com++; } else code++;
  }
  return { com, code };
}

const rels = fs.readFileSync(path.join(BASE, batch, '_files.txt'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
let bc = 0, bk = 0, ac = 0, ak = 0;
for (const rel of rels) {
  const b = analyze(path.join(BASE, batch, 'orig', rel));
  const a = analyze(path.join(REPO, rel));
  bc += b.com; bk += b.code; ac += a.com; ak += a.code;
  console.log(`${rel}\t${b.com}/${b.code}=${(b.com / b.code * 100).toFixed(1)}%\t->\t${a.com}/${a.code}=${(a.com / a.code * 100).toFixed(1)}%`);
}
console.log(`TOTAL\t${bc}/${bk}=${(bc / bk * 100).toFixed(1)}%\t->\t${ac}/${ak}=${(ac / ak * 100).toFixed(1)}%`);
