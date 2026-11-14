// B65 insert: prompt/wrap-gateway-error.ts + error/invalid-tool-approval-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/wrap-gateway-error.ts',
    want: [6, 6],
    blocks: [
      { at: 4, expect: 'export function wrapGatewayError(error: unknown): unknown {', lines: [
        '// 包装网关鉴权错误，输出更易读的提示。',
        '// 非鉴权错误原样返回，避免误改其他异常。',
      ] },
      { at: 5, expect: 'if (!GatewayAuthenticationError.isInstance(error)) return error;', lines: [
        '// 只处理网关鉴权失败。',
      ] },
      { at: 7, expect: "const isProductionEnv = process?.env.NODE_ENV === 'production';", lines: [
        '// 生产环境隐藏细节，仅给出一条提示链接。',
      ] },
      { at: 10, expect: 'if (isProductionEnv) {', lines: [
        '// 非生产环境保留彩色详细指引。',
      ] },
      { at: 17, expect: 'return Object.assign(', lines: [
        '// 附加错误名称，便于上层判别来源。',
      ] },
    ],
  },
  {
    name: 'error/invalid-tool-approval-error.ts',
    want: [6, 6],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidToolApprovalError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 7, expect: 'export class InvalidToolApprovalError extends AISDKError {', lines: [
        '// 审批响应引用了不存在的审批 id 时抛出。',
        '// 说明消息历史中找不到对应的审批请求。',
      ] },
      { at: 10, expect: 'readonly approvalId: string;', lines: [
        '// 实际传入的审批 id。',
      ] },
      { at: 12, expect: 'constructor({ approvalId }: { approvalId: string }) {', lines: [
        '// 消息直接带上该 id，便于排查错配。',
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
