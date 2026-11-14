import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73c-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const bad = "[2609, '`sdsnew` 把 " + String.raw`\r\n` + ' 放进参数内容';
const good = "[2609, '`sdsnew` 把 " + String.raw`\\r\\n` + ' 放进参数内容';
if (!s.includes(bad)) {
  console.log('bad pattern not found');
  process.exit(1);
}
s = s.replace(bad, good);
fs.writeFileSync(p, s);
console.log('fixed');
