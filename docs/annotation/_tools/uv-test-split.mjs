// 产品代码 / 测试代码覆盖率拆分 + 字符串区间交叉验证
// 用法：node uv-test-split.mjs <json-with-unit-lines> <repo-root>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { linesInsideStrings } = await import(pathToFileURL('d:/code/_annot_baseline/uv-string-spans.mjs').href);
const { testLineSet } = await import(pathToFileURL('d:/code/_annot_baseline/uv-test-blocks.mjs').href);

const [jsonPath, repoRoot] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const rows = data.rows;

// 1) 找内联测试模块边界：最后一个 `#[cfg(test)]` 紧邻的 `mod xxx {`
function testBoundary(lines) {
  let boundary = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[cfg\(.*\btest\b.*\)\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 200, lines.length - 1); j++) {
      const t = lines[j].trim();
      if (/^#\[/.test(t) || t === '' || t.startsWith('//')) continue;
      if (/^(pub\s+)?mod\s+\w+\s*\{\s*$/.test(t) || /^(pub\s+)?mod\s+\w+\s*;/.test(t)) boundary = j + 1;
      break;
    }
    if (boundary !== null) break;
  }
  return boundary;
}

// 2) 独立的 Rust 字符串扫描器（不复用 uv-string-spans），返回「行首落在字符串内」的行号集合
function naiveInsideLines(text) {
  const lines = text.split('\n');
  const inside = new Set();
  let state = 'code';
  let hashes = 0; // raw string 的 # 数量
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    if (state === 'raw' || state === 'str') inside.add(ln + 1);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') { state = 'line'; i++; continue; }
        if (c === '/' && n === '*') { state = 'block'; i++; continue; }
        if (c === 'r' && (n === '"' || n === '#')) {
          let h = 0; let j = i + 1;
          while (s[j] === '#') { h++; j++; }
          if (s[j] === '"') { state = 'raw'; hashes = h; i = j; continue; }
        }
        if (c === '"') { state = 'str'; continue; }
        if (c === "'") {
          // 区分字符字面量与生命周期：'a' / '\n' 才是字符，'a 是生命周期
          if (n === '\\') { state = 'char'; i++; continue; }
          if (s[i + 2] === "'") { state = 'char'; i++; continue; }
          continue;
        }
      } else if (state === 'line') {
        // 行尾结束
      } else if (state === 'block') {
        if (c === '*' && n === '/') { state = 'code'; i++; }
      } else if (state === 'str') {
        if (c === '\\') { i++; continue; }
        if (c === '"') state = 'code';
      } else if (state === 'char') {
        if (c === '\\') { i++; continue; }
        if (c === "'") state = 'code';
      } else if (state === 'raw') {
        if (c === '"') {
          let h = 0; let j = i + 1;
          while (s[j] === '#' && h < hashes) { h++; j++; }
          if (h === hashes) { state = 'code'; i = j - 1; }
        }
      }
    }
    if (state === 'line') state = 'code';
  }
  return inside;
}

const out = [];
let filesWithTests = 0;
let uncTest = 0;
let uncAll = 0;
let passProd = 0;
let passBoth = 0;
let prodUnitsAll = 0;
let prodCovAll = 0;
let prodBrAll = 0;
let prodBrCovAll = 0;
let prodFieldAll = 0;
let prodFieldUncAll = 0;
const inStrMismatch = [];

for (const r of rows) {
  const abs = path.join(repoRoot, r.path);
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const inTest = testLineSet(lines);
  const boundary = inTest.size ? Math.min(...inTest) : null;
  if (boundary) filesWithTests++;
  const unitLines = r.unitLines ?? [];
  const unc = r.uncoveredUnits ?? [];
  const prodUnits = unitLines.filter((l) => !inTest.has(l));
  const testUnits = unitLines.filter((l) => inTest.has(l));
  const prodUnc = unc.filter((u) => !inTest.has(u.line));
  const testUnc = unc.filter((u) => inTest.has(u.line));
  const prodBranch = (r.branchLines ?? []).filter((l) => !inTest.has(l));
  const prodBranchUnc = prodUnc.filter((u) => u.branch).length;
  const prodCovered = prodUnits.length - prodUnc.length;
  const prodStmt = prodUnits.length ? (prodCovered / prodUnits.length) * 100 : null;
  const prodBr = prodBranch.length ? ((prodBranch.length - prodBranchUnc) / prodBranch.length) * 100 : null;
  uncAll += unc.length;
  uncTest += testUnc.length;
  prodUnitsAll += prodUnits.length;
  prodCovAll += prodCovered;
  const prodField = (r.fieldLines ?? []).filter((l) => !inTest.has(l));
  prodBrAll += prodBranch.length;
  prodBrCovAll += prodBranch.length - prodBranchUnc;
  prodFieldAll += prodField.length;
  prodFieldUncAll += prodUnc.filter((u) => u.field).length;
  const ok = prodStmt === null ? false : prodStmt >= 60 && (prodBr === null || prodBr >= 70);
  if (ok) passProd++;
  if (ok && r.coverage >= 60 && ((r.branch ?? 0) === 0 || r.branchCoverage >= 70)) passBoth++;
  // 字符串统计交叉验证
  const inside = naiveInsideLines(lines.join('\n'));
  const inStrNaive = unc.filter((u) => inside.has(u.line)).length;
  const toolSet = new Set(linesInsideStrings(lines.join('\n')).map((v, i) => (v ? i + 1 : 0)).filter(Boolean));
  const inStrTool = unc.filter((u) => toolSet.has(u.line)).length;
  const naiveAll = inside.size;
  const toolAll = toolSet.size;
  const prodInStr = prodUnc.filter((u) => toolSet.has(u.line)).length;
  const prodProj = prodUnits.length ? ((prodUnits.length - prodUnc.length + (prodUnc.length - prodInStr)) / prodUnits.length) * 100 : null;
  out.push({ path: r.path, boundary, units: r.units, prodUnits: prodUnits.length, testUnits: testUnits.length, prodStmt, prodBr, stmt: r.coverage, br: r.branchCoverage, unc: unc.length, testUnc: testUnc.length, inStrNaive, inStrTool, naiveAll, toolAll, prodUnc: prodUnc.length, prodInStr, prodProj, ok });
  if (inStrTool !== inStrNaive) inStrMismatch.push({ path: r.path, tool: inStrTool, naive: inStrNaive });
}

console.log(`files=${rows.length} withTests=${filesWithTests}`);
console.log(`uncovered total=${uncAll} inTests=${uncTest} (${((uncTest / uncAll) * 100).toFixed(1)}%)`);
console.log(`product units=${prodUnitsAll} covered=${prodCovAll} stmt=${((prodCovAll / prodUnitsAll) * 100).toFixed(1)}% branch=${((prodBrCovAll / prodBrAll) * 100).toFixed(1)}% field=${((1 - prodFieldUncAll / prodFieldAll) * 100).toFixed(1)}%`);
console.log(`pass(prod-only rule)=${passProd}  pass(whole-file rule)=${rows.filter((r) => r.coverage >= 60 && ((r.branch ?? 0) === 0 || r.branchCoverage >= 70)).length}`);
console.log(`inStr mismatches(tool vs naive)=${inStrMismatch.length}`);
for (const m of inStrMismatch.slice(0, 5)) console.log(`  MISMATCH ${m.path} tool=${m.tool} naive=${m.naive}`);

const want = process.argv.slice(4);
for (const w of want) {
  const x = out.find((o) => o.path.includes(w));
  if (x) console.log(`SAMPLE ${x.path} boundary=${x.boundary} units=${x.units} prod=${x.prodUnits} test=${x.testUnits} prodStmt=${x.prodStmt?.toFixed(1)} prodBr=${x.prodBr?.toFixed(1)} unc=${x.unc} uncTest=${x.testUnc} inStr=${x.inStrTool}(naive ${x.inStrNaive}) linesInside=${x.toolAll}(naive ${x.naiveAll}) prodUnc=${x.prodUnc} prodInStr=${x.prodInStr} prodProj=${x.prodProj?.toFixed(1)}`);
}

const capped = out.filter((x) => !x.ok && x.prodProj !== null && x.prodProj < 60);
console.log(`prod-capped(proj<60)=${capped.length}`);
const wholeFail = (x) => !(x.stmt >= 60 && ((x.br ?? 0) === 0 || x.br >= 70));
const diffSet = out.filter((x) => x.ok && wholeFail(x));
console.log(`whole-fail-but-prod-pass=${diffSet.length}`);
if (process.argv.includes('--diff-set')) for (const x of diffSet) console.log(`  ${x.path}`);
for (const x of capped) console.log(`  ${x.path}\tprod=${x.prodUnits}\tprodStmt=${x.prodStmt?.toFixed(1)}\tprodUnc=${x.prodUnc}\tprodInStr=${x.prodInStr}\tproj=${x.prodProj.toFixed(1)}`);

const failing = out.filter((x) => !x.ok).sort((a, b) => (a.prodStmt ?? 0) - (b.prodStmt ?? 0));
console.log(`prod-fail=${failing.length}`);
for (const x of failing.slice(0, 20)) console.log(`  ${x.path}\tunits=${x.units} prod=${x.prodUnits} test=${x.testUnits}\tprodStmt=${x.prodStmt?.toFixed(1)} prodBr=${x.prodBr === null ? '-' : x.prodBr.toFixed(1)}\tuncTest=${x.testUnc}`);

const prodInStrTotal = out.reduce((n, x) => n + x.prodInStr, 0);
const prodUncTotal = out.reduce((n, x) => n + x.prodUnc, 0);
console.log(`prodUnc=${prodUncTotal} prodInStr=${prodInStrTotal} (${((prodInStrTotal / prodUncTotal) * 100).toFixed(1)}%)`);
for (const x of [...out].sort((a, b) => b.prodInStr - a.prodInStr).slice(0, 8)) console.log(`  inStrTop ${x.path} prodInStr=${x.prodInStr}/${x.prodUnc} proj=${x.prodProj?.toFixed(1)}`);
console.log('next10(fail, by product gap asc):');
const gapProd = (x) => Math.max(60 - (x.prodStmt ?? 0), x.prodBr === null || x.prodBr === undefined ? 0 : 70 - x.prodBr);
const ranked = failing.filter((x) => x.prodProj >= 60).sort((a, b) => gapProd(a) - gapProd(b));
const bucketProd = (x) => (gapProd(x) <= 10 ? 'near' : gapProd(x) <= 30 ? 'mid' : 'far');
const bucketCount = { near: 0, mid: 0, far: 0 };
for (const x of ranked) bucketCount[bucketProd(x)]++;
console.log(`prod-gap buckets: near=${bucketCount.near} mid=${bucketCount.mid} far=${bucketCount.far} (total=${ranked.length})`);
for (const x of ranked.slice(0, 12)) console.log(`  ${x.path}\tprod=${x.prodUnits}\tprodStmt=${x.prodStmt?.toFixed(1)} prodBr=${x.prodBr === null ? '-' : x.prodBr.toFixed(1)}\tgap=${gapProd(x).toFixed(1)}`);
