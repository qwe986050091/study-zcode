import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-auth\\src\\middleware.rs';
let lines = fs.readFileSync(file, 'utf8').split('\n');
const text = '// 两个索引使用相同用户名但不同密码，刻意制造「仅靠用户名无法区分」的情况。';
const bad = lines.findIndex((l) => l.trim() === text);
if (bad < 0) throw new Error('comment not found');
lines.splice(bad, 1);
const fnIdx = lines.findIndex((l) => l.includes('async fn test_credentials_from_keyring_mixed_authentication_different_indexes_same_realm()'));
if (fnIdx < 0) throw new Error('fn not found');
lines.splice(fnIdx, 0, '    ' + text);
fs.writeFileSync(file, lines.join('\n'));
console.log('moved comment above fn at', fnIdx + 1);
