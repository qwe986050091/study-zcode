// Python SDK 批次划分：按顶层模块分组，组内按缺口降序装箱（目标 ~300 行、最多 10 文件），
// 再合并过小的相邻批次（<100 行）以控制批次数。
// 输出 d:\code\_annot_baseline\mcp-py-batches.json
import fs from 'node:fs';

const inv = JSON.parse(fs.readFileSync('D:/code/_annot_baseline/mcp-py-inventory.json', 'utf8'));
const below = inv.prod
  .filter((x) => x.density < 0.3)
  .map((x) => ({ ...x, need: Math.max(0, Math.ceil(x.code * 0.32) - x.comment) }));
const needOf = (rel) => below.find((x) => x.rel === rel).need;

const groupOf = (rel) => rel.split('/').slice(0, 3).join('/');
const groups = new Map();
for (const x of below) {
  const g = groupOf(x.rel);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(x);
}

const TARGET = 300;
const MAX_FILES = 10;
const order = ['src/mcp/server', 'src/mcp/client', 'src/mcp/shared', 'src/mcp/cli', 'src/mcp/os', 'src/mcp/types'];
const keys = [...groups.keys()].sort((a, b) => {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
});

const batches = [];
for (const g of keys) {
  const items = groups.get(g).sort((a, b) => b.need - a.need);
  let cur = [];
  let curNeed = 0;
  const flush = () => {
    if (cur.length) batches.push({ group: g, files: cur.map((x) => x.rel), need: curNeed });
    cur = [];
    curNeed = 0;
  };
  for (const x of items) {
    if (cur.length && (curNeed + x.need > TARGET * 1.15 || cur.length >= MAX_FILES)) flush();
    cur.push(x);
    curNeed += x.need;
  }
  flush();
}

// 合并：同组内后一批 <100 行且合并后 <=360 行 / <=12 文件时并入前一批
const merged = [];
for (const b of batches) {
  const prev = merged[merged.length - 1];
  if (prev && prev.group === b.group && b.need < 100 && prev.need + b.need <= 360 && prev.files.length + b.files.length <= 12) {
    prev.files.push(...b.files);
    prev.need += b.need;
  } else {
    merged.push({ ...b, files: [...b.files] });
  }
}

const out = {};
let tot = 0;
for (let i = 0; i < merged.length; i++) {
  const k = 'P' + String(i + 1).padStart(2, '0');
  out[k] = merged[i].files;
  tot += merged[i].need;
  console.log(`${k} ${merged[i].group}\tfiles=${merged[i].files.length}\tneed=${merged[i].need}`);
}
console.log('batches=' + merged.length + ' need=' + tot + ' files=' + below.length);
fs.writeFileSync('D:/code/_annot_baseline/mcp-py-batches.json', JSON.stringify(out, null, 1) + '\n');
