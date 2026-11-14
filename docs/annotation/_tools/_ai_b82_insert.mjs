// B82 insert: generate-video/index.ts + ui-message-stream/ui-message-stream-headers.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-video/index.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: "export type { GenerateVideoPrompt } from './generate-video';", lines: [
        '// 视频生成模块出口：同步生成、异步启动与状态查询。',
      ] },
      { at: 4, expect: "export { experimental_startVideo } from './start-video';", lines: [
        '// 异步任务式接口：先启动，再轮询状态。',
      ] },
    ],
  },
  {
    name: 'ui-message-stream/ui-message-stream-headers.ts',
    want: [2, 2],
    blocks: [
      { at: 1, expect: 'export const UI_MESSAGE_STREAM_HEADERS = {', lines: [
        '// UI 消息流的默认响应头。',
      ] },
      { at: 6, expect: "'x-accel-buffering': 'no', // disable nginx buffering", lines: [
        '// 关闭 nginx 缓冲，保证事件即时下发。',
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
