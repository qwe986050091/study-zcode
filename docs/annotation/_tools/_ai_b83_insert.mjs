// B83 insert: generate-text/is-tool-execution-allowed-finish-reason.ts + generate-text/tool-output.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/is-tool-execution-allowed-finish-reason.ts',
    want: [2, 2],
    blocks: [
      { at: 3, expect: 'export function isToolExecutionAllowedFinishReason(', lines: [
        '// 只有正常结束或工具调用结束才允许继续执行工具。',
        '// 其他原因（长度、内容过滤等）一律视为不可执行。',
      ] },
    ],
  },
  {
    name: 'generate-text/tool-output.ts',
    want: [2, 2],
    blocks: [
      { at: 5, expect: 'export type ToolOutput<TOOLS extends ToolSet> =', lines: [
        '// 工具输出：成功结果或类型化错误的联合。',
      ] },
      { at: 6, expect: '| TypedToolResult<TOOLS>', lines: [
        '// 具体类型由工具集合推断，调用方按工具名收窄。',
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
