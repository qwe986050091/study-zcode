// 删除本次插入时误加的单行空行（仅当目标行确为空行时），恢复基线行数。
import fs from 'node:fs';

const repo = 'D:/code/ZCode';
const rel = process.argv[2];
const target = Number(process.argv[3]); // 1-based
const abs = `${repo}/${rel}`;
const text = fs.readFileSync(abs, 'utf8');
const crlf = text.includes('\r\n');
const lines = text.split(/\r?\n/);
const trailing = lines.length && lines[lines.length - 1] === '';
if (trailing) lines.pop();
if (lines[target - 1] !== '') {
  console.error('TARGET NOT BLANK: ' + JSON.stringify(lines[target - 1]));
  process.exit(1);
}
lines.splice(target - 1, 1);
fs.writeFileSync(abs, lines.join(crlf ? '\r\n' : '\n') + (trailing ? (crlf ? '\r\n' : '\n') : ''));
console.log('REMOVED BLANK LINE ' + target + ' in ' + rel);
