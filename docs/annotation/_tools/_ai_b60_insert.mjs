// B60 insert: error/no-speech-generated-error.ts + error/verify-no-object-generated-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/no-speech-generated-error.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: "const name = 'AI_NoSpeechGeneratedError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 11, expect: 'export class NoSpeechGeneratedError extends AISDKError {', lines: [
        '// 语音合成未产出音频时抛出，携带各次响应元数据。',
        '// 继承 AISDKError 以复用名称与 cause 处理。',
      ] },
    ],
  },
  {
    name: 'error/verify-no-object-generated-error.ts',
    want: [7, 7],
    blocks: [
      { at: 10, expect: 'export function verifyNoObjectGeneratedError(', lines: [
        '// 测试辅助：断言错误为 NoObjectGeneratedError 且字段一致。',
        '// 用于各类结构化输出失败路径的共用校验。',
      ] },
      { at: 12, expect: 'expected: {', lines: [
        '// 期望的错误消息与模型响应细节。',
      ] },
      { at: 19, expect: 'expect(NoObjectGeneratedError.isInstance(error)).toBeTruthy();', lines: [
        '// 先用 isInstance 做类型收窄。',
        '// 收窄后再逐字段比对。',
      ] },
      { at: 20, expect: 'const noObjectGeneratedError = error as NoObjectGeneratedError;', lines: [
        '// 强转后读取具体字段。',
      ] },
      { at: 21, expect: 'expect(noObjectGeneratedError.message).toEqual(expected.message);', lines: [
        '// 消息必须与预期完全一致。',
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
