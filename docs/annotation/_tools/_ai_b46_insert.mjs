// B46 insert: tool/index.ts + version.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/';
const files = [
  {
    name: 'tool/index.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: "export * from './json-rpc-message';", lines: [
        '// tool 子模块汇总导出：消息、客户端、Apps、OAuth 与传输接口。',
        '// 仅做转出，不引入额外运行时逻辑。',
      ] },
    ],
  },
  {
    name: 'version.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: 'declare const __PACKAGE_VERSION__: string | undefined;', lines: [
        '// 包版本：构建时注入；未注入时回退到测试占位值。',
        '// 该常量用于拼接 User-Agent。',
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
