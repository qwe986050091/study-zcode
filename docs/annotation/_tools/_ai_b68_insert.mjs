// B68 insert: model/as-embedding-model-v3.ts + model/as-image-model-v3.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'model/as-embedding-model-v3.ts',
    want: [5, 5],
    blocks: [
      { at: 4, expect: 'export function asEmbeddingModelV3(', lines: [
        '// 把 v2 嵌入模型适配为 v3 契约。',
        '// 已是 v3 时直接返回，避免多余包装。',
      ] },
      { at: 7, expect: "if (model.specificationVersion === 'v3') {", lines: [
        '// v3 模型无需转换。',
      ] },
      { at: 11, expect: 'logV2CompatibilityWarning({', lines: [
        '// 使用 v2 模型时输出兼容性告警。',
      ] },
      { at: 18, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 改写 specificationVersion，其余属性透传。',
      ] },
    ],
  },
  {
    name: 'model/as-image-model-v3.ts',
    want: [5, 5],
    blocks: [
      { at: 4, expect: 'export function asImageModelV3(', lines: [
        '// 把 v2 图像模型适配为 v3 契约。',
        '// 已是 v3 时直接返回，保持零开销。',
      ] },
      { at: 7, expect: "if (model.specificationVersion === 'v3') {", lines: [
        '// v3 模型无需转换。',
      ] },
      { at: 11, expect: 'logV2CompatibilityWarning({', lines: [
        '// 使用 v2 模型时输出兼容性告警。',
      ] },
      { at: 18, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 改写版本号，其余属性原样透传。',
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
