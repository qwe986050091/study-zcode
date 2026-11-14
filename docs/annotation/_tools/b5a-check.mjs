// 干跑校验：只检查 spec 中每个 anchor 是否唯一存在，不写文件。
// 用法：node b5a-check.mjs <spec.json>
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const f of spec.files) {
  const abs = path.join(repo, f.path);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  for (const e of f.edits) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === e.anchor.trim()) hits.push(i + 1);
    }
    const star = e.lines.filter((l) => l.includes('*/'));
    if (hits.length !== 1) {
      bad++;
      console.log(`${hits.length === 0 ? 'NOT FOUND' : 'AMBIGUOUS(' + hits.length + ')'} ${f.path} :: ${e.anchor} ${hits.join(',')}`);
    }
    if (star.length) {
      bad++;
      console.log(`STAR-SLASH ${f.path} :: ${star.join(' | ')}`);
    }
    if (e.lines.some((l) => !l.trimStart().startsWith('//'))) {
      bad++;
      console.log(`NOT-COMMENT ${f.path} :: ${e.anchor}`);
    }
  }
}
console.log(bad === 0 ? 'CHECK OK' : `CHECK FAIL ${bad}`);
process.exit(bad === 0 ? 0 : 1);
