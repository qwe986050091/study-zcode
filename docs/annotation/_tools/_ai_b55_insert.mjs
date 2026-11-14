// B55 insert: error/invalid-tool-approval-signature-error.ts + error/no-such-tool-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/invalid-tool-approval-signature-error.ts',
    want: [9, 9],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidToolApprovalSignatureError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包稳定识别。',
        '// 标记让 isInstance 不依赖 instanceof。',
      ] },
      { at: 7, expect: 'export class InvalidToolApprovalSignatureError extends AISDKError {', lines: [
        '// 工具审批签名校验失败时抛出。',
        '// 携带审批与工具调用标识，便于定位被篡改的响应。',
      ] },
      { at: 10, expect: 'readonly approvalId: string;', lines: [
        '// 审批条目的唯一标识。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 构造消息时把原因拼入，保留原始诊断信息。',
      ] },
      { at: 22, expect: 'super({', lines: [
        '// 交由基类统一处理错误名称与消息。',
      ] },
      { at: 26, expect: 'this.approvalId = approvalId;', lines: [
        '// 保存标识字段，供上层读取具体是哪次审批失败。',
      ] },
      { at: 30, expect: 'static isInstance(', lines: [
        '// 基于标记做运行时类型收窄。',
      ] },
    ],
  },
  {
    name: 'error/no-such-tool-error.ts',
    want: [9, 9],
    blocks: [
      { at: 3, expect: "const name = 'AI_NoSuchToolError';", lines: [
        '// 错误名称与标记，用于跨实例识别的稳定标识。',
        '// Symbol.for 保证不同 SDK 副本共享同一个键。',
      ] },
      { at: 7, expect: 'export class NoSuchToolError extends AISDKError {', lines: [
        '// 模型请求了不存在的工具时抛出。',
        '// 保留可用工具列表，方便提示模型修正调用。',
      ] },
      { at: 10, expect: 'readonly toolName: string;', lines: [
        '// 模型试图调用的工具名。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 未显式传入消息时，按可用工具情况生成默认描述。',
      ] },
      { at: 16, expect: "message = `Model tried to call unavailable tool '${toolName}'. ${", lines: [
        '// 默认消息区分「无工具可用」与「列出了可用工具」两种场景。',
      ] },
      { at: 26, expect: 'super({ name, message });', lines: [
        '// 初始化基类后再保存工具信息。',
      ] },
      { at: 28, expect: 'this.toolName = toolName;', lines: [
        '// 记录工具名与可选列表，便于调用方做纠正。',
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
