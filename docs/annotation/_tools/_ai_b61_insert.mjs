// B61 insert: prompt/invalid-data-content-error.ts + error/invalid-stream-part-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/invalid-data-content-error.ts',
    want: [7, 7],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidDataContentError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 7, expect: 'export class InvalidDataContentError extends AISDKError {', lines: [
        '// 数据内容不符合预期类型时抛出。',
        '// 典型场景是 base64 字符串与二进制数据之间的转换。',
      ] },
      { at: 10, expect: 'readonly content: unknown;', lines: [
        '// 原始内容，便于上层判断实际类型。',
      ] },
      { at: 12, expect: 'constructor({', lines: [
        '// 默认消息说明期望类型与实际类型。',
      ] },
      { at: 21, expect: 'super({ name, message, cause });', lines: [
        '// 先初始化基类，再保存原始内容。',
      ] },
    ],
  },
  {
    name: 'error/invalid-stream-part-error.ts',
    want: [7, 7],
    blocks: [
      { at: 4, expect: "const name = 'AI_InvalidStreamPartError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance，避免依赖 instanceof。',
      ] },
      { at: 8, expect: 'export class InvalidStreamPartError extends AISDKError {', lines: [
        '// 模型流中出现无法识别的分片时抛出。',
        '// 保留原始分片，便于定位 provider 的异常输出。',
      ] },
      { at: 11, expect: 'readonly chunk: LanguageModelStreamPart<any>;', lines: [
        '// 触发错误的原始流分片。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 消息由调用方提供，用于描述具体的分片问题。',
      ] },
      { at: 20, expect: 'super({ name, message });', lines: [
        '// 由基类设置名称与消息，再保存分片。',
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
