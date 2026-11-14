// B77 insert: prompt/prepare-tool-choice.ts + telemetry/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/prepare-tool-choice.ts',
    want: [3, 3],
    blocks: [
      { at: 4, expect: 'export function prepareToolChoice({', lines: [
        '// 把内部的 ToolChoice 规范化为 provider 的 v4 工具选择结构。',
        '// 未指定时默认 auto，字符串直接映射为同名类型。',
      ] },
      { at: 10, expect: 'return toolChoice == null', lines: [
        '// 对象形式表示强制调用指定工具。',
      ] },
    ],
  },
  {
    name: 'telemetry/index.ts',
    want: [4, 4],
    blocks: [
      { at: 1, expect: "export type { TelemetryOptions } from './telemetry-options';", lines: [
        '// 遥测模块公共出口。',
      ] },
      { at: 2, expect: 'export type {', lines: [
        '// 遥测接口与事件上下文类型。',
      ] },
      { at: 8, expect: "export { registerTelemetry } from './telemetry-registry';", lines: [
        '// 全局遥测注册函数。',
      ] },
      { at: 9, expect: 'export {', lines: [
        '// tracing 通道常量与消息类型。',
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
