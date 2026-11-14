// B50 insert: embed/restricted-telemetry-dispatcher.ts + rerank/restricted-telemetry-dispatcher.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'embed/restricted-telemetry-dispatcher.ts',
    want: [8, 8],
    blocks: [
      { at: 9, expect: '/**', lines: [
        '// Embed 专用遥测分发器：对外暴露与通用分发器一致的回调形状。',
        '// 差异在于发给集成方的 runtimeContext 会先经过过滤。',
      ] },
      { at: 13, expect: 'export function createRestrictedTelemetryDispatcher<', lines: [
        '// 包装通用分发器，只重写 onStart 与 onEnd 两个回调。',
        '// 用户回调仍收到原始上下文，避免影响业务侧逻辑。',
      ] },
      { at: 23, expect: 'const dispatcher = createTelemetryDispatcher({ telemetry });', lines: [
        '// 先构造通用分发器，其余回调保持透传。',
      ] },
      { at: 25, expect: 'return {', lines: [
        '// 展开保留 onError 等其他能力。',
      ] },
      { at: 27, expect: 'onStart: event =>', lines: [
        '// 起始事件按 includeRuntimeContext 决定是否附带上下文。',
      ] },
      { at: 35, expect: 'onEnd: event =>', lines: [
        '// 结束事件采用同样的过滤规则，保持前后一致。',
      ] },
    ],
  },
  {
    name: 'rerank/restricted-telemetry-dispatcher.ts',
    want: [8, 8],
    blocks: [
      { at: 9, expect: '/**', lines: [
        '// Rerank 专用遥测分发器：回调签名与通用分发器保持一致。',
        '// 发给集成方的 runtimeContext 同样需要按配置过滤。',
      ] },
      { at: 13, expect: 'export function createRestrictedTelemetryDispatcher<', lines: [
        '// 包装通用分发器，仅替换 onStart 与 onEnd 的实现。',
        '// 用户回调拿到原始上下文，不受遥测过滤影响。',
      ] },
      { at: 23, expect: 'const dispatcher = createTelemetryDispatcher({ telemetry });', lines: [
        '// 复用通用分发器，其他回调直接透传。',
      ] },
      { at: 25, expect: 'return {', lines: [
        '// 展开后保留 onError 等未重写的方法。',
      ] },
      { at: 27, expect: 'onStart: event =>', lines: [
        '// 起始事件按 includeRuntimeContext 控制上下文可见性。',
      ] },
      { at: 35, expect: 'onEnd: event =>', lines: [
        '// 结束事件做相同处理，确保两端行为对称。',
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
