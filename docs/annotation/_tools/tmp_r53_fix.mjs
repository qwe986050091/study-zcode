// R53 收尾：替换两处与上方注释重复的 getSQLType 内文注释，保持文件换行符。
import fs from 'node:fs';

const file = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/pg-core/columns/enum.ts';
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const pairs = [
  ['// 返回 enum 名本身，schema 前缀留给 dialect 拼接。', '// 读取实例字段 enum 再取 enumName，没有其他分支。'],
  ['// 返回 enum 名本身，与对象形态一致，schema 前缀留给 dialect 拼接。', '// 取值来源与对象形态相同，直接读 enum.enumName。'],
];
let text = raw;
for (const [a, b] of pairs) {
  if (!text.includes(a)) { console.error('MISSING: ' + a); process.exitCode = 1; continue; }
  text = text.replace(a, b);
}
fs.writeFileSync(file, text, 'utf8');
console.log('ok eol=' + JSON.stringify(eol));
