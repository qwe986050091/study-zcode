import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/VK-B44/out-hellotimer.json';
const a = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const e of a) {
  if (e.line === 58) e.c = ['/* 用 ReplyWithSimpleString 回 "+OK"；定时器此时已在队列，客户端收到回复后才陆续触发。 */'];
  if (e.line === 73) e.c = ['/* ValkeyModule_Init 与 CreateCommand 都未返回 ERR 才走到这里，返回 VALKEYMODULE_OK 完成加载。 */'];
}
fs.writeFileSync(p, JSON.stringify(a, null, 1));
console.log('patched');
