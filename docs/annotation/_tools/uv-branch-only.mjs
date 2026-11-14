// 统计产品口径下「仅分支 ≥70%」的文件数（与 uv-test-split 同一判据）。
import fs from 'node:fs';
const [jsonPath] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).rows;
function testBoundary(lines) {
  let boundary = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[cfg\(.*\btest\b.*\)\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 200, lines.length - 1); j++) {
      const t = lines[j].trim();
      if (/^#\[/.test(t) || t === '' || t.startsWith('//')) continue;
      if (/^(pub\s+)?mod\s+\w+\s*\{\s*$/.test(t) || /^(pub\s+)?mod\s+\w+\s*;/.test(t)) boundary = j + 1;
      break;
    }
  }
  return boundary;
}
let n = 0;
let noBranch = 0;
for (const r of rows) {
  const lines = fs.readFileSync('d:/code/opensource/uv/' + r.path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const b = testBoundary(lines);
  const branch = (r.branchLines ?? []).filter((l) => !b || l < b);
  const unc = (r.uncoveredUnits ?? []).filter((u) => (!b || u.line < b) && u.branch).length;
  if (!branch.length) { noBranch++; continue; }
  const pct = ((branch.length - unc) / branch.length) * 100;
  if (pct >= 70) n++;
}
console.log(`branch-only-pass=${n} noBranch=${noBranch}`);
