// B48 insert: util/write-to-server-response.ts + util/download/download.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/write-to-server-response.ts',
    want: [5, 7],
    blocks: [
      { at: 14, expect: 'export function writeToServerResponse({', lines: [
        '// 把流写入 Node 的 ServerResponse。',
        '// 客户端提前断开时会取消流，释放上游资源并停止写入。',
      ] },
      { at: 27, expect: 'const statusCode = status ?? 200;', lines: [
        '// 先设置响应头与状态行，再开始写数据。',
        '// 缺少 statusText 时只写状态码，保持与 Node 行为一致。',
      ] },
      { at: 38, expect: 'const reader = stream.getReader();', lines: [
        '// 手动读取以感知背压与断开。',
        '// 断开监听在读取前注册，避免漏掉早期的 close 事件。',
      ] },
    ],
  },
  {
    name: 'util/download/download.ts',
    want: [5, 6],
    blocks: [
      { at: 22, expect: 'export const download = async ({', lines: [
        '// 从未知来源下载文件，并限制最大字节数。',
        '// 所有失败统一转换为 DownloadError，便于上层判别。',
      ] },
      { at: 33, expect: 'const headers = withUserAgentSuffix(', lines: [
        '// 附加 SDK 与运行时标识，便于服务端排查。',
      ] },
      { at: 39, expect: 'const response = await fetchUntrustedUrl({', lines: [
        '// 使用受控的 URL 抓取，携带中止信号。',
      ] },
      { at: 56, expect: 'const data = await readResponseWithSizeLimit({', lines: [
        '// 读取时按字节上限截断，超出即报错。',
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
