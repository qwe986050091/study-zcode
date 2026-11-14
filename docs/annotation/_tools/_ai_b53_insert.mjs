// B53 insert: transcribe/index.ts + ui/last-assistant-message-is-complete-with-approval-responses.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'transcribe/index.ts',
    want: [3, 3],
    blocks: [
      { at: 19, expect: '// deprecated exports', lines: [
        '// 以下为兼容旧版 API 的导出，后续大版本中移除。',
      ] },
      { at: 24, expect: 'const experimental_transcribe: typeof transcribe = options => {', lines: [
        '// 运行时包装：先发出弃用告警，再转发到新接口。',
      ] },
      { at: 41, expect: 'type Experimental_TranscriptionResult = TranscriptionResult;', lines: [
        '// 旧类型别名，仅保留类型层面的兼容。',
      ] },
    ],
  },
  {
    name: 'ui/last-assistant-message-is-complete-with-approval-responses.ts',
    want: [3, 3],
    blocks: [
      { at: 12, expect: 'const message = messages[messages.length - 1];', lines: [
        '// 只看最后一条消息，空列表直接判定未完成。',
      ] },
      { at: 22, expect: 'const lastStepStartIndex = message.parts.reduce((lastIndex, part, index) => {', lines: [
        '// 定位最后一个 step-start 的索引，后续只看该步内的调用。',
      ] },
      { at: 26, expect: 'const lastStepToolInvocations = message.parts', lines: [
        '// 取出末步中的全部工具调用部件。',
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
