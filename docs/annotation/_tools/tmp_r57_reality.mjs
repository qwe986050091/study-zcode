// 统计 kit 无归属函数体里「父级块注释已覆盖」与「真正没有注释」的数量
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const ROOT = 'D:/code/opensource/drizzle-orm/drizzle-kit/src';
const CJK = /[\u4e00-\u9fff]/;
const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

let total = 0, parentCovered = 0, bare = 0;
const bareByFile = {};
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const covered = (s, e) => {
    for (let i = s; i <= e; i++) if (/^\s*\/[{/*]/.test(lines[i]) && CJK.test(lines[i])) return true;
    return false;
  };
  const visit = (node) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      if (!covered(s, e)) {
        total++;
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        let pc = false;
        for (let i = Math.max(0, startLine - 4); i < startLine; i++) {
          if (/^\s*\/[{/*]/.test(lines[i]) && CJK.test(lines[i])) { pc = true; break; }
        }
        if (pc) parentCovered++;
        else {
          bare++;
          const rel = file.replace(ROOT + '/', '');
          (bareByFile[rel] ||= []).push(startLine + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(`unowned=${total} parentCovered=${parentCovered} bare=${bare}`);
for (const [f, ls] of Object.entries(bareByFile).sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`${f}\t${ls.length}\t${ls.slice(0, 8).join(',')}`);
}
