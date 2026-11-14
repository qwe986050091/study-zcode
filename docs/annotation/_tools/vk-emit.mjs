// vk-emit：从工作区相对 HEAD 的新增行中提取「整行注释」，生成批次 out-<base>.json。
// 目的：entries 声明行数必须与实际新增注释行严格相等（gate 的 extra 判据），
// 手工数行必然出错，所以直接把 diff 结果写成 entries。
//
// 用法：node vk-emit.mjs <repo> <rel> <batchDir>
//   产出：<batchDir>/out-<basename>.json
import fs from 'node:fs';
import path from 'node:path';
import { commentMap, diffAdded } from './vk-gate.mjs';

const [repo, rel, batchDir] = process.argv.slice(2);
if (!repo || !rel || !batchDir) {
  console.error('usage: node vk-emit.mjs <repo> <rel> <batchDir>');
  process.exit(2);
}

const abs = path.join(repo, rel);
const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
const cm = commentMap(abs);
const { added, deletedCode } = diffAdded(rel, repo);
const entries = added
  .filter((n) => cm.has(n))
  .map((n) => ({ line: n, c: [raw[n - 1].trim()] }));

if (deletedCode) {
  console.error(`ABORT: ${rel} 删除了 ${deletedCode} 行非注释代码，违反只增不删契约`);
  process.exit(3);
}

const base = path.basename(rel).replace(/\.(c|h)$/, '');
fs.mkdirSync(batchDir, { recursive: true });
const out = path.join(batchDir, `out-${base}.json`);
fs.writeFileSync(out, JSON.stringify(entries, null, 2) + '\n', 'utf8');
console.log(`entries=${entries.length} -> ${out}`);
