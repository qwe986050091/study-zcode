// B58 insert: error/tool-call-not-found-for-approval-error.ts + error/tool-call-repair-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/tool-call-not-found-for-approval-error.ts',
    want: [8, 8],
    blocks: [
      { at: 3, expect: "const name = 'AI_ToolCallNotFoundForApprovalError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包稳定识别。',
        '// 标记用于 isInstance，避免依赖 instanceof。',
      ] },
      { at: 7, expect: 'export class ToolCallNotFoundForApprovalError extends AISDKError {', lines: [
        '// 审批请求找不到对应工具调用时抛出。',
        '// 常见于审批回复引用了已失效的调用 id。',
      ] },
      { at: 10, expect: 'readonly toolCallId: string;', lines: [
        '// 相关工具调用与审批请求的标识。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 消息同时包含两个 id，便于快速定位错配。',
      ] },
      { at: 20, expect: 'super({', lines: [
        '// 由基类统一设置错误名称与消息。',
      ] },
      { at: 25, expect: 'this.toolCallId = toolCallId;', lines: [
        '// 保存标识，供上层做恢复或提示。',
      ] },
    ],
  },
  {
    name: 'error/tool-call-repair-error.ts',
    want: [7, 7],
    blocks: [
      { at: 5, expect: "const name = 'AI_ToolCallRepairError';", lines: [
        '// 错误名称、标记与 Symbol 键，供跨包识别。',
        '// 标记同时用于运行时类型收窄。',
      ] },
      { at: 9, expect: 'export class ToolCallRepairError extends AISDKError {', lines: [
        '// 工具调用修复失败时抛出，并包装原始错误。',
        '// 保留原始错误类型，便于区分未知工具与参数非法。',
      ] },
      { at: 12, expect: 'readonly originalError: NoSuchToolError | InvalidToolInputError;', lines: [
        '// 触发本次修复的原始错误。',
      ] },
      { at: 14, expect: 'constructor({', lines: [
        '// 未显式传入消息时，从 cause 提取可读描述。',
      ] },
      { at: 23, expect: 'super({ name, message, cause });', lines: [
        '// 先初始化基类，再记录原始错误。',
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
