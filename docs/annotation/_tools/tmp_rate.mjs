import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');
const CJK = /[\u4e00-\u9fff]/;
const batch = 'D:/code/_annot_baseline/' + process.argv[2];
const files = fs.readFileSync(path.join(batch, '_files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const ROOT = 'D:/code/opensource/drizzle-orm';
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
function stat(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split('\n');
  let code = 0, com = 0;
  const visit = (n) => {
    if (isFn(n) && n.body && ts.isBlock(n.body)) {
      const s = sf.getLineAndCharacterOfPosition(n.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(n.body.getEnd()).line;
      for (let i = s; i <= e; i++) {
        const t = (lines[i] || '').trim();
        if (!t) continue;
        if (t.startsWith('//')) { if (CJK.test(t)) com++; } else code++;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { code, com };
}
let c0 = 0, k0 = 0, c1 = 0, k1 = 0;
for (const rel of files) {
  const a = stat(path.join(batch, 'orig', rel));
  const b = stat(path.join(ROOT, rel));
  c0 += a.com; k0 += a.code; c1 += b.com; k1 += b.code;
  console.log(`${rel}\t${a.com}/${a.code} = ${(a.com / a.code * 100).toFixed(1)}%\t->\t${b.com}/${b.code} = ${(b.com / b.code * 100).toFixed(1)}%\tdelta=${b.com - a.com}`);
}
console.log(`TOTAL\t${c0}/${k0} = ${(c0 / k0 * 100).toFixed(1)}%\t->\t${c1}/${k1} = ${(c1 / k1 * 100).toFixed(1)}%\tdelta=${c1 - c0}`);
