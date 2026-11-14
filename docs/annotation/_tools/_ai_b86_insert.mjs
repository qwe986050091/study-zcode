import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'version.ts',
    want: [2, 2],
    blocks: [
      {
        at: 1,
        expect: "declare const __PACKAGE_VERSION__: string | undefined;",
        lines: [
          '// 包版本号：构建时由打包器注入 __PACKAGE_VERSION__。',
          "// 未注入时回退为测试占位值 '0.0.0-test'。",
        ],
      },
    ],
  },
  {
    name: 'text-stream/index.ts',
    want: [1, 1],
    blocks: [
      {
        at: 1,
        expect: "export { createTextStreamResponse } from './create-text-stream-response';",
        lines: ['// 文本流响应构造、管道写入与流转换的出口。'],
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
