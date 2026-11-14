// B35 insert: text stream chat transport + text stream processor
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'ui/text-stream-chat-transport.ts',
    want: [8, 8],
    blocks: [
      {
        at: 1,
        expect: "import type { UIMessageChunk } from '../ui-message-stream/ui-message-chunks';",
        lines: [
          '// ============================================================================',
          '// text-stream-chat-transport：消费纯文本响应的聊天传输实现',
          '// 复用 HttpChatTransport 的请求与错误处理，只覆盖响应解析。',
          '// 响应体被当成一段连续文本，再包装成 UI 分片流。',
          '// 适用于不返回结构化分片的旧接口。',
        ],
      },
      {
        at: 9,
        expect: 'export class TextStreamChatTransport<',
        lines: [
          '// 继承而非组合：请求构造、重试与取消都由基类负责；',
          '// 本类只决定如何把响应字节变成分片。',
        ],
      },
      {
        at: 16,
        expect: 'protected processResponseStream(',
        lines: [
          '// 先按 UTF-8 解码，再交给文本流适配器补 start/finish 等分片。',
        ],
      },
    ],
  },
  {
    name: 'ui/process-text-stream.ts',
    want: [7, 7],
    blocks: [
      {
        at: 1,
        expect: 'export async function processTextStream({',
        lines: [
          '// ============================================================================',
          '// process-text-stream：逐块读取文本响应并回调',
          '// 用 TextDecoderStream 解码为字符串，按块而非按行交付。',
          '// 读取循环只依赖 reader.read()，不关心中间缓冲。',
          '// 该函数不返回内容，仅通过回调产生副作用。',
        ],
      },
      {
        at: 8,
        expect: 'const reader = stream',
        lines: [
          '// 解码流与 reader 都在本函数内创建，不泄漏给调用方。',
        ],
      },
      {
        at: 13,
        expect: 'while (true) {',
        lines: [
          '// 读到 done 立即退出；回调抛错会中断循环并向上传播。',
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
