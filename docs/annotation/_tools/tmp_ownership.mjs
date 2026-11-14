// 逐函数统计「函数体是否有中文注释」，给出全局余量。
// 口径与 dz-inner.mjs 一致：只统计带块体的函数；函数体行含嵌套函数体（与既有内文率分母同口径）。
// 三类输出：owned（有内文注释）/ unowned（有代码、无内文注释）/ empty（无代码行，即空体）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src'];
const CJK = /[\u4e00-\u9fff]/;

const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '.git', 'build'].includes(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
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

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const fns = [];
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
      fns.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        name: fnName(node),
        com, code,
        isEmpty: node.body.statements.length === 0,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fns;
}

const files = [];
for (const r of ROOTS) {
  const abs = path.join(REPO, r);
  if (fs.existsSync(abs)) walk(abs, files);
}

const all = [];
for (const abs of files) {
  let fns;
  try { fns = analyze(abs); } catch { continue; }
  all.push({ rel: path.relative(REPO, abs).replace(/\\/g, '/'), fns });
}

for (const root of ROOTS) {
  const pre = root + '/';
  const rootFiles = all.filter((r) => r.rel.startsWith(pre));
  const fileCount = rootFiles.length;
  const fnTotal = rootFiles.reduce((a, b) => a + b.fns.length, 0);
  const group = rootFiles
    .map((r) => ({
      rel: r.rel,
      total: r.fns.length,
      unowned: r.fns.filter((f) => f.com === 0 && f.code > 0 && !f.isEmpty),
      empty: r.fns.filter((f) => f.isEmpty && f.com === 0),
    }))
    .filter((r) => r.unowned.length > 0 || r.empty.length > 0);
  const unownedFns = group.reduce((a, b) => a + b.unowned.length, 0);
  const emptyFns = group.reduce((a, b) => a + b.empty.length, 0);
  const filesWithUnowned = group.filter((r) => r.unowned.length > 0).length;
  const filesWithEmpty = group.filter((r) => r.empty.length > 0).length;

  console.log(`\n=== ${root} ===`);
  console.log(`源文件 ${fileCount} 个，函数体合计 ${fnTotal} 个`);
  console.log(`无归属函数体 ${unownedFns} 个，分布在 ${filesWithUnowned} 个文件；空体 ${emptyFns} 个，分布在 ${filesWithEmpty} 个文件`);
  const LIMIT = Number(process.argv[2] ?? 30);
  console.log(`Top 文件（无归属数降序，最多 ${LIMIT}）：`);
  for (const r of group.filter((r) => r.unowned.length > 0).sort((a, b) => b.unowned.length - a.unowned.length).slice(0, LIMIT)) {
    console.log(`  ${r.rel}\tunowned=${r.unowned.length}/${r.total}\tempty=${r.empty.length}`);
    for (const f of r.unowned) console.log(`      L${f.line} ${f.name} (code=${f.code})`);
  }
  if (group.filter((r) => r.unowned.length > 0).length === 0) console.log('  （无）');
}
