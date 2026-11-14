// 生成 R58 的「父级未覆盖」清单：kit 裸函数（父级 4 行内无中文注释、类声明前 4 行内也无）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOT = 'drizzle-kit/src';
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
function fnName(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
    return parent.name.getText();
  }
  return '<anonymous>';
}

const out = [];
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
  const hasCjkAbove = (line, span = 4) => {
    for (let i = Math.max(0, line - span); i < line; i++) {
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
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        if (!hasCjkAbove(startLine)) {
          const cls = enclosingClass(node);
          const clsLine = cls ? sf.getLineAndCharacterOfPosition(cls.getStart(sf)).line : -1;
          if (!(cls && hasCjkAbove(clsLine))) {
            out.push({
              file: file.replace(path.join(REPO, ROOT) + '/', '').replace(/\\/g, '/'),
              line: startLine + 1,
              name: fnName(node),
              code,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const linesOut = [`# R58 候选：kit「父级未覆盖」裸函数 ${out.length} 个（口径：body 无中文注释 + 起始行前 4 行无注释 + 类声明前 4 行无注释 + code>0 + 非空体）`, `# 注：gelSerializer L768 是 R57b 删掉 769 后产生的回调，其父句在 :757（距 11 行，超出口径窗口），属口径误报，实际可按「父级已覆盖」不插。`, `# 分批：R58 = snapshotsDiffer 39 + sqlgenerator 5 + 散件 6 = 50；R59 = jsonStatements 28`, ''];
let last = '';
for (const r of out) {
  if (r.file !== last) { linesOut.push('', `## ${r.file}`); last = r.file; }
  linesOut.push(`L${r.line}\t${r.name}\tcode=${r.code}`);
}
fs.writeFileSync('D:/code/_annot_baseline/R58-candidates.txt', linesOut.join('\n') + '\n', 'utf8');
console.log('total', out.length);
const byFile = {};
for (const r of out) byFile[r.file] = (byFile[r.file] || 0) + 1;
console.log(byFile);
