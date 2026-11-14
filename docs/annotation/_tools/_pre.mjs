// 预检 spec 锚点：一次性报告所有 NOT FOUND / AMBIGUOUS 及其编号，避免逐条试错。
// 用法：node _pre.mjs <spec.json>
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const f of spec.files) {
  const abs = path.join(repo, f.path);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  f.edits.forEach((e, i) => {
    const hits = [];
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].trim() === e.anchor.trim()) hits.push(k + 1);
    }
    if (hits.length !== 1) {
      bad++;
      console.log(`[${i}] ${hits.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS(' + hits.length + ')'} L${hits.join(',')} :: ${e.anchor}`);
    }
  });
}
console.log(bad === 0 ? 'PREFLIGHT OK' : `PREFLIGHT BAD=${bad}`);
process.exit(bad === 0 ? 0 : 1);
