// 内文率：函数体内部中文注释行 ÷ 函数体代码行
// 用法: node dz-inner.mjs [阈值=15]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';
const THRESHOLD = parseFloat(process.argv[2] || '15');
const CJK = /[\u4e00-\u9fff]/;

const batches = fs.readdirSync(BASE, { withFileTypes: true })
  .filter((e) => e.isDirectory() && (/^B\d+$/.test(e.name) || /^R\d+$/.test(e.name) || e.name === 'DZ-b01'))
  .map((e) => e.name)
  .sort((x, y) => parseInt(x.replace(/\D/g, '')) - parseInt(y.replace(/\D/g, '')));

const seen = new Map();
for (const b of batches) {
  const listFile = path.join(BASE, b, '_files.txt');
  if (!fs.existsSync(listFile)) continue;
  for (const rel of fs.readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const orig = path.join(BASE, b, 'orig', rel);
    if (!fs.existsSync(orig) || seen.has(rel)) continue;
    seen.set(rel, { batch: b, orig });
  }
}

function isFnLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const bodyLines = new Set();
  const visit = (node) => {
    if (isFnLike(node) && node.body && ts.isBlock(node.body)) {
      const s = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const e = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      for (let i = s; i <= e; i++) bodyLines.add(i);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let inBlock = false, com = 0, code = 0;
  for (const i of bodyLines) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock = true; }
    if (isComment) { if (CJK.test(t)) com++; }
    else code++;
  }
  return { com, code, ratio: code ? (com / code) * 100 : 0 };
}

const rows = [];
for (const [rel, { batch }] of seen) {
  const cur = path.join(REPO, rel);
  if (!fs.existsSync(cur)) continue;
  const r = analyze(cur);
  rows.push({ rel, batch, ...r });
}

// 额外点名文件（不在批次快照中）
const EXTRA = [
  'drizzle-orm/src/pg-core/query-builders/select.ts',
  'drizzle-orm/src/sqlite-core/query-builders/select.ts',
  'drizzle-orm/src/mysql-core/query-builders/select.ts',
  'drizzle-orm/src/singlestore-core/query-builders/select.ts',
  'drizzle-orm/src/gel-core/query-builders/select.ts',
  'drizzle-orm/src/pg-core/dialect.ts',
  'drizzle-orm/src/sql/sql.ts',
  'drizzle-orm/src/relations.ts',
];
for (const rel of EXTRA) {
  if (seen.has(rel)) continue;
  const cur = path.join(REPO, rel);
  if (!fs.existsSync(cur)) continue;
  rows.push({ rel, batch: '免单/点名', ...analyze(cur) });
}

rows.sort((a, b) => a.ratio - b.ratio || a.rel.localeCompare(b.rel));
const low = rows.filter((r) => r.ratio < THRESHOLD);
console.log(`扫描 ${rows.length} 个已注释文件，内文率 < ${THRESHOLD}% 的 ${low.length} 个`);
console.log('内文率\t内文注释\t函数代码行\t文件\t批次');
for (const r of low) {
  console.log(`${r.ratio.toFixed(1)}%\t${r.com}\t${r.code}\t${r.rel}\t${r.batch}`);
}
fs.writeFileSync(path.join(BASE, 'inner-rate.txt'),
  rows.map((r) => `${r.ratio.toFixed(1)}%\t${r.com}\t${r.code}\t${r.rel}\t${r.batch}`).join('\n') + '\n');
console.log(`全量明细写入 inner-rate.txt`);
