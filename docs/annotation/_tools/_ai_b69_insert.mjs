// B69 insert: model/as-speech-model-v3.ts + ui/create-ui-api-call-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'model/as-speech-model-v3.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: 'export function asSpeechModelV3(', lines: [
        '// 把 v2 语音模型适配为 v3（仅改写版本号）。',
        '// 已是 v3 时直接返回，避免多余包装。',
      ] },
      { at: 7, expect: "if (model.specificationVersion === 'v3') {", lines: [
        '// v3 模型无需转换。',
      ] },
      { at: 18, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 改写版本号，其余成员透传。',
      ] },
    ],
  },
  {
    name: 'ui/create-ui-api-call-error.ts',
    want: [4, 4],
    blocks: [
      { at: 3, expect: 'export async function createUIApiCallError({', lines: [
        '// 从失败的 UI 请求响应构造统一的 APICallError。',
        '// 优先使用响应体作为消息，为空时回退到调用方文案。',
      ] },
      { at: 12, expect: 'const responseBody = await response.text();', lines: [
        '// 一次性读取响应体，供消息与错误字段复用。',
      ] },
      { at: 14, expect: 'return new APICallError({', lines: [
        '// 不携带 requestBodyValues，避免提示词等敏感内容暴露给客户端。',
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
