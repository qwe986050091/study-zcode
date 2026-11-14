// B51 insert: util/canonical-hash.ts + generate-speech/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/canonical-hash.ts',
    want: [3, 3],
    blocks: [
      { at: 3, expect: 'const encoder = new TextEncoder();', lines: [
        '// 复用同一个编码器实例，避免重复分配。',
      ] },
      { at: 30, expect: 'export function toBase64url(bytes: Uint8Array): string {', lines: [
        '// 把标准 base64 转成 URL 安全的 base64url，并去掉填充。',
        '// 便于直接用于令牌或哈希摘要等场景。',
      ] },
    ],
  },
  {
    name: 'generate-speech/index.ts',
    want: [3, 3],
    blocks: [
      { at: 20, expect: '// deprecated exports', lines: [
        '// 以下为兼容旧版 API 的导出，将在后续大版本中移除。',
      ] },
      { at: 25, expect: 'const experimental_generateSpeech: typeof generateSpeech = options => {', lines: [
        '// 运行时包装：先发出弃用告警，再转发到新接口。',
      ] },
      { at: 42, expect: 'type Experimental_SpeechResult = SpeechResult;', lines: [
        '// 旧类型别名，仅用于类型层面的向后兼容。',
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
