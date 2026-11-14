import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-8.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const e = j.files[0].edits[51];
e.anchor = '// Bugfix: offset 是 Telegram 外部队列的消费确认点。业务回调失败前推进会让';
e.lines = ['              // 回调失败时上一行的断言已抛出，走不到这里，因此不存在先推进后失败的窗口。'];
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('patched 51');
