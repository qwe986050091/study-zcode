// B74 insert: generate-text/extract-reasoning-content.ts + generate-text/extract-text-content.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/extract-reasoning-content.ts',
    want: [5, 5],
    blocks: [
      { at: 6, expect: 'export function extractReasoningContent(', lines: [
        '// 从模型响应中提取推理（reasoning）文本。',
        '// 多条推理片段以换行拼接，保持原顺序。',
      ] },
      { at: 9, expect: 'const parts = content.filter(', lines: [
        '// 仅保留 reasoning 类型的内容片段。',
      ] },
      { at: 14, expect: 'return parts.length === 0', lines: [
        '// 无推理片段时返回 undefined，而不是空字符串。',
        '// 便于上层区分「未提供」与「提供了空内容」。',
      ] },
    ],
  },
  {
    name: 'generate-text/extract-text-content.ts',
    want: [5, 5],
    blocks: [
      { at: 6, expect: 'export function extractTextContent(', lines: [
        '// 从模型响应中提取正文文本。',
        '// 多个文本片段直接拼接，不插入分隔符。',
      ] },
      { at: 9, expect: 'const parts = content.filter(', lines: [
        '// 仅保留 text 类型的内容片段。',
      ] },
      { at: 13, expect: 'if (parts.length === 0) {', lines: [
        '// 无文本片段时返回 undefined。',
      ] },
      { at: 17, expect: "return parts.map(content => content.text).join('');", lines: [
        '// 保持片段原始顺序进行拼接。',
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
