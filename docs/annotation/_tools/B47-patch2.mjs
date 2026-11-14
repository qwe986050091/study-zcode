import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/VK-B47/out-localtime.json';
const a = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const e of a) {
  if (e.line === 73) e.c = ['/* 原样写入 dst，不做校验：调用方传错时 tm_isdst 会与实际时区不一致，格式化结果整体偏一小时。 */'];
}
a.push({ line: 63, c: ['/* 入参 tz 为 POSIX 语义的「西为正」偏移，dst 为 0/1；函数不读任何全局，也不加锁。 */'] });
a.sort((x, y) => x.line - y.line);
fs.writeFileSync(p, JSON.stringify(a, null, 1));
console.log('entries', a.length);
