// kit 真实可注余量：无归属函数体 → 父级注释覆盖 → 类级注释覆盖 → 真正可注
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

let total = 0, parentCovered = 0, classCovered = 0, bare = 0;
const bareByFile = {};
const classCoveredByFile = {};
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const covered = (s, e) => {
    for (let i = s; i <= e; i++) if (/^\s*\/[{/*]/.test(lines[i]) && CJK.test(lines[i])) return true;
    return false;
  };
  // 从节点向上找最近的 ClassDeclaration / ClassExpression
  const enclosingClass = (node) => {
    let p = node.parent;
    while (p) {
      if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p;
      p = p.parent;
    }
    return null;
  };
  const classHasDoc = (cls) => {
    if (!cls) return false;
    const l = sf.getLineAndCharacterOfPosition(cls.getStart(sf)).line;
    for (let i = Math.max(0, l - 4); i < l; i++) {
      if (/^\s*\/[{/*]/.test(lines[i]) && CJK.test(lines[i])) return true;
    }
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
        else if (classHasDoc(enclosingClass(node))) {
          classCovered++;
          const rel = file.replace(ROOT + '/', '');
          (classCoveredByFile[rel] ||= []).push(startLine + 1);
        } else {
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
console.log(`unowned=${total} parentCovered=${parentCovered} classCovered=${classCovered} bare=${bare}`);
console.log(`real = ${bare}`);
console.log('--- classCovered top ---');
for (const [f, ls] of Object.entries(classCoveredByFile).sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`${f}\t${ls.length}\t${ls.slice(0, 8).join(',')}`);
}
console.log('--- bare top ---');
for (const [f, ls] of Object.entries(bareByFile).sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
  console.log(`${f}\t${ls.length}\t${ls.slice(0, 8).join(',')}`);
}
