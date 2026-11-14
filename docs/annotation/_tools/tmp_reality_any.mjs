// kit/orm 真实可注余量（口径与 tmp_ownership.mjs 一致：com===0 && code>0 && !isEmpty）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOT = process.argv[2];
const CJK = /[\u4e00-\u9fff]/;
const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '.git', 'build'].includes(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

let unowned = 0, parentCovered = 0, classCovered = 0, bare = 0;
const bareByFile = {};

for (const file of walk(path.join(REPO, ROOT))) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
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
      let com = 0, code = 0, inB = false;
      for (let i = s; i <= e; i++) {
        const t = (lines[i] || '').trim();
        if (!t) continue;
        let isCom = false;
        if (inB) { isCom = true; if (t.includes('*/')) inB = false; }
        else if (t.startsWith('//')) isCom = true;
        else if (t.startsWith('/*')) { isCom = true; if (!t.includes('*/')) inB = true; }
        if (isCom) { if (CJK.test(t)) com++; } else code++;
      }
      if (com === 0 && code > 0 && node.body.statements.length !== 0) {
        unowned++;
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        let pc = false;
        for (let i = Math.max(0, startLine - 4); i < startLine; i++) {
          if (/^\s*\/[{/*]/.test(lines[i]) && CJK.test(lines[i])) { pc = true; break; }
        }
        if (pc) parentCovered++;
        else if (classHasDoc(enclosingClass(node))) classCovered++;
        else {
          bare++;
          const rel = file.replace(path.join(REPO, ROOT) + '/', '').replace(/\\/g, '/');
          (bareByFile[rel] ||= []).push(startLine + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(ROOT);
console.log(`unowned=${unowned} parentCovered=${parentCovered} classCovered=${classCovered} bare=${bare}`);
console.log(`coverRate=${(parentCovered / unowned * 100).toFixed(1)}%  classRate=${(classCovered / unowned * 100).toFixed(1)}%`);
for (const [f, ls] of Object.entries(bareByFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${f}\t${ls.length}\t${ls.slice(0, 10).join(',')}`);
}
