// 按函数统计函数体内代码行与中文注释行，用于回炉时定位缺口
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lines = text.split(/\r?\n/);
const CJK = /[\u4e00-\u9fff]/;

function isFnLike(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
    || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
}

const fns = [];
const visit = (node) => {
  if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
    const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
    const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
    fns.push({ name: node.name?.getText(sf) ?? '(anon)', s, e });
  }
  ts.forEachChild(node, visit);
};
visit(sf);

for (const f of fns) {
  let com = 0, code = 0, inBlock = false;
  for (let i = f.s; i <= f.e; i++) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    let isCom = false;
    if (inBlock) { isCom = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) isCom = true;
    else if (t.startsWith('/*')) { isCom = true; if (!t.includes('*/')) inBlock = true; }
    if (isCom) { if (CJK.test(t)) com++; } else code++;
  }
  console.log(`${(code ? (com / code) * 100 : 0).toFixed(0)}%\tcom=${com}\tcode=${code}\t${f.name}\tL${f.s + 1}-${f.e + 1}`);
}
