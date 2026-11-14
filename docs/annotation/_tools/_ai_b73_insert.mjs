// B73 insert: text-stream/to-text-stream.ts + generate-object/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'text-stream/to-text-stream.ts',
    want: [2, 2],
    blocks: [
      { at: 7, expect: 'export function toTextStream<TOOLS extends ToolSet = ToolSet>({', lines: [
        '// 只保留文本增量，其余分片（工具调用、推理等）丢弃。',
      ] },
      { at: 15, expect: "if (part.type === 'text-delta') {", lines: [
        '// 过滤非文本分片，使输出成为纯字符串流。',
      ] },
    ],
  },
  {
    name: 'generate-object/index.ts',
    want: [5, 5],
    blocks: [
      { at: 1, expect: "export { generateObject } from './generate-object';", lines: [
        '// 结构化对象生成的公共出口。',
      ] },
      { at: 2, expect: 'export type {', lines: [
        '// 生成过程的事件类型。',
      ] },
      { at: 8, expect: "export type { RepairTextFunction } from './repair-text';", lines: [
        '// 修复无效 JSON 文本的回调类型。',
      ] },
      { at: 9, expect: "export type { GenerateObjectResult } from './generate-object-result';", lines: [
        '// 非流式调用的结果类型。',
      ] },
      { at: 10, expect: "export { streamObject } from './stream-object';", lines: [
        '// 流式调用入口与结果类型。',
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
