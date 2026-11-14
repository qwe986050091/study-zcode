// B66 insert: telemetry/get-request-origin.ts + util/log-v2-compatibility-warning.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'telemetry/get-request-origin.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: 'export function getRequestOrigin(url: string | undefined): string | undefined {', lines: [
        '// 取出 URL 的源（协议+主机+端口），作为遥测端点标识。',
        '// 主动剥离路径、查询、片段与凭据等敏感信息。',
      ] },
      { at: 7, expect: 'try {', lines: [
        '// 解析失败或非 http(s) 协议时返回 undefined。',
      ] },
      { at: 18, expect: 'export function sanitizeRequestMetadata(', lines: [
        '// 仅保留源的 url，其余请求元数据原样传递。',
      ] },
    ],
  },
  {
    name: 'util/log-v2-compatibility-warning.ts',
    want: [6, 6],
    blocks: [
      { at: 3, expect: 'export function logV2CompatibilityWarning({', lines: [
        '// 在回退到 v2 规范时输出一次兼容性告警。',
        '// 调用方传入 provider 与模型标识，便于定位来源。',
      ] },
      { at: 10, expect: 'logWarnings({', lines: [
        '// 通过统一的告警通道上报，与其他警告保持一致。',
        '// provider 与 model 会随告警一起透传。',
      ] },
      { at: 13, expect: "type: 'compatibility',", lines: [
        '// 告警类型区别于弃用告警，便于调用方过滤。',
      ] },
      { at: 15, expect: 'details: `Using v2 specification compatibility mode. Some features may not be available.`,', lines: [
        '// 提示部分能力在兼容模式下不可用。',
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
