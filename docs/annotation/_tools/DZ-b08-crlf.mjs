// 归一化行尾：把仅 LF 的行补成 CRLF（Edit 插入的新注释行可能只带 \n）。
import fs from 'node:fs';
const target = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/sqlite-core/dialect.ts';
const raw = fs.readFileSync(target, 'utf8');
const before = (raw.match(/(^|[^\r])\n/g) || []).length;
const fixed = raw.replace(/(^|[^\r])\n/g, '$1\r\n');
fs.writeFileSync(target, fixed, 'utf8');
console.log(`lfOnlyBefore=${before} crlf=${(fixed.match(/\r\n/g) || []).length}`);
