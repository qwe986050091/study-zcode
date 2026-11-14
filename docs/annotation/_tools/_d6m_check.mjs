import fs from 'node:fs';
const base = fs.readFileSync('D:\\code\\_annot_baseline\\UVR-D6m\\crates\\uv-publish\\src\\lib.rs', 'utf8').split('\n');
const cur = fs.readFileSync('D:\\code\\opensource\\uv\\crates\\uv-publish\\src\\lib.rs', 'utf8').split('\n');
// 只允许插入：对基线做子序列匹配，收集新增行
let i = 0;
const added = [];
for (const line of cur) {
  if (i < base.length && line === base[i]) {
    i++;
  } else {
    added.push(line);
  }
}
console.log('base lines', base.length, 'cur lines', cur.length, 'matched', i, 'added', added.length);
const problems = [];
added.forEach((l, k) => {
  const t = l.trim();
  if (!/^\/\//.test(t)) problems.push(['非注释新增行', k, l]);
  if (t.replace(/^\/\/+/, '').includes('//')) problems.push(['含连续双斜杠', k, l]);
  if (t.replace(/^\/\/+/, '').includes('"')) problems.push(['含 ASCII 双引号', k, l]);
});
console.log('problems', problems.length);
for (const p of problems.slice(0, 20)) console.log(JSON.stringify(p));
