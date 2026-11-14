import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/prepare-retries.ts',
    want: [12, 12],
    blocks: [
      { at: 1, expect: "import { InvalidArgumentError } from '../error/invalid-argument-error';", lines: ['// 参数非法时抛出的错误。'] },
      { at: 2, expect: 'import type {', lines: ['// 重试策略相关类型来自 provider-utils。'] },
      { at: 6, expect: "import { retryWithExponentialBackoffRespectingRetryHeaders } from '../util/retry-with-exponential-backoff';", lines: ['// 默认重试实现：指数退避并尊重响应头中的重试指令。'] },
      { at: 10, expect: 'export function prepareRetries({', lines: ['// 校验重试次数并构造重试策略。'] },
      { at: 17, expect: 'maxRetries: number | undefined;', lines: ['// 外部传入的最大重试次数，未传时使用默认值。'] },
      { at: 18, expect: 'abortSignal: AbortSignal | undefined;', lines: ['// 中止信号，用于提前终止重试等待。'] },
      { at: 19, expect: 'additionalRetryableError?: ShouldRetryFunction;', lines: ['// 额外的可重试错误判定。'] },
      { at: 20, expect: 'parameter?: string;', lines: ['// 参数名与默认值，便于错误信息与调用方定制。'] },
      { at: 26, expect: 'if (maxRetries != null) {', lines: ['// 显式传入时必须是整数。'] },
      { at: 35, expect: 'if (maxRetries < 0) {', lines: ['// 且不能为负数。'] },
      { at: 44, expect: 'const maxRetriesResult = maxRetries ?? defaultMaxRetries;', lines: ['// 未指定时回退到默认重试次数。'] },
      { at: 46, expect: 'return {', lines: ['// 返回归一化次数与绑定好的重试函数。'] },
    ],
  },
  {
    name: 'error/index.ts',
    want: [13, 13],
    blocks: [
      { at: 1, expect: "import { Experimental_DecisionUnsupportedQuestionTypeError } from '@ai-sdk/provider';", lines: ['// 从 provider 包引入决策相关错误，用于废弃别名。'] },
      { at: 3, expect: 'export {', lines: ['// 直接转导 provider 包中的通用错误类型。'] },
      { at: 22, expect: "export { InvalidArgumentError } from './invalid-argument-error';", lines: ['// 参数与流分片错误。'] },
      { at: 24, expect: "export { InvalidToolApprovalError } from './invalid-tool-approval-error';", lines: ['// 工具审批相关错误。'] },
      { at: 27, expect: "export { ToolCallNotFoundForApprovalError } from './tool-call-not-found-for-approval-error';", lines: ['// 工具调用与结果缺失错误。'] },
      { at: 29, expect: "export { NoImageGeneratedError } from './no-image-generated-error';", lines: ['// 各类内容未生成的错误。'] },
      { at: 36, expect: "export { NoSuchToolError } from './no-such-tool-error';", lines: ['// 未知工具、提供方与修复错误。'] },
      { at: 39, expect: "export { ToolChoiceViolationError } from './tool-choice-violation-error';", lines: ['// 工具选择违规与模型版本不支持错误。'] },
      { at: 41, expect: "export { UIMessageStreamError } from './ui-message-stream-error';", lines: ['// UI 消息流错误。'] },
      { at: 42, expect: "export { InvalidDataContentError } from '../prompt/invalid-data-content-error';", lines: ['// 提示词数据与角色转换错误。'] },
      { at: 45, expect: "export { DownloadError } from '@ai-sdk/provider-utils';", lines: ['// 下载与重试错误。'] },
      { at: 49, expect: 'export const Experimental_EvaluationUnsupportedQuestionTypeError =', lines: ['// 废弃别名：保留旧名指向决策错误。'] },
      { at: 52, expect: 'export type Experimental_EvaluationUnsupportedQuestionTypeError =', lines: ['// 类型层面的同名废弃别名。'] },
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
