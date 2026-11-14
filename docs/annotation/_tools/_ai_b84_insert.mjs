// B84 insert: embed/index.ts + generate-image/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'embed/index.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: "export * from './embed';", lines: [
        '// 嵌入模块出口：单条/批量嵌入与事件类型。',
      ] },
      { at: 3, expect: "export * from './embed-many';", lines: [
        '// 批量嵌入及其结果类型。',
      ] },
    ],
  },
  {
    name: 'generate-image/index.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: "export { generateImage } from './generate-image';", lines: [
        '// 图像生成模块出口。',
      ] },
      { at: 2, expect: 'export type {', lines: [
        '// 调用描述与结果类型。',
      ] },
    ],
  },
];

let grand = 0;
for (const f of files) {
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  let bad = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      bad++;
    }
    total += b.lines.length;
  }
  if (bad) process.exit(1);
  if (process.env.DRY) {
    console.log('DRY', f.name, total);
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
