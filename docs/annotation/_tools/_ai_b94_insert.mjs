import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'telemetry/filter-included-context.ts',
    want: [17, 17],
    blocks: [
      { at: 1, expect: 'import type {', lines: ['// provider-utils 的上下文与工具集类型。'] },
      { at: 7, expect: 'import type {', lines: ['// 遥测包含配置类型。'] },
      { at: 16, expect: 'export function filterIncludedContext<CONTEXT extends Context>({', lines: ['// 按 includeContext 标记筛选运行时上下文的顶层字段。'] },
      { at: 20, expect: 'context: CONTEXT;', lines: ['// 入参：运行时上下文与包含配置。'] },
      { at: 23, expect: 'if (context == null) {', lines: ['// 上下文为空时返回空对象。'] },
      { at: 27, expect: 'return Object.fromEntries(', lines: ['// 仅保留显式标记为 true 的键。'] },
      { at: 29, expect: '([key]) => includeContext?.[key as keyof CONTEXT] === true,', lines: ['// 值为 true 才纳入。'] },
      { at: 34, expect: 'export function filterToolsContext<TOOLS extends ToolSet>({', lines: ['// 筛选每个工具的上下文。'] },
      { at: 38, expect: 'toolsContext: InferToolSetContext<TOOLS>;', lines: ['// 入参：工具上下文集合与包含配置。'] },
      { at: 41, expect: 'if (includeToolsContext == null) {', lines: ['// 未配置时返回空对象。'] },
      { at: 45, expect: 'return Object.fromEntries(', lines: ['// 逐个工具筛选后重建对象。'] },
      { at: 46, expect: 'Object.entries(toolsContext).map(([toolName, toolContext]) => [', lines: ['// 保留工具名，仅过滤其上下文内容。'] },
      { at: 48, expect: 'filterToolContext({', lines: ['// 复用单工具筛选逻辑。'] },
      { at: 57, expect: 'export function filterToolContext<TOOLS extends ToolSet>({', lines: ['// 按工具名取出对应的包含配置。'] },
      { at: 66, expect: 'const includeToolContext = (', lines: ['// 取出该工具的字段白名单。'] },
      { at: 75, expect: 'return filterIncludedContext({', lines: ['// 交给通用上下文筛选处理。'] },
      { at: 77, expect: 'includeContext: includeToolContext,', lines: ['// 类型收窄到具体工具的上下文。'] },
    ],
  },
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
      { at: 19, expect: '? APICallError.isInstance(error.cause)', lines: ['// 否则检查被包装错误的 cause。'] },
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
