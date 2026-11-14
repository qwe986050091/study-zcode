import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'types/provider-reference.ts',
    want: [1, 1],
    blocks: [
      {
        at: 3,
        expect: 'export type ProviderReference = SharedV4ProviderReference;',
        lines: ['// 对外暴露的提供方引用类型，与 provider 包中的 V4 定义保持一致。'],
      },
    ],
  },
  {
    name: 'upload-file/index.ts',
    want: [1, 1],
    blocks: [
      {
        at: 1,
        expect: "export { uploadFile } from './upload-file';",
        lines: ['// 文件上传入口与上传结果类型的出口。'],
      },
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
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`ANCHOR FAIL ${f.name} at=${b.at}\n  expect: ${b.expect}\n  actual: ${actual}`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  console.log(`CHECK ${f.name} +${total}`);
  if (process.env.DRY) {
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`WANT FAIL ${f.name} total=${total} want=${f.want.join('~')}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  grand += total;
}
console.log(`SUMMARY files=${files.length} added=${grand}`);
