// B54 insert: util/retry-error.ts + batch/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/retry-error.ts',
    want: [8, 8],
    blocks: [
      { at: 3, expect: "const name = 'AI_RetryError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别同一错误类型。',
        '// 标记挂在实例上后，isInstance 无需依赖 instanceof。',
      ] },
      { at: 7, expect: 'export type RetryErrorReason =', lines: [
        '// 重试终止的三种原因：次数耗尽、不可重试、主动中止。',
      ] },
      { at: 12, expect: 'export class RetryError extends AISDKError {', lines: [
        '// 汇总重试过程的错误，供上层统一判断失败原因。',
        '// 保留每次尝试的错误列表，便于定位最后一次失败。',
      ] },
      { at: 20, expect: 'constructor({', lines: [
        '// 构造时先初始化基类，再分别保存原因与错误序列。',
      ] },
      { at: 38, expect: 'static isInstance(error: unknown): error is RetryError {', lines: [
        '// 通过标记做类型收窄，兼容多份 SDK 实例共存的情况。',
        '// 不使用 instanceof，避免包重复安装导致的判定失败。',
      ] },
    ],
  },
  {
    name: 'batch/index.ts',
    want: [9, 9],
    blocks: [
      { at: 1, expect: 'export {', lines: [
        '// 批处理模块的公共出口。',
        '// 现有 API 仍以 experimental_ 前缀导出，保持兼容。',
      ] },
      { at: 8, expect: 'export type {', lines: [
        '// 类型出口同样使用实验性前缀。',
        '// 覆盖批次抽象、状态、开关与各模态的条目结果。',
      ] },
      { at: 9, expect: 'BatchError as Experimental_BatchError,', lines: [
        '// 错误与 provider 抽象。',
      ] },
      { at: 12, expect: 'BatchStatus as Experimental_BatchStatus,', lines: [
        '// 批次状态与取消能力。',
      ] },
      { at: 15, expect: 'GetBatchResultsOptions as Experimental_GetBatchResultsOptions,', lines: [
        '// 结果查询与列表查询的入参。',
      ] },
      { at: 19, expect: 'StartBatchOptions as Experimental_StartBatchOptions,', lines: [
        '// 启动批次的入参与返回值。',
      ] },
      { at: 21, expect: 'Batch as Experimental_Batch,', lines: [
        '// 数据模型、条目结果与各模态请求结构。',
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
