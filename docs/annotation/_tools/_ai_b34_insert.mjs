// B34 insert: ui-message-stream barrel + text stream adapter
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'ui-message-stream/index.ts',
    want: [8, 8],
    blocks: [
      {
        at: 1,
        expect: "export { createUIMessageStream } from './create-ui-message-stream';",
        lines: [
          '// ============================================================================',
          '// ui-message-stream 公共导出（barrel）',
          '// 流创建、SSE 转换、读取、分片校验与回调类型统一从这里出口。',
          '// 上层只通过 ai 主入口使用，不依赖子路径。',
        ],
      },
      {
        at: 6,
        expect: 'export {',
        lines: [
          '// 分片转换同时导出运行时函数、schema 与类型；',
          '// schema 与类型同源，保证校验与类型收窄一致。',
        ],
      },
      {
        at: 11,
        expect: 'export {',
        lines: [
          '// 分片协议是所有 UI 传输的共同契约；',
          '// 新增分片类型必须同时更新 schema 与联合类型。',
        ],
      },
    ],
  },
  {
    name: 'ui/transform-text-to-ui-message-stream.ts',
    want: [8, 8],
    blocks: [
      {
        at: 1,
        expect: "import type { UIMessageChunk } from '../ui-message-stream/ui-message-chunks';",
        lines: [
          '// ============================================================================',
          '// transform-text-to-ui-message-stream：把纯文本流包装成 UI 消息分片流',
          '// 固定使用 id=text-1，一段文本对应一个 text 部件。',
          '// 两侧补齐 start/start-step 与 text-end/finish-step/finish。',
          '// 该适配器用于只返回纯文本的旧接口。',
        ],
      },
      {
        at: 8,
        expect: 'return stream.pipeThrough(',
        lines: [
          '// pipeThrough 保持惰性：源流被消费时才建立分片；',
          '// 不缓存整段文本，逐块转发。',
        ],
      },
      {
        at: 16,
        expect: 'async transform(part, controller) {',
        lines: [
          '// 每个字符串块直接成为一个 delta，不做合并或节流。',
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
