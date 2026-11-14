// 导出 b207–b226 的 water 明细（现行 W/POEM/L 判据，基线 a8784b7e^）。
// 只输出判据原文行，便于抽样判定「真水 / 判据差异 / 误判」。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE_DIR = 'd:/code/_annot_baseline';
const OUT = path.join(BASE_DIR, 'snapshot');
const PREFIX = '8f7daaf0';

const all = [];
for (let n = 226; n >= 207; n--) {
  if (n === 224) continue; // b224 单独提交且门禁 PASS
  const batch = `ZC-deep-b${n}`;
  const listFile = path.join(BASE_DIR, batch, '_files.txt');
  let out = '';
  try {
    const r = execFileSync(process.execPath, [path.join(BASE_DIR, 'zc-gate.mjs'), '--scan', listFile, '--base', PREFIX], {
      cwd: BASE_DIR,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    out = r;
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const lines = out.split(/\r?\n/).filter((l) => /^(POEM|L|B|W) /.test(l));
  fs.writeFileSync(path.join(OUT, `water-b${n}.txt`), lines.join('\n') + '\n', 'utf8');
  for (const l of lines) all.push(l);
  console.log(`${batch}: ${lines.length} findings`);
}
fs.writeFileSync(path.join(OUT, 'water-all.txt'), all.join('\n') + '\n', 'utf8');
const byKind = {};
for (const l of all) {
  const k = l.split(' ')[0];
  byKind[k] = (byKind[k] || 0) + 1;
}
console.log('TOTAL', all.length, JSON.stringify(byKind));
