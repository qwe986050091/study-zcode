// B47 insert: parse-and-validate-object-result.ts + reasoning-output.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-object/parse-and-validate-object-result.ts',
    want: [6, 8],
    blocks: [
      { at: 21, expect: 'async function parseAndValidateObjectResult<RESULT>(', lines: [
        '// 先解析 JSON，再交给输出策略做最终校验。',
        '// 任一阶段失败都包装为 NoObjectGeneratedError，并带上原文与用量。',
      ] },
      { at: 30, expect: 'const parseResult = await safeParseJSON({ text: result });', lines: [
        '// 安全解析：不抛异常，把失败原因保留在 error 字段。',
        '// 解析失败时不再尝试 schema 校验。',
      ] },
      { at: 43, expect: 'const validationResult = await outputStrategy.validateFinalResult(', lines: [
        '// 由策略决定校验方式，支持对象、数组与枚举等输出形态。',
        '// 校验上下文包含原始文本、响应元数据与用量，便于错误诊断。',
      ] },
    ],
  },
  {
    name: 'generate-text/reasoning-output.ts',
    want: [1, 1],
    blocks: [
      { at: 57, expect: 'export function convertFromReasoningOutputs(', lines: [
        '// 把内部推理输出转换为协议部件，供消息组装使用。',
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
