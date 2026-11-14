import fs from 'node:fs';
const f = 'D:/code/opensource/ai/packages/ai/src/ui-message-stream/to-ui-message-chunk.ts';
const L = fs.readFileSync(f, 'utf8').split('\r\n');
const i = L.findIndex(l => l.includes("case 'finish-step': {"));
if (i < 0) {
  console.error('MISS');
  process.exit(1);
}
L.splice(
  i,
  0,
  '// finish-step 也可携带 usage 等步级统计：客户端据此展示每步耗时或 token 用量。',
  '// 与 finish 的区别：finish 结束整条消息，finish-step 只结束当前 step，多步时会出现多次。',
  '// 不要把 finish-step 当作 loading 结束信号：多步 agent 在它之后还会继续产出。',
);
fs.writeFileSync(f, L.join('\r\n'), 'utf8');
console.log('ADDED 3');
