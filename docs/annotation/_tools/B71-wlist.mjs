// 打印 VK-B71 的 W 行（post 行号 + 原文 + 对应 orig 行号）
import fs from 'node:fs';
import { commentMap, diffAdded, judgeBlocks } from './vk-gate.mjs';

const repo = 'd:/code/opensource/valkey';
const rel = 'src/functions.c';
const abs = repo + '/' + rel;
const cm = commentMap(abs);
const { added } = diffAdded(rel, repo);
const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
const { findings } = judgeBlocks(entries);
const spec = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/VK-B71/spec.json', 'utf8'))[0].ops;
// orig -> post
const map = new Map();
let ins = 0;
const byLine = new Map(spec.map((o) => [o.line, o]));
const total = fs.readFileSync('d:/code/_annot_baseline/VK-B71/orig/' + rel, 'utf8').replace(/\r\n/g, '\n').split('\n').length;
for (let L = 1; L <= total; L++) {
  if (byLine.has(L)) {
    ins++;
    map.set(L + ins - 1, L);
  }
}
console.log('W count', findings.length);
for (const f of findings) {
  console.log(`${f.line}\torig=${map.get(f.line) ?? '?'}\t${f.lines.join(' | ')}`);
}
