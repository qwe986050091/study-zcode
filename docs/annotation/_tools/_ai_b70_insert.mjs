// B70 insert: middleware/default-embedding-settings-middleware.ts + telemetry/tracing-channel.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'middleware/default-embedding-settings-middleware.ts',
    want: [3, 3],
    blocks: [
      { at: 8, expect: 'export function defaultEmbeddingSettingsMiddleware({', lines: [
        '// 返回嵌入模型中间件，用于注入默认请求设置。',
      ] },
      { at: 16, expect: 'return {', lines: [
        '// 声明 v4 中间件规范版本。',
      ] },
      { at: 18, expect: 'transformParams: async ({ params }) => {', lines: [
        '// 参数合并：调用方传入值优先，缺省时回退到默认设置。',
      ] },
    ],
  },
  {
    name: 'telemetry/tracing-channel.ts',
    want: [6, 6],
    blocks: [
      { at: 1, expect: "export const AI_SDK_TELEMETRY_TRACING_CHANNEL = 'ai:telemetry';", lines: [
        '// 遥测 tracing 通道名，供 diagnostics_channel 订阅。',
      ] },
      { at: 3, expect: 'export type TelemetryTracingEventType =', lines: [
        '// 可被追踪的 SDK 操作类型。',
        '// 与 tracing 中的 span 名称保持一一对应。',
      ] },
      { at: 17, expect: 'export type TelemetryTracingChannelMessage<EVENT = unknown> = {', lines: [
        '// 通道消息封装：事件类型 + 负载。',
      ] },
      { at: 18, expect: 'readonly type: TelemetryTracingEventType;', lines: [
        '// 事件类型。',
      ] },
      { at: 19, expect: 'readonly event: EVENT;', lines: [
        '// 具体事件负载。',
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
