import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/generate-image/generate-image.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');
const idx = lines.findIndex(l => l.includes('const headersWithUserAgent = withUserAgentSuffix('));
if (idx < 0) {
  console.error('MISS headersWithUserAgent');
  process.exit(1);
}
lines.splice(idx, 0,
  '// 统一附加 SDK 版本 UA，便于 provider 侧统计与问题定位；调用方 headers 不会被覆盖。',
  '// 该 headers 会贯穿每一张图的分片调用，保证同一请求的一致性。',
);
fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED 2');
