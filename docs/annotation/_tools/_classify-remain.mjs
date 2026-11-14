import fs from 'node:fs';
import { scanFile } from 'file:///D:/code/_annot_baseline/zc-gate.mjs';

const root = 'D:/code/_annot_baseline';
const files = fs
  .readFileSync(`${root}/ZC-lc-adjacent.txt`, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
let total = 0;
let fileCount = 0;
for (const rel of files) {
  const res = scanFile(rel);
  if (!res.findings.length) continue;
  fileCount++;
  const ls = new Set();
  for (const f of res.findings) for (let l = f.line; l <= f.endLine; l++) ls.add(l);
  total += ls.size;
  const kinds = [...new Set(res.findings.map((f) => f.kind))].join('+');
  const contract = res.findings.some((f) =>
    f.lines.some((t) => /\[契约\]|\[权衡\]|\[失败路径\]|INV-/.test(t)),
  );
  const sample = res.findings[0].lines.join(' / ').slice(0, 70);
  console.log(`${ls.size}\t${kinds}\t${contract ? 'C' : '-'}\t${rel}\t${sample}`);
}
console.log(`TOTAL files=${fileCount} lines=${total}`);
