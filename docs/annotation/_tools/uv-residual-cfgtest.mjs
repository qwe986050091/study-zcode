// 量化残余限制：顶层 `#[cfg(...test...)] fn`（不在内联 mod 内）被计入产品代码的规模。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { testLineSet } = await import(pathToFileURL('d:/code/_annot_baseline/uv-test-blocks.mjs').href);

const repo = 'd:/code/opensource/uv';
const rows = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/dq-key123-b2.json', 'utf8')).rows;

// 行级花括号增量：跳过行注释、块注释、普通/原始字符串、字符字面量
function braceDelta(s) {
  let d = 0, state = 'code', hashes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { state = 'block'; i++; continue; }
      if (c === 'r' && (n === '"' || n === '#')) {
        let h = 0, j = i + 1;
        while (s[j] === '#') { h++; j++; }
        if (s[j] === '"') { state = 'raw'; hashes = h; i = j; continue; }
      }
      if (c === '"') { state = 'str'; continue; }
      if (c === "'") {
        if (n === '\\') { state = 'char'; i++; continue; }
        if (s[i + 2] === "'") { state = 'char'; i++; continue; }
        continue;
      }
      if (c === '{') d++;
      else if (c === '}') d--;
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i++; }
    } else if (state === 'str') {
      if (c === '\\') i++;
      else if (c === '"') state = 'code';
    } else if (state === 'char') {
      if (c === '\\') i++;
      else if (c === "'") state = 'code';
    } else if (state === 'raw') {
      if (c === '"') {
        let h = 0, j = i + 1;
        while (s[j] === '#' && h < hashes) { h++; j++; }
        if (h === hashes) { state = 'code'; i = j - 1; }
      }
    }
  }
  return d;
}

let hits = 0, lines = 0, units = 0, unc = 0;
let prodUnits = 0, prodUnc = 0;
const per = [];
for (const r of rows) {
  const abs = path.join(repo, r.path);
  const L = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const unitSet = new Set(r.unitLines ?? []);
  const uncSet = new Set((r.uncoveredUnits ?? []).map((u) => u.line));
  const T = testLineSet(L);
  prodUnits += (r.unitLines ?? []).filter((l) => !T.has(l)).length;
  prodUnc += (r.uncoveredUnits ?? []).filter((u) => !T.has(u.line)).length;
  for (let i = 0; i < L.length; i++) {
    if (!/^\s*#\[(cfg\(.*\btest\b.*\)|test|tokio::test(\b|\(.*\))|rstest)\]\s*$/.test(L[i])) continue;
    let j = i + 1;
    while (j < L.length && (/^\s*#\[/.test(L[j]) || !L[j].trim() || /^\s*\/\//.test(L[j]))) j++;
    if (j >= L.length) continue;
    const t = L[j].trim();
    if (!/^(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+/.test(t)) continue;
    if (T.has(j + 1)) continue; // 已在内联测试块内，由块级规则排除
    // 从 fn 行开始花括号配对
    let depth = 0, end = j;
    for (let k = j; k < L.length; k++) {
      depth += braceDelta(L[k]);
      if (depth === 0 && k > j) { end = k; break; }
      if (depth === 0 && k === j && L[k].includes('{')) { end = k; break; }
    }
    hits++;
    const nLines = end - j + 1;
    lines += nLines;
    let u = 0, x = 0;
    for (let k = i + 1; k <= end; k++) {
      if (T.has(k + 1)) continue;
      if (unitSet.has(k + 1)) u++;
      if (uncSet.has(k + 1)) x++;
    }
    units += u; unc += x;
    per.push({ file: r.path, fnLine: j + 1, end: end + 1, lines: nLines, units: u, unc: x, name: t.slice(0, 70) });
  }
}
const totalUnits = prodUnits;
console.log(`cfgfns=${hits} files=${new Set(per.map((p) => p.file)).size} spanLines=${lines} productUnitsIn=${units} uncoveredIn=${unc}`);
console.log(`占产品分母 ${((units / totalUnits) * 100).toFixed(2)}%  占产品未覆盖 ${((unc / prodUnc) * 100).toFixed(2)}%`);
for (const p of per.sort((a, b) => b.units - a.units)) console.log(`${p.units}\t${p.unc}\t${p.file}:${p.fnLine}-${p.end}\t${p.name}`);
