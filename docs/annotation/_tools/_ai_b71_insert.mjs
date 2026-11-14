// B71 insert: error/unsupported-model-version-error.ts + model/as-video-model-v4.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/unsupported-model-version-error.ts',
    want: [2, 2],
    blocks: [
      { at: 6, expect: 'export class UnsupportedModelVersionError extends AISDKError {', lines: [
        '// 模型声明的规范版本不受支持时抛出。',
      ] },
      { at: 19, expect: 'this.version = options.version;', lines: [
        '// 保留版本、provider 与模型 id，便于定位。',
      ] },
    ],
  },
  {
    name: 'model/as-video-model-v4.ts',
    want: [5, 5],
    blocks: [
      { at: 6, expect: 'export function asVideoModelV4(', lines: [
        '// 把 v3 视频模型适配为 v4 契约。',
        '// 已是 v4 时直接返回，避免多余包装。',
      ] },
      { at: 9, expect: "if (model.specificationVersion === 'v4') {", lines: [
        '// v4 模型无需转换。',
      ] },
      { at: 13, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 改写版本号，其余成员透传。',
        '// 视频模型的 v3/v4 差异仅体现在规范版本上。',
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
