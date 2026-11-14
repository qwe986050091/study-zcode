// B64 insert: model/as-speech-model-v4.ts + prompt/invalid-message-role-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'model/as-speech-model-v4.ts',
    want: [5, 5],
    blocks: [
      { at: 8, expect: 'export function asSpeechModelV4(', lines: [
        '// 把任意版本的语音模型统一适配为 v4。',
        '// 已是 v4 时直接返回，避免不必要的包装。',
      ] },
      { at: 11, expect: "if (model.specificationVersion === 'v4') {", lines: [
        '// v4 模型无需转换。',
      ] },
      { at: 16, expect: 'const v3Model =', lines: [
        '// 先统一到 v3，再由 Proxy 提升版本号。',
      ] },
      { at: 19, expect: 'return new Proxy(v3Model, {', lines: [
        '// Proxy 只改写 version，其余成员透传。',
      ] },
    ],
  },
  {
    name: 'prompt/invalid-message-role-error.ts',
    want: [6, 6],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidMessageRoleError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 7, expect: 'export class InvalidMessageRoleError extends AISDKError {', lines: [
        '// 消息角色不合法时抛出。',
        '// 默认消息列出允许的四种角色。',
      ] },
      { at: 10, expect: 'readonly role: string;', lines: [
        '// 实际传入的非法角色。',
      ] },
      { at: 12, expect: 'constructor({', lines: [
        '// 未显式传消息时，按固定角色列表生成提示。',
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
