// B81 insert: generate-text/reasoning.ts + rerank/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/reasoning.ts',
    want: [3, 3],
    blocks: [
      { at: 3, expect: 'export function asReasoningText(', lines: [
        '// 把推理片段拼成纯文本，非文本片段视为空串。',
        '// 结果为空时返回 undefined，以区分「无推理」。',
      ] },
      { at: 6, expect: 'const reasoningText = reasoningParts', lines: [
        '// 依次取 text 字段后直接拼接，不插入分隔符。',
      ] },
    ],
  },
  {
    name: 'rerank/index.ts',
    want: [3, 3],
    blocks: [
      { at: 1, expect: "export { rerank } from './rerank';", lines: [
        '// 重排序模块公共出口。',
      ] },
      { at: 2, expect: "export type { RerankResult } from './rerank-result';", lines: [
        '// 重排序结果类型。',
      ] },
      { at: 3, expect: 'export type {', lines: [
        '// 生命周期事件类型。',
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
