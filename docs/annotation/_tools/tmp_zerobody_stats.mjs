// 统计：全仓（drizzle-orm/src、drizzle-kit/src、drizzle-seed/src）内文率 = 0 但整文件中文注释行 > 0 的文件
// 输出：文件数 / 注释行合计 / 占已注释文件比例 / Top20
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js');

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src', 'drizzle-seed/src'];
const CJK = /[\u4e00-\u9fff]/;

function isFnLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'build'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
}

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);

  // 整文件：中文注释行（// 与 /* */ 内）
  let fileCom = 0, inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock = true; }
    if (isComment && CJK.test(t)) fileCom++;
  }

  // 函数体：沿用 dz-inner 口径
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

  let inBlock2 = false, bodyCom = 0, bodyCode = 0;
  for (const i of bodyLines) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    let isComment = false;
    if (inBlock2) { isComment = true; if (t.includes('*/')) inBlock2 = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock2 = true; }
    if (isComment) { if (CJK.test(t)) bodyCom++; } else bodyCode++;
  }

  // 整文件代码行（用于密度口径）：非空、非注释
  let fileCode = 0, inBlock3 = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let isComment = false;
    if (inBlock3) { isComment = true; if (t.includes('*/')) inBlock3 = false; }
    else if (t.startsWith('//')) isComment = true;
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock3 = true; }
    if (!isComment) fileCode++;
  }

  return { fileCom, bodyCom, bodyCode, fileCode, fnCount };
}

const files = [];
for (const r of ROOTS) {
  const abs = path.join(REPO, r);
  if (fs.existsSync(abs)) walk(abs, files);
}

const annotated = [];
for (const abs of files) {
  let r;
  try { r = analyze(abs); } catch { continue; }
  if (r.fileCom > 0) annotated.push({ rel: path.relative(REPO, abs).replace(/\\/g, '/'), ...r });
}

const zero = annotated.filter((x) => x.bodyCom === 0 && x.bodyCode > 0);
const zeroNoBody = annotated.filter((x) => x.bodyCode === 0);
const totalCom = zero.reduce((a, b) => a + b.fileCom, 0);

console.log(`扫描源文件 ${files.length} 个；有中文注释的 ${annotated.length} 个`);
console.log(`有函数体、内文率=0、文件注释>0：${zero.length} 个，合计整文件注释 ${totalCom} 行，占已注释文件 ${(zero.length / annotated.length * 100).toFixed(1)}%`);
console.log(`另有无任何函数体的文件（纯声明/常量/类型）内文率=0：${zeroNoBody.length} 个，注释 ${zeroNoBody.reduce((a, b) => a + b.fileCom, 0)} 行（不属本问题）`);
console.log('');
const dense = zero.filter((x) => x.fileCom / x.fileCode >= 0.3);
console.log(`其中整文件密度已 >= 30%（按注释总量口径会被判为已完成）：${dense.length} 个，注释 ${dense.reduce((a, b) => a + b.fileCom, 0)} 行`);
console.log(`这 ${zero.length} 个文件的函数体代码行合计 ${zero.reduce((a, b) => a + b.bodyCode, 0)}，函数个数合计 ${zero.reduce((a, b) => a + b.fnCount, 0)}`);
const literal = annotated.filter((x) => x.bodyCom === 0);
const literalCom = literal.reduce((a, b) => a + b.fileCom, 0);
console.log(`【字面口径】内文率=0 的文件共 ${literal.length} 个（含无函数体 ${zeroNoBody.length} 个），注释 ${literalCom} 行，占已注释文件 ${(literal.length / annotated.length * 100).toFixed(1)}%`);
console.log('');
const top = [...zero].sort((a, b) => b.fileCom - a.fileCom || b.bodyCode - a.bodyCode).slice(0, 20);
console.log('Top20\t文件\t中文注释行\t函数体代码行\t函数个数');
top.forEach((x, i) => console.log(`${i + 1}\t${x.rel}\t${x.fileCom}\t${x.bodyCode}\t${x.fnCount}`));

// 附录：点名文件
const extra = ['drizzle-orm/src/gel-core/columns/decimal.ts'];
for (const rel of extra) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) continue;
  const r = analyze(abs);
  console.log(`\n[点名] ${rel} fileCom=${r.fileCom} fileCode=${r.fileCode} 密度=${(r.fileCom / r.fileCode * 100).toFixed(1)}% bodyCom=${r.bodyCom} bodyCode=${r.bodyCode}`);
}

// 导出 92 个「无函数体」文件清单（Markdown 行）
if (process.argv.includes('--dump-exempt')) {
  const out = [];
  const sorted = [...zeroNoBody].sort((a, b) => b.fileCom - a.fileCom || a.rel.localeCompare(b.rel));
  for (const x of sorted) out.push(`| \`${x.rel}\` | ${x.fileCom} | ${x.fileCode} |`);
  fs.writeFileSync('D:/code/_annot_baseline/R35/exempt92.md', out.join('\n') + '\n', 'utf8');
  console.log(`\n已导出 ${sorted.length} 行到 R35/exempt92.md`);
}

