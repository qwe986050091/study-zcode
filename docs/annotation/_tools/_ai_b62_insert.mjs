// B62 insert: error/missing-tool-result-error.ts + model/as-transcription-model-v3.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/missing-tool-result-error.ts',
    want: [7, 7],
    blocks: [
      { at: 3, expect: "const name = 'AI_MissingToolResultsError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 7, expect: 'export class MissingToolResultsError extends AISDKError {', lines: [
        '// 工具调用缺少对应结果时抛出。',
        '// 常用于校验对话历史是否完整。',
      ] },
      { at: 10, expect: 'readonly toolCallIds: string[];', lines: [
        '// 缺失结果的工具调用 id 列表。',
      ] },
      { at: 12, expect: 'constructor({ toolCallIds }: { toolCallIds: string[] }) {', lines: [
        '// 按数量选择单复数措辞，拼装更自然的提示。',
      ] },
      { at: 13, expect: 'super({', lines: [
        '// 结果 id 以逗号连接后写入消息。',
      ] },
    ],
  },
  {
    name: 'model/as-transcription-model-v3.ts',
    want: [5, 5],
    blocks: [
      { at: 7, expect: 'export function asTranscriptionModelV3(', lines: [
        '// 把 v2 转写模型适配为 v3 契约。',
        '// 已是 v3 的模型直接返回，不产生额外开销。',
      ] },
      { at: 10, expect: "if (model.specificationVersion === 'v3') {", lines: [
        '// v3 模型无需包装。',
      ] },
      { at: 14, expect: 'logV2CompatibilityWarning({', lines: [
        '// 使用 v2 模型时提示兼容性风险。',
      ] },
      { at: 21, expect: 'return new Proxy(model, {', lines: [
        '// 用 Proxy 仅改写版本号，其余成员透传。',
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
