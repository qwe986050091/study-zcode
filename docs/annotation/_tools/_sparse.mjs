// 找出「总中文注释行少、函数体代码行多」的文件：回炉候选（真实空白而非注释位置造成的低内文率）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');
const ROOT = 'D:/code/opensource/drizzle-orm/drizzle-orm/src';
const CJK = /[\u4e00-\u9fff]/;

function isFnLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

const out = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.ts')) continue;
    const text = fs.readFileSync(p, 'utf8');
    const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines = text.split(/\r?\n/);
    const bodyLines = new Set();
    const visit = (node) => {
      if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
        const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
        const en = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
        for (let i = s; i <= en; i++) bodyLines.add(i);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    let totalCjkCom = 0, bodyCode = 0, bodyCom = 0, inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const t = (lines[i] || '').trim();
      const isComStart = t.startsWith('//') || t.startsWith('/*') || inBlock;
      if (isComStart && CJK.test(t)) totalCjkCom++;
      if (inBlock) { if (t.includes('*/')) inBlock = false; }
      else if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
      if (!bodyLines.has(i) || !t) continue;
      const isCom = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
      if (isCom) { if (CJK.test(t)) bodyCom++; } else bodyCode++;
    }
    if (bodyCode >= 50) out.push({ rel: path.relative(ROOT, p).replace(/\\/g, '/'), totalCjkCom, bodyCode, bodyCom });
  }
}
walk(ROOT);
out.sort((a, b) => a.totalCjkCom - b.totalCjkCom || b.bodyCode - a.bodyCode);
console.log('totalCom\tbodyCom\tbodyCode\tfile');
for (const r of out.slice(0, 40)) console.log(`${r.totalCjkCom}\t${r.bodyCom}\t${r.bodyCode}\t${r.rel}`);
