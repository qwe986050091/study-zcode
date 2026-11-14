// B76 insert: embed/validate-embedding-dimensions.ts + model/get-embedding-model-max-input-bytes-per-call.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'embed/validate-embedding-dimensions.ts',
    want: [4, 4],
    blocks: [
      { at: 3, expect: 'export function validateEmbeddingDimensions(dimensions: number | undefined) {', lines: [
        '// 校验嵌入维度：必须是正整数，undefined 表示使用模型默认值。',
        '// 非法值统一抛 InvalidArgumentError，并带上原值。',
      ] },
      { at: 4, expect: 'if (', lines: [
        '// 只在显式传入时校验。',
      ] },
      { at: 8, expect: 'throw new InvalidArgumentError({', lines: [
        '// 非整数或非正数都视为非法。',
      ] },
    ],
  },
  {
    name: 'model/get-embedding-model-max-input-bytes-per-call.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: 'export type EmbeddingModelWithMaxInputBytesPerCall = EmbeddingModelV4 & {', lines: [
        '// 带可选「单次调用最大输入字节数」的嵌入模型类型。',
      ] },
      { at: 11, expect: 'export function getEmbeddingModelMaxInputBytesPerCall(model: EmbeddingModelV4) {', lines: [
        '// 读取模型声明的单次调用输入上限。',
        '// 可能是数字或 Promise，未声明时为 undefined。',
      ] },
      { at: 12, expect: 'return (model as EmbeddingModelWithMaxInputBytesPerCall)[', lines: [
        '// 通过 Symbol 键读取，避免与业务属性冲突。',
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
