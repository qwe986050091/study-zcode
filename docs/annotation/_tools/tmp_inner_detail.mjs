import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');
const CJK = /[\u4e00-\u9fff]/;
const files = process.argv.slice(2);
function isFnLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  console.log('=== ' + file);
  const visit = (node, depth) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      let code = 0, com = 0;
      for (let i = s; i <= e; i++) {
        const t = (lines[i] || '').trim();
        if (!t) continue;
        if (t.startsWith('//')) { if (CJK.test(t)) com++; } else code++;
      }
      const name = node.name?.getText(sf) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : '<anon>');
      console.log('  '.repeat(depth) + `${name}: lines ${s + 1}-${e + 1} code=${code} com=${com}`);
    }
    ts.forEachChild(node, (c) => visit(c, depth + 1));
  };
  visit(sf, 0);
}
