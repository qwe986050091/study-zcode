// B63 insert: prompt/message-conversion-error.ts + error/no-transcript-generated-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/message-conversion-error.ts',
    want: [7, 7],
    blocks: [
      { at: 4, expect: "const name = 'AI_MessageConversionError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 8, expect: 'export class MessageConversionError extends AISDKError {', lines: [
        '// UI 消息转换为模型消息失败时抛出。',
        '// 保留原始消息，便于定位不合法的内容结构。',
      ] },
      { at: 11, expect: "readonly originalMessage: Omit<UIMessage, 'id'>;", lines: [
        '// 触发失败的原始 UI 消息（不含 id）。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 消息由调用方提供，以说明具体转换问题。',
      ] },
      { at: 20, expect: 'super({ name, message });', lines: [
        '// 先初始化基类，再保存原始消息。',
      ] },
    ],
  },
  {
    name: 'error/no-transcript-generated-error.ts',
    want: [3, 3],
    blocks: [
      { at: 4, expect: "const name = 'AI_NoTranscriptGeneratedError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
      ] },
      { at: 11, expect: 'export class NoTranscriptGeneratedError extends AISDKError {', lines: [
        '// 转写未产出文本时抛出，携带各次响应元数据。',
        '// 继承 AISDKError 以复用名称与消息处理。',
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
