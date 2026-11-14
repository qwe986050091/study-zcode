// 尾部大文件结构盘点：函数清单 + 每函数单元数 + 按函数边界的连续分片
import fs from 'node:fs';

const REPO = 'd:/code/opensource/valkey';
const Q = 'd:/code/_annot_baseline/q-tail2u.json';
const OUT = 'd:/code/_annot_baseline/tail-inventory.md';
const CAP = 450; // 每片目标未覆盖单元数

const q = JSON.parse(fs.readFileSync(Q, 'utf8'));

function depthMap(src) {
  const depthAtStart = new Array(src.length).fill(0);
  let depth = 0, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    depthAtStart[i] = depth;
    const s = src[i];
    let j = 0;
    while (j < s.length) {
      if (inBlock) { const e = s.indexOf('*/', j); if (e === -1) { j = s.length; break; } inBlock = false; j = e + 2; continue; }
      if (s[j] === '/' && s[j + 1] === '*') { inBlock = true; j += 2; continue; }
      if (s[j] === '/' && s[j + 1] === '/') break;
      if (s[j] === '"') { j++; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; } j++; continue; }
      if (s[j] === "'") {
        // 只把形如 'a' / '\n' / '\'' 的字符常量当引号；中文注释里的撇号不吞行。
        let k = j + 1;
        if (s[k] === '\\') k += 2; else k += 1;
        if (s[k] === "'") { j = k + 1; continue; }
        j++; continue;
      }
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
      j++;
    }
  }
  return depthAtStart;
}

function funcsOf(src, depthAtStart) {
  const funcs = [];
  for (let i = 0; i < src.length; i++) {
    if (depthAtStart[i] !== 0) continue;
    const line = src[i];
    if (!line.trim()) continue;
    if (/^\s/.test(line)) continue;
    if (/^(#|\}|\/\*|\*|\/\/)/.test(line)) continue;
    let braceLine = -1;
    for (let k = i; k < Math.min(src.length, i + 12); k++) {
      if (src[k].includes('{')) { braceLine = k; break; }
      if (src[k].trim().endsWith(';')) break;
    }
    if (braceLine === -1) continue;
    const head = src.slice(i, braceLine + 1).join(' ');
    if (!head.includes('(')) continue;
    let name = '';
    for (let k = braceLine; k >= i && !name; k--) {
      const cut = src[k].indexOf('{') === -1 ? src[k].length : src[k].indexOf('{');
      const ms = [...src[k].slice(0, cut).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
      if (ms.length) name = ms[ms.length - 1][1];
    }
    if (!name) continue;
    let end = braceLine;
    for (let m = braceLine; m < src.length; m++) {
      const next = m + 1 < src.length ? depthAtStart[m + 1] : 0;
      if (next === 0) { end = m; break; }
    }
    funcs.push({ name, start: i + 1, end: end + 1 });
    i = end;
  }
  return funcs;
}

const md = [];
md.push('# 尾部大文件结构盘点');
md.push('');
md.push(`生成时间：${new Date().toISOString().slice(0, 10)}　口径：deep-quality v3 单元（语句+分支），分片按顶层函数边界连续切，目标每片 ≤ ${CAP} 未覆盖单元。`);
md.push('');

for (const r of q.rows) {
  const abs = `${REPO}/${r.path}`;
  const src = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const funcs = funcsOf(src, depthMap(src));
  const unitLines = new Set(r.unitLines);
  const uncovLines = new Set((r.uncoveredUnits || []).map((u) => u.line));
  const rows = funcs.map((f) => {
    let units = 0, unc = 0;
    for (const ln of unitLines) if (ln >= f.start && ln <= f.end) units++;
    for (const ln of uncovLines) if (ln >= f.start && ln <= f.end) unc++;
    return { ...f, units, unc };
  });

  // 把函数外区域也作为一个段参与分片，否则配置表那类全局单元的剩余量会被漏掉。
  // 超过 CAP 的「函数外」区段按行再切（配置表可以任意行断开，不涉及函数边界）。
  const segs = [];
  const pushGap = (a, b) => {
    const uncLines = [...uncovLines].filter((ln) => ln >= a && ln <= b).sort((x, y) => x - y);
    if (!uncLines.length) {
      let units = 0;
      for (const ln of unitLines) if (ln >= a && ln <= b) units++;
      if (units) segs.push({ kind: 'gap', name: '(函数外)', start: a, end: b, units, unc: 0 });
      return;
    }
    let chunkStart = a, acc = 0;
    for (let i = 0; i < uncLines.length; i++) {
      acc++;
      const atEnd = i === uncLines.length - 1;
      if (acc >= CAP || atEnd) {
        const chunkEnd = atEnd ? b : uncLines[i];
        let units = 0;
        for (const ln of unitLines) if (ln >= chunkStart && ln <= chunkEnd) units++;
        segs.push({ kind: 'gap', name: '(函数外)', start: chunkStart, end: chunkEnd, units, unc: acc });
        chunkStart = chunkEnd + 1;
        acc = 0;
      }
    }
  };
  let prev = 1;
  for (const f of rows) {
    if (f.start > prev) pushGap(prev, f.start - 1);
    segs.push({ kind: 'fn', name: f.name, start: f.start, end: f.end, units: f.units, unc: f.unc });
    prev = f.end + 1;
  }
  if (prev <= src.length) pushGap(prev, src.length);
  const rowsWithUnits = segs.filter((s) => s.kind === 'fn' && s.units > 0);
  const fnUnits = segs.filter((s) => s.kind === 'fn').reduce((s, x) => s + x.units, 0);
  const fnUnc = segs.filter((s) => s.kind === 'fn').reduce((s, x) => s + x.unc, 0);
  const outsideUnits = r.units - fnUnits;

  md.push(`## ${r.path}`);
  md.push('');
  md.push(`- 总单元 ${r.units}，已覆盖 ${r.covered}（${r.coverage.toFixed(1)}%），未覆盖 ${r.units - r.covered}`);
  md.push(`- 顶层函数 ${rowsWithUnits.length} 个，函数内单元 ${fnUnits}（未覆盖 ${fnUnc}）；函数外单元 ${outsideUnits}（未覆盖 ${r.units - r.covered - fnUnc}）`);
  md.push('');

  // 分片：按源码顺序连续打包，切点只落在函数边界
  const slices = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || (cur.unc + s.unc > CAP && cur.segs.length)) {
      cur = { from: s.start, to: s.end, unc: 0, units: 0, segs: [] };
      slices.push(cur);
    }
    cur.to = s.end;
    cur.unc += s.unc;
    cur.units += s.units;
    cur.segs.push(s);
  }
  const planned = slices.reduce((s, x) => s + x.unc, 0);
  md.push(`- **建议分片 ${slices.length} 片**（片内未覆盖合计 ${planned}，单片上限 ${CAP}，切点只在函数边界）`);
  md.push('');
  md.push('| 片 | 行范围 | 函数数 | 单元 | 未覆盖 | 结尾函数 |');
  md.push('|---|---|---|---|---|---|');
  slices.forEach((s, i) => {
    const fns = s.segs.filter((x) => x.kind === 'fn');
    md.push(`| P${i + 1} | ${s.from}–${s.to} | ${fns.length} | ${s.units} | ${s.unc} | \`${fns.length ? fns[fns.length - 1].name : '(函数外)'}\` |`);
  });
  md.push('');
  md.push('函数明细（按行号）：');
  md.push('');
  md.push('| 函数 | 行范围 | 单元 | 未覆盖 | 覆盖% |');
  md.push('|---|---|---|---|---|');
  for (const f of rowsWithUnits) {
    const cov = ((f.units - f.unc) / f.units * 100);
    md.push(`| \`${f.name}\` | ${f.start}–${f.end} | ${f.units} | ${f.unc} | ${cov.toFixed(1)} |`);
  }
  md.push('');
  console.log(`${r.path}: funcs=${rowsWithUnits.length} units=${r.units} unc=${r.units - r.covered} outside=${outsideUnits}/${r.units - r.covered - fnUnc} slices=${slices.length}`);
}

fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8');
console.log(`out=${OUT}`);
