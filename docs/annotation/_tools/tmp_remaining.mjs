// 列出当前「有函数体、内文率=0」的文件，按目录分组，用于分批补写
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src', 'drizzle-seed/src'];
const EXEMPT_FILE = 'D:/code/_annot_baseline/exempt-empty-body.txt';
const CJK = /[\u4e00-\u9fff]/;

// 白名单是给人看的例外表，不是让脚本闭嘴的开关：命中的文件从「待补缺口」移入「已登记豁免」，两段都要打印。
function readExempt() {
  const out = new Map();
  if (!fs.existsSync(EXEMPT_FILE)) return out;
  for (const raw of fs.readFileSync(EXEMPT_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [target, reasonField = 'reason=未知', formField = ''] = line.split('\t');
    const m = target.match(/^(.*?):(\d+)$/);
    if (!m) continue;
    out.set(m[1], {
      rel: m[1],
      line: Number(m[2]),
      reason: reasonField.replace(/^reason=/, ''),
      form: formField.replace(/^form=/, ''),
    });
  }
  return out;
}
const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.git', 'build'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
}
function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const bodyLines = new Set();
  let fnCount = 0;
  const visit = (node) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      fnCount++;
      const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      for (let i = s; i <= e; i++) bodyLines.add(i);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let bodyCom = 0, bodyCode = 0, fileCom = 0, inB = false, inB2 = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let c = false;
    if (inB) { c = true; if (t.includes('*/')) inB = false; }
    else if (t.startsWith('//')) c = true;
    else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inB = true; }
    if (c && CJK.test(t)) fileCom++;
  }
  for (const i of bodyLines) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    let c = false;
    if (inB2) { c = true; if (t.includes('*/')) inB2 = false; }
    else if (t.startsWith('//')) c = true;
    else if (t.startsWith('/*')) { c = true; if (!t.includes('*/')) inB2 = true; }
    if (c) { if (CJK.test(t)) bodyCom++; } else bodyCode++;
  }
  return { fileCom, bodyCom, bodyCode, fnCount };
}

const files = [];
for (const r of ROOTS) { const a = path.join(REPO, r); if (fs.existsSync(a)) walk(a, files); }
const zero = [];
for (const abs of files) {
  let r; try { r = analyze(abs); } catch { continue; }
  if (r.fileCom > 0 && r.bodyCom === 0 && r.bodyCode > 0) zero.push({ rel: path.relative(REPO, abs).replace(/\\/g, '/'), ...r });
}
const exempt = readExempt();
const exempted = zero.filter((x) => exempt.has(x.rel)).map((x) => ({ ...x, ...exempt.get(x.rel) }));
const pending = zero.filter((x) => !exempt.has(x.rel));

console.log(`待补 ${pending.length} / 已豁免 ${exempted.length}`);
console.log(
  `待补代码行=${pending.reduce((a, b) => a + b.bodyCode, 0)} 待补函数体=${pending.reduce((a, b) => a + b.fnCount, 0)}` +
  ` | 已豁免代码行=${exempted.reduce((a, b) => a + b.bodyCode, 0)} 已豁免函数体=${exempted.reduce((a, b) => a + b.fnCount, 0)}`,
);

const groups = {};
for (const x of pending) {
  const d = path.dirname(x.rel);
  (groups[d] ||= []).push(x);
}
console.log('\n## 待补缺口');
for (const d of Object.keys(groups).sort()) {
  const list = groups[d].sort((a, b) => b.fileCom - a.fileCom || b.bodyCode - a.bodyCode);
  console.log(`\n### ${d} (${list.length})`);
  for (const x of list) console.log(`  ${x.rel}\tfileCom=${x.fileCom}\tbodyCode=${x.bodyCode}\tfn=${x.fnCount}`);
}
if (pending.length === 0) console.log('  （空）');

console.log('\n## 已登记豁免');
for (const x of exempted) {
  console.log(`  ${x.rel}:${x.line}\treason=${x.reason}\tbodyCode=${x.bodyCode}\tfn=${x.fnCount}${x.form ? `\tform=${x.form}` : ''}`);
}
if (exempted.length === 0) console.log('  （空）');
