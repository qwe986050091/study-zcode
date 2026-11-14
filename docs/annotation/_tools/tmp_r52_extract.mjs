import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync('R52-claim-sample.json', 'utf8'));
const want = new Set(['必然', '一律']);
const claims = [];
const seen = new Set();
// 从全量扫描重建这两层（样本只有 10 条/层，全核要拿整层）
const { execSync } = await import('node:child_process');
const raw = execSync('node dz-claim-audit.mjs --all', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
for (const line of raw.split(/\r?\n/)) {
  const m = /^([0-9a-f]{8}) (drizzle-[^\s:]+):(\d+) \[([^\]]+)\] (.*)$/.exec(line);
  if (!m) continue;
}
