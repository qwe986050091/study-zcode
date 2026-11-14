// 按「AST 归属 + body_units/body_branch」重算真实可注余量
// 父注释 = 紧邻声明（中间只允许修饰符/装饰器/空行）的 leading comment；不再用行距窗口
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
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.git', 'build'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

// 统计体内单元与分支
function bodyStats(body) {
  let units = 0, branch = 0;
  const visit = (n) => {
    if (ts.isIfStatement(n)) branch++;
    else if (ts.isConditionalExpression(n)) branch++;
    else if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)
      || ts.isWhileStatement(n) || ts.isDoStatement(n)) branch++;
    else if (ts.isSwitchStatement(n)) branch += n.caseBlock.clauses.length;
    else if (ts.isReturnStatement(n)) {
      const p = n.parent;
      if (ts.isBlock(p) && p.statements[p.statements.length - 1] !== n) branch++;
      else if (!ts.isBlock(p)) branch++;
    }
    if (ts.isStatement(n) && !ts.isBlock(n)) units++;
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isSpreadAssignment(n)) units++;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) units += n.arguments.length;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return { units, branch };
}

const rows = [];
for (const file of walk(path.join(REPO, ROOT))) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;

  const leadingDoc = (node) => {
    // 锚点 = 最近的「声明级」节点：语句 / 类成员 / 顶层声明；
    // 回调（调用实参、对象成员里的箭头）向上找到承载它的语句，避免把「函数没有声明」误判成裸函数
    let n = node;
    while (n.parent && !ts.isStatement(n.parent) && !ts.isClassElement(n.parent) && !ts.isSourceFile(n.parent)) n = n.parent;
    if (n.parent && (ts.isStatement(n.parent) || ts.isClassElement(n.parent))) n = n.parent;
    const start = n.getStart(sf);
    const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) || [];
    if (!ranges.length) return null;
    const last = ranges[ranges.length - 1];
    if (text.slice(last.end, start).trim() !== '') return null;
    const ls = text.lastIndexOf('\n', last.pos) + 1;
    if (text.slice(ls, last.pos).trim() !== '') return null;
    return { pos: last.pos, text: text.slice(last.pos, last.end) };
  };
  const enclosingClass = (node) => {
    let p = node.parent;
    while (p) { if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p; p = p.parent; }
    return null;
  };

  const visit = (node) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      const s = lineOf(node.body.getStart(sf)), e = lineOf(node.body.getEnd());
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
        const { units, branch } = bodyStats(node.body);
        const own = leadingDoc(node);
        const parentAdj = !!(own && CJK.test(own.text));
        const parentLine = own ? lineOf(own.pos) + 1 : 0;
        const cls = enclosingClass(node);
        const cdoc = cls ? leadingDoc(cls) : null;
        const classAdj = !parentAdj && !!(cdoc && CJK.test(cdoc.text));
        rows.push({
          file: file.replace(path.join(REPO, ROOT) + '/', '').replace(/\\/g, '/'),
          line: lineOf(node.getStart(sf)) + 1,
          units, branch,
          cover: parentAdj ? 'parent' : classAdj ? 'class' : 'bare',
          parentLine,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const cnt = (f) => rows.filter(f).length;
const exempt = (r) => r.cover !== 'bare' && r.units <= 2 && r.branch === 0;
const need = (r) => !exempt(r);
console.log(`== ${ROOT} ==`);
console.log(`unowned=${rows.length} parent=${cnt(r => r.cover === 'parent')} class=${cnt(r => r.cover === 'class')} bare=${cnt(r => r.cover === 'bare')}`);
console.log(`exempt(父/类覆盖 + units<=2 + branch=0)=${cnt(exempt)}  need=${cnt(need)}`);
console.log(`need by cover: parent=${cnt(r => need(r) && r.cover === 'parent')} class=${cnt(r => need(r) && r.cover === 'class')} bare=${cnt(r => need(r) && r.cover === 'bare')}`);
console.log(`branch>=2 且 need=${cnt(r => need(r) && r.branch >= 2)}  (其中 bare=${cnt(r => need(r) && r.branch >= 2 && r.cover === 'bare')})`);
console.log('--- exempt 样例 5 ---');
for (const r of rows.filter(exempt).slice(0, 5)) console.log(`${r.file}:${r.line}\tunits=${r.units}\tbranch=${r.branch}\t${r.cover}@${r.parentLine}`);
console.log('--- units=0 异常 ---', cnt(r => r.units === 0));
const byFile = {};
for (const r of rows.filter(need)) byFile[r.file] = (byFile[r.file] || 0) + 1;
console.log('--- need by file (top 15) ---');
for (const [f, c] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${f}\t${c}`);
if (process.argv[3] === '--dump') {
  const tag = ROOT.replace(/\W/g, '_');
  const fmt = (r) => `${r.file}\tL${r.line}\tunits=${r.units}\tbranch=${r.branch}\t${r.cover}${r.parentLine ? '@' + r.parentLine : ''}`;
  fs.writeFileSync(`D:/code/_annot_baseline/tmp_need_${tag}.txt`,
    rows.filter(need).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).map(fmt).join('\n') + '\n', 'utf8');
  fs.writeFileSync(`D:/code/_annot_baseline/tmp_bare_${tag}.txt`,
    rows.filter((r) => r.cover === 'bare').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).map(fmt).join('\n') + '\n', 'utf8');
}
