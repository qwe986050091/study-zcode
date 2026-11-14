// B79 insert: ui/unavailable-tool.ts + util/prepare-headers.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'ui/unavailable-tool.ts',
    want: [2, 2],
    blocks: [
      { at: 3, expect: 'export function markToolPartAsUnavailable(', lines: [
        '// 把动态工具部件标记为「来自不可用工具」，保留静态工具的出处。',
      ] },
      { at: 13, expect: 'export function isToolPartFromUnavailableTool(', lines: [
        '// 判断依据：类型为 dynamic-tool 且 dynamic 已被置为 false。',
      ] },
    ],
  },
  {
    name: 'util/prepare-headers.ts',
    want: [4, 4],
    blocks: [
      { at: 1, expect: 'export function prepareHeaders(', lines: [
        '// 构造 Headers：默认头只补充缺失项，不覆盖调用方显式设置。',
      ] },
      { at: 5, expect: 'const responseHeaders = new Headers(headers ?? {});', lines: [
        '// 以调用方传入的头为基准。',
      ] },
      { at: 7, expect: 'for (const [key, value] of Object.entries(defaultHeaders)) {', lines: [
        '// 逐项补默认值。',
      ] },
      { at: 8, expect: 'if (!responseHeaders.has(key)) {', lines: [
        '// 已存在同名头（大小写不敏感）时保持原样。',
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
