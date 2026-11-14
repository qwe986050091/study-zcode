import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');
const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 53 个 / 36,676 单元；剩余 **49 个 / 20,424 单元**（未覆盖 17,795）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 54 个 / 36,708 单元；剩余 **48 个 / 20,392 单元**（未覆盖 17,768）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);
const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);
fs.writeFileSync(RL, s);
console.log('readme section3 updated');
