import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/retry-with-exponential-backoff.ts',
    want: [16, 16],
    blocks: [
      { at: 1, expect: "import { APICallError } from '@ai-sdk/provider';", lines: ['// provider 包的基础错误类型。'] },
      { at: 2, expect: "import { GatewayError } from '@ai-sdk/gateway';", lines: ['// 网关错误用于审查底层原因。'] },
      { at: 3, expect: 'import {', lines: ['// 通用指数退避实现与重试类型。'] },
      { at: 8, expect: "import { RetryError } from './retry-error';", lines: ['// 统一的重试错误包装。'] },
      { at: 10, expect: 'function getRetryDelayInMs({', lines: ['// 计算重试延迟：优先响应头，其次指数退避。'] },
      { at: 17, expect: 'const headers = APICallError.isInstance(error)', lines: ['// 直接命中 API 错误时取其响应头。'] },
      { at: 19, expect: ': APICallError.isInstance(error.cause)', lines: ['// 否则检查被包装错误的 cause。'] },
      { at: 23, expect: 'if (!headers) return exponentialBackoffDelay;', lines: ['// 没有响应头时使用指数退避延迟。'] },
      { at: 28, expect: "const retryAfterMs = headers['retry-after-ms'];", lines: ['// 读取毫秒级重试提示。'] },
      { at: 37, expect: "const retryAfter = headers['retry-after'];", lines: ['// 其次读取秒级或日期形式的 retry-after。'] },
      { at: 38, expect: 'if (retryAfter && ms === undefined) {', lines: ['// 仅在尚未得到毫秒值时采用。'] },
      { at: 43, expect: 'ms = Date.parse(retryAfter) - Date.now();', lines: ['// 非数字则按 HTTP 日期解析。'] },
      { at: 48, expect: 'if (', lines: ['// 延迟需为非负且在合理区间内，上限 60 秒或不超过指数退避值。'] },
      { at: 65, expect: 'export const retryWithExponentialBackoffRespectingRetryHeaders = ({', lines: ['// 默认最多重试 2 次，初始 2 秒、倍率 2。'] },
      { at: 83, expect: 'shouldRetry: async error =>', lines: ['// 仅重试可重试的 API/网关错误，或调用方追加的判定。'] },
      { at: 89, expect: 'getDelayInMs: ({ error, exponentialBackoffDelay }) =>', lines: ['// 延迟交由响应头感知函数计算。'] },
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
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`ANCHOR FAIL ${f.name} at=${b.at}\n  expect: ${b.expect}\n  actual: ${actual}`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  console.log(`CHECK ${f.name} +${total}`);
  if (process.env.DRY) {
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`WANT FAIL ${f.name} total=${total} want=${f.want.join('~')}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  grand += total;
}
console.log(`SUMMARY files=${files.length} added=${grand}`);
