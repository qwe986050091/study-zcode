// B75 insert: model/get-embedding-model-provider-options-transformer.ts + model/as-reranking-model-v4.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'model/get-embedding-model-provider-options-transformer.ts',
    want: [4, 4],
    blocks: [
      { at: 7, expect: 'export type EmbeddingModelWithProviderOptionsTransformer = EmbeddingModelV4 & {', lines: [
        '// 带可选 provider 选项转换器的嵌入模型类型。',
      ] },
      { at: 11, expect: 'export function getEmbeddingModelProviderOptionsTransformer(', lines: [
        '// 读取模型上挂载的实验性转换器。',
        '// 未挂载时返回 undefined，调用方按无转换处理。',
      ] },
      { at: 14, expect: 'return (model as EmbeddingModelWithProviderOptionsTransformer)[', lines: [
        '// 通过 Symbol 键访问，避免与业务属性冲突。',
      ] },
    ],
  },
  {
    name: 'model/as-reranking-model-v4.ts',
    want: [4, 4],
    blocks: [
      { at: 3, expect: 'export function asRerankingModelV4(', lines: [
        '// 把 v3 重排序模型适配为 v4。',
        '// 已是 v4 时直接返回，避免多余包装。',
      ] },
      { at: 6, expect: "if (model.specificationVersion === 'v4') {", lines: [
        '// v4 模型无需转换。',
      ] },
      { at: 10, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 改写版本号，其余成员透传。',
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
