// B85 insert: translate/index.ts + util/is-non-empty-object.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'translate/index.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: "export { streamTranslate as experimental_streamTranslate } from './stream-translate';", lines: [
        '// 语音翻译模块出口，仅提供流式接口。',
      ] },
      { at: 2, expect: 'export type {', lines: [
        '// 与流式结果相关的类型。',
      ] },
    ],
  },
  {
    name: 'util/is-non-empty-object.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: 'export function isNonEmptyObject(', lines: [
        '// 类型守卫：判断值是否为非空对象。',
      ] },
      { at: 4, expect: 'return object != null && Object.keys(object).length > 0;', lines: [
        '// 先排除 null/undefined，再检查键数量。',
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
