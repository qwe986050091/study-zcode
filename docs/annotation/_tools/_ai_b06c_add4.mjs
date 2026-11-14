import fs from 'node:fs';
const f = 'D:/code/opensource/ai/packages/ai/src/ui-message-stream/ui-message-chunks.ts';
const L = fs.readFileSync(f, 'utf8').split('\r\n');
const i = L.findIndex(l => l.includes("z.looseObject({"));
if (i < 0) {
  console.error('MISS');
  process.exit(1);
}
L.splice(
  i,
  0,
  '// 说明：以下每个分支的字段都直接对应线上协议，删改字段等同于破坏兼容性；',
  '// 新增字段必须可选，并同时更新下方的 TS 联合类型。',
  '// 校验器与类型定义之间没有自动同步机制，靠评审与测试保证一致。',
  '// 若发现两者不一致，以愿意在网络上传输的形状为准，并补齐另一方。',
);
fs.writeFileSync(f, L.join('\r\n'), 'utf8');
console.log('ADDED 4');
