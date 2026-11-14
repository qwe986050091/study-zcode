// B80 insert: middleware/index.ts + upload-skill/upload-skill-result.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'middleware/index.ts',
    want: [3, 3],
    blocks: [
      { at: 1, expect: "export { defaultEmbeddingSettingsMiddleware } from './default-embedding-settings-middleware';", lines: [
        '// 默认设置类中间件：嵌入、指令与通用调用设置。',
      ] },
      { at: 4, expect: "export { extractJsonMiddleware } from './extract-json-middleware';", lines: [
        '// 内容提取类中间件：JSON 与推理文本。',
      ] },
      { at: 9, expect: "export { wrapEmbeddingModel } from './wrap-embedding-model';", lines: [
        '// 模型与 provider 包装器。',
      ] },
    ],
  },
  {
    name: 'upload-skill/upload-skill-result.ts',
    want: [3, 3],
    blocks: [
      { at: 5, expect: 'export type UploadSkillResult = Omit<', lines: [
        '// 上传技能结果：在 provider 结构上补充 provider 引用与告警。',
      ] },
      { at: 9, expect: 'readonly providerReference: ProviderReference;', lines: [
        '// provider 引用用于标识技能归属。',
      ] },
      { at: 10, expect: 'readonly warnings: Warning[];', lines: [
        '// 上传过程中产生的告警。',
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
