// B32 insert: deprecated rawInput warning + default stop condition
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'ui/warn-if-ui-message-has-deprecated-raw-input.ts',
    want: [10, 10],
    blocks: [
      {
        at: 1,
        expect: "import { logWarnings } from '../logger/log-warnings';",
        lines: [
          '// ============================================================================',
          '// warn-if-ui-message-has-deprecated-raw-input：检测并提示已废弃的 rawInput',
          '// 遍历 UI 消息部件，只要出现 output-error 与 rawInput 就发一条弃用警告。',
          '// 检测只读，不修改消息；警告走统一 logger，便于宿主集中收集。',
          '// 该函数用于兼容期，rawInput 移除后可整体删除。',
        ],
      },
      {
        at: 3,
        expect: 'const rawInputDeprecationWarning = {',
        lines: [
          '// 警告对象只构造一次并作为常量复用；',
          '// setting 与 message 文本保持一致，便于用户按文档检索。',
        ],
      },
      {
        at: 10,
        expect: 'export function warnIfUIMessageHasDeprecatedRawInput(',
        lines: [
          '// 入参只要求 parts 数组，避免依赖完整 UIMessage 类型；',
          '// 使用 some 短路：任何一条消息命中即停止后续查找。',
        ],
      },
      {
        at: 31,
        expect: 'if (hasDeprecatedRawInput) {',
        lines: [
          '// 命中后只发一次警告，避免同一批消息刷屏。',
        ],
      },
    ],
  },
  {
    name: 'agent/default-stop-condition.ts',
    want: [4, 4],
    blocks: [
      {
        at: 4,
        expect: '/**',
        lines: [
          '// 默认条件在 step 数恰好等于上限时才触发；',
          '// 这样自然结束的调用不会产生「达到上限」的误导警告。',
        ],
      },
      {
        at: 8,
        expect: 'export function createDefaultStopCondition(',
        lines: [
          '// 返回纯函数条件：每次 step 结束由内核调用，只读 steps；',
          '// 达到上限时先发警告再返回 true，两者顺序不可交换。',
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
