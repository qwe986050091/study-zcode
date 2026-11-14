import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/VK-B47/out-localtime.json';
const a = JSON.parse(fs.readFileSync(p, 'utf8'));
const M = {
  64: '/* 三个常量只在本函数可见，避免与 sys/time.h 的 DAY/HOUR 宏重名；下面所有除法都以它们为除数。 */',
  76: '/* 秒 = (当天秒数 % 3600) % 60：先扣整小时，避免分钟段跨小时重复计入。 */',
  97: '/* 12 个元素必须与 tm_mon 的 0–11 严格对齐；数组在栈上，闰年修正只影响本次调用。 */',
  120: '/* tm 未初始化，被测函数会依次写满 isdst/hour/min/sec/wday/year/yday/mon/mday 九个字段。 */',
  123: '/* 传 timezone 而非 tm_gmtoff：被测函数按 POSIX 的「西为正」语义解释该偏移。 */',
};
for (const e of a) if (M[e.line]) e.c = [M[e.line]];
fs.writeFileSync(p, JSON.stringify(a, null, 1));
console.log('patched', Object.keys(M).length);
