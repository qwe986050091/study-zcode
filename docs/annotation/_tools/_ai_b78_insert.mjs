// B78 insert: types/json-value.ts + util/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'types/json-value.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: 'export const jsonValueSchema: ZodType<JSONValue> = z.lazy(() =>', lines: [
        '// 递归 JSON 值校验 schema，对象与数组均允许嵌套。',
        '// 使用 z.lazy 处理自引用结构。',
      ] },
      { at: 5, expect: 'z.union([', lines: [
        '// 覆盖 null、基本类型、记录与数组四类形态。',
      ] },
      { at: 15, expect: 'export type JSONValue = OriginalJSONValue;', lines: [
        '// 对外暴露与 provider 包一致的 JSONValue 类型。',
      ] },
    ],
  },
  {
    name: 'util/index.ts',
    want: [4, 4],
    blocks: [
      { at: 1, expect: "export type { AsyncIterableStream } from './async-iterable-stream';", lines: [
        '// 通用工具函数与类型出口。',
      ] },
      { at: 5, expect: "export { getTextFromDataUrl } from './data-url';", lines: [
        '// Data URL 解析。',
      ] },
      { at: 9, expect: "export { isDeepEqualData } from './is-deep-equal-data';", lines: [
        '// 深度相等判断。',
      ] },
      { at: 11, expect: "export { SerialJobExecutor } from './serial-job-executor';", lines: [
        '// 串行任务执行器与模拟流工具。',
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
