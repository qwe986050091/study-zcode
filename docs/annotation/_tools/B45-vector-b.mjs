import fs from 'node:fs';

const REL = 'src/vector.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B45';

const E = [
  [30, '/* 容量为 0 时 data 必须是 NULL，vectorCleanup 依赖这个判据决定是否 zfree。 */'],
  [36, '/* item_size 在这里定型；alloc==0 时 data 为 NULL，但 item_size 仍要按调用方给的值记账。 */'],
  [42, '/* 直接返回 a->len，不加锁也不做快照：vector 本身不保证线程安全。 */'],
  [69, '/* 返回未初始化槽，调用方负责写入；再次 vectorPush 之前不能假设它仍指向同一地址。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v2.json`, JSON.stringify([{ file: REL, ops }], null, 1));
const outP = `${DIR}/out-vector.json`;
const out = JSON.parse(fs.readFileSync(outP, 'utf8'));
for (const o of ops) out.push({ line: o.line, c: o.lines });
fs.writeFileSync(outP, JSON.stringify(out, null, 1));
console.log('ops', ops.length, 'entries', out.length);
