// B33 insert: default settings + default instructions middleware
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'middleware/default-settings-middleware.ts',
    want: [6, 6],
    blocks: [
      {
        at: 1,
        expect: "import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// default-settings-middleware：为每次调用补默认生成参数',
          '// 只覆盖调用方未显式提供的字段，已有值优先。',
          '// 合并交给 mergeObjects，嵌套对象不会被整体替换。',
        ],
      },
      {
        at: 29,
        expect: 'transformParams: async ({ params }) => {',
        lines: [
          '// [事务] 不修改入参，返回新的参数对象；',
          '// 默认值只在本中间件内生效，不写回模型配置。',
        ],
      },
    ],
  },
  {
    name: 'middleware/default-instructions-middleware.ts',
    want: [2, 2],
    blocks: [
      {
        at: 10,
        expect: 'export function defaultInstructionsMiddleware({',
        lines: [
          '// 默认指令在创建中间件时预构造为 system 消息；',
          '// 调用已含任意 system 消息时整体跳过，避免重复注入。',
        ],
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
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      process.exit(1);
    }
    total += b.lines.length;
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
