// B67 insert: error/no-output-generated-error.ts + error/no-translation-generated-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/no-output-generated-error.ts',
    want: [3, 3],
    blocks: [
      { at: 3, expect: "const name = 'AI_NoOutputGeneratedError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
      ] },
      { at: 10, expect: 'export class NoOutputGeneratedError extends AISDKError {', lines: [
        '// 模型未产出任何输出时抛出（例如上游报错）。',
        '// 消息与 cause 均可选，支持无参构造。',
      ] },
    ],
  },
  {
    name: 'error/no-translation-generated-error.ts',
    want: [3, 3],
    blocks: [
      { at: 4, expect: "const name = 'AI_NoTranslationGeneratedError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
      ] },
      { at: 11, expect: 'export class NoTranslationGeneratedError extends AISDKError {', lines: [
        '// 语音翻译未产出结果时抛出，携带响应元数据。',
        '// 默认消息固定，便于上层统一判断。',
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
