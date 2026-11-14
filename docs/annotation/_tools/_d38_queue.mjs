// 用最新的全仓密度报告刷新队列 rows / 汇总字段，保留 completed 历史。
import fs from 'node:fs';

const Q = 'd:\\code\\_annot_baseline\\UVR-deep-queue.json';
const ALL = 'd:\\code\\_annot_baseline\\uv-density-all.json';

const all = JSON.parse(fs.readFileSync(ALL, 'utf8'));
const q = JSON.parse(fs.readFileSync(Q, 'utf8'));

const rows = all.rows
  .filter((r) => r.need > 0)
  .sort((a, b) => b.need - a.need || a.codeRatio - b.codeRatio)
  .map((r) => ({
    path: r.path,
    code: r.code,
    comments: r.comment,
    need: r.need,
    densityPct: Number(r.codeRatio.toFixed(2)),
  }));

q.generatedAt = new Date().toISOString();
q.total = all.rows.length;
q.below30 = rows.length;
q.needLines = rows.reduce((sum, r) => sum + r.need, 0);
q.rows = rows;
q.updatedAt = new Date().toISOString();
fs.writeFileSync(Q, JSON.stringify(q, null, 2) + '\n', 'utf8');
console.log(`QUEUE refreshed total=${q.total} below30=${q.below30} needLines=${q.needLines} completed=${q.completed.length}`);
