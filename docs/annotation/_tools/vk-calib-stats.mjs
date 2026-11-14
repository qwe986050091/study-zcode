// 校准统计：对 vk-calib.tsv 每条样本，判定其所在连续注释块的整体锚点情况。
// 输出：seq file line blockLen blockWeak blockAnchored selfWeak otherAnchored
import fs from 'node:fs';
import path from 'node:path';
import { ident, isWeakContent } from './zc-gate.mjs';

const REPO = 'd:/code/opensource/valkey';
const ANCHOR = /\d|`[^`]+`/;
const PRECOND =
  /(前提|前置|依赖|必须先|先于|顺序|调用前|调用后|传入|返回|失败|否则|会|导致|破坏|panic|死锁|回滚|重放|越界|不变量|INV-|保证|确保|无法|不能|只能|必须|拒绝|抛出|未|若|如果|一旦|冲突|泄漏|泄露)/;
const INVARIANT = /(唯一|不可变|幂等|原子|有序|单调|只读|线程安全|可重入|有界|不共享|恒定|固定|稳定|从\s*\d+\s*开始)/;

const tsv = fs.readFileSync('d:/code/_annot_baseline/vk-calib.tsv', 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
const cache = new Map();
const linesOf = (rel) => {
  if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '').split('\n'));
  return cache.get(rel);
};
// 只认本工程新增的 // 注释；* 行与 /* 行不算（本文件是 C 源码既有英文块）
const isOwn = (s) => s.trim().startsWith('//');
const content = (s) => s.trim().replace(/^\/\/\s?/, '');

const rows = [];
for (const row of tsv.slice(1)) {
  const [seq, file, lineStr] = row.split('\t');
  const line = +lineStr;
  const ls = linesOf(file);
  let a = line - 1;
  let b = line - 1;
  while (a - 1 >= 0 && isOwn(ls[a - 1])) a--;
  while (b + 1 < ls.length && isOwn(ls[b + 1])) b++;
  const block = [];
  for (let i = a; i <= b; i++) block.push(content(ls[i]));
  const self = content(ls[line - 1]);
  const blockWeak = block.filter((c) => isWeakContent(c)).length;
  const blockAnchored = block.filter((c) => ident(c).length > 0 || ANCHOR.test(c) || PRECOND.test(c) || INVARIANT.test(c)).length;
  const others = block.filter((_, i) => i !== line - 1 - a);
  const otherAnchored = others.some((c) => ident(c).length > 0 || ANCHOR.test(c) || PRECOND.test(c) || INVARIANT.test(c));
  rows.push({
    seq: +seq,
    file,
    line,
    blockLen: b - a + 1,
    blockWeak,
    blockAnchored,
    selfWeak: isWeakContent(self),
    otherAnchored,
  });
}
const out = ['seq\tfile\tline\tblockLen\tblockWeak\tblockAnchored\tselfWeak\totherAnchored'];
for (const r of rows) out.push([r.seq, r.file, r.line, r.blockLen, r.blockWeak, r.blockAnchored, r.selfWeak, r.otherAnchored].join('\t'));
fs.writeFileSync('d:/code/_annot_baseline/vk-calib-stats.tsv', out.join('\n'), 'utf8');
const fpBlock = rows.filter((r) => r.otherAnchored).length;
const singleton = rows.filter((r) => r.blockLen === 1).length;
const allWeakBlock = rows.filter((r) => !r.otherAnchored).length;
console.log(`total=${rows.length} midBlockWithAnchor=${fpBlock} noAnchorInBlock=${allWeakBlock} singleton=${singleton}`);
